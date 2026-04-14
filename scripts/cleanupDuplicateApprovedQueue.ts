import "dotenv/config";

import { pool, query } from "../src/db/client";

type DupRow = {
  queueId: number;
  dealId: number;
  dealGroupKey: string;
  rn: number;
};

async function main() {
  const result = await query<DupRow>(
    `with ranked as (
       select q.id as "queueId",
              q.deal_id as "dealId",
              d.deal_group_key as "dealGroupKey",
              row_number() over (
                partition by d.deal_group_key
                order by q.created_at asc, q.id asc
              ) as rn
       from public.deal_publish_queue q
       join public.deals d on d.id = q.deal_id
       where q.status in ('approved', 'ready')
         and q.sent_at is null
         and d.deal_group_key is not null
     )
     select *
     from ranked
     where rn > 1`,
  );

  let blocked = 0;
  for (const row of result.rows) {
    await query(
      `update public.deal_publish_queue
       set status = 'blocked',
           reason = $2,
           updated_at = now()
       where id = $1`,
      [row.queueId, `duplicate_pending_group:${row.dealId}:${row.dealGroupKey}`],
    );
    blocked += 1;
  }

  console.log(JSON.stringify({ scanned: result.rows.length, blocked }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
