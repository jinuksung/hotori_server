import "dotenv/config";

import { pool, query, withTx } from "../src/db/client";
import { updateDeal } from "../src/db/repos/deals.repo";
import { evaluateAndUpsertPublishQueue } from "../src/jobs/publishHelpers";

type Row = {
  dealId: number;
  productId: string;
  title: string;
};

function buildAliDealGroupKey(productId: string): string {
  return `url:aliexpress:itemId=${productId}`;
}

async function main() {
  const result = await query<Row>(
    `select d.id as "dealId",
            ds.source_post_id as "productId",
            d.title
     from public.deals d
     join public.deal_sources ds
       on ds.deal_id = d.id
      and ds.source = 'aliexpress_hot'
     where ds.source_post_id is not null`,
  );

  let updated = 0;
  let requeued = 0;

  for (const row of result.rows) {
    const nextKey = buildAliDealGroupKey(row.productId);

    await withTx(async (client) => {
      await updateDeal(
        row.dealId,
        {
          shopName: "알리익스프레스",
          dealGroupKey: nextKey,
        },
        client,
      );

      const decision = await evaluateAndUpsertPublishQueue(row.dealId, client);
      updated += 1;
      if (decision.reason?.startsWith("duplicate_recent_sent:")) {
        requeued += 1;
      }
    });
  }

  console.log(JSON.stringify({ scanned: result.rows.length, updated, duplicateBlockedAfterRecheck: requeued }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
