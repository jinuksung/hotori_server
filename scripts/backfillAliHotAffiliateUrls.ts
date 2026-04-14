import "dotenv/config";
import pino from "pino";
import { query } from "../src/db/client";
import { createAliExpressAffiliateLink, isAliExpressAffiliateUrl, isAliExpressUrl } from "../src/utils/aliexpressAffiliate";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
const BATCH_SIZE = Number(process.env.ALIEXPRESS_HOT_AFFILIATE_BATCH_SIZE ?? "50");

type Row = {
  productId: string;
  productUrl: string | null;
  affiliateUrl: string | null;
};

async function main() {
  const rows = await query<Row>(`
    select product_id as "productId", product_url as "productUrl", affiliate_url as "affiliateUrl"
    from public.ali_hot_current
    where affiliate_url is null
      and product_url is not null
    order by orders_count desc nulls last, updated_at desc
    limit $1
  `, [BATCH_SIZE]);

  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows.rows) {
    scanned += 1;
    const inputUrl = row.productUrl;
    if (!inputUrl || !isAliExpressUrl(inputUrl)) {
      skipped += 1;
      continue;
    }

    try {
      const affiliateUrl = isAliExpressAffiliateUrl(inputUrl)
        ? inputUrl
        : await createAliExpressAffiliateLink(inputUrl, `alihot-${row.productId}`);

      await query(
        `update public.ali_hot_current
         set affiliate_url = $2,
             updated_at = now()
         where product_id = $1`,
        [row.productId, affiliateUrl],
      );

      updated += 1;
    } catch (error) {
      failed += 1;
      logger.error({ job: "ali-hot-affiliate-backfill", productId: row.productId, error }, "failed to create affiliate url");
    }
  }

  console.log(`[알리 제휴링크 배치] 후보 ${scanned}건, 변환 ${updated}건, 실패 ${failed}건, 스킵 ${skipped}건`);
}

main().catch((error) => {
  logger.error({ job: "ali-hot-affiliate-backfill", error }, "job failed unexpectedly");
  process.exit(1);
});
