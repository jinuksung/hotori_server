import "dotenv/config";
import { pool, query, withTx } from "../src/db/client";
import { createDeal, updateDeal } from "../src/db/repos/deals.repo";
import { findBySourcePost, upsertSource } from "../src/db/repos/dealSources.repo";
import { insertLink } from "../src/db/repos/links.repo";
import { evaluateAndUpsertPublishQueue } from "../src/jobs/publishHelpers";
import { buildDealGroupKey } from "../src/utils/dealGrouping";
import { extractDomain } from "../src/utils/url";
import type { ShippingType } from "../src/types";

type Row = {
  product_id: string;
  product_name: string;
  product_price: string | null;
  product_url: string;
  image_url: string | null;
  mapped_category_id: string | null;
  is_free_shipping: boolean;
};

const SOURCE = "coupang_goldbox";

function pickShippingType(isFreeShipping: boolean): ShippingType {
  return isFreeShipping ? "FREE" : "PAID";
}

async function main() {
  const { rows } = await query<Row>(
    `select product_id, product_name, product_price::text, product_url, image_url, mapped_category_id::text, is_free_shipping
     from public.coupang_goldbox_current
     where is_active = true
       and mapped_category_id is not null`,
  );

  let inserted = 0;
  let updated = 0;
  let blocked = 0;

  for (const row of rows) {
    await withTx(async (client) => {
      const existingSource = await findBySourcePost(SOURCE, row.product_id, client);
      const dealGroupKey = buildDealGroupKey({ title: row.product_name, representativeUrl: row.product_url });
      const price = row.product_price ? Number(row.product_price) : null;
      const categoryId = Number(row.mapped_category_id);
      let dealId = existingSource?.dealId ?? null;

      if (!dealId) {
        const created = await createDeal({
          categoryId,
          title: row.product_name,
          shopName: "쿠팡",
          subcategory: null,
          price,
          shippingType: pickShippingType(row.is_free_shipping),
          soldOut: false,
          thumbnailUrl: row.image_url,
          dealGroupKey,
        }, client);
        dealId = created.id;
        inserted += 1;
      } else {
        await updateDeal(dealId, {
          categoryId,
          title: row.product_name,
          shopName: "쿠팡",
          subcategory: null,
          price,
          shippingType: pickShippingType(row.is_free_shipping),
          soldOut: false,
          thumbnailUrl: row.image_url ?? existingSource.dealThumbnailUrl ?? null,
          dealGroupKey,
        }, client);
        updated += 1;
      }

      await upsertSource({
        dealId,
        source: SOURCE,
        sourcePostId: row.product_id,
        postUrl: row.product_url,
        sourceCategoryId: null,
        title: row.product_name,
        thumbUrl: row.image_url,
        shopNameRaw: "쿠팡",
      }, client);

      const domain = extractDomain(row.product_url);
      if (domain) {
        await insertLink({ dealId, url: row.product_url, domain, isAffiliate: true }, client);
      }

      const decision = await evaluateAndUpsertPublishQueue(dealId, client);
      if (decision.status === "blocked") blocked += 1;
    });
  }

  console.log(JSON.stringify({ scanned: rows.length, inserted, updated, blocked }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
