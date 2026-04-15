import "dotenv/config";
import { query } from "../src/db/client";
import { evaluateAndUpsertPublishQueue } from "../src/jobs/publishHelpers";

async function main() {
  const picked = await query<{ dealId: number }>(`
    select q.deal_id as "dealId"
    from public.deal_publish_queue q
    join public.deals d on d.id = q.deal_id
    join public.categories c on c.id = d.category_id
    where q.channel = 'telegram_hotdeal'
      and q.status = 'ready'
      and q.sent_at is null
      and d.created_at >= now() - interval '12 hours'
      and c.name in ('HOME', 'DIGITAL', 'ELECTRONICS', 'FOOD')
    order by random()
    limit 1
  `);

  const dealId = picked.rows[0]?.dealId;
  if (!dealId) {
    console.log(JSON.stringify({ approved: false, reason: 'no_recent_ready_candidate' }, null, 2));
    return;
  }

  const decision = await evaluateAndUpsertPublishQueue(dealId);
  if (decision.status !== 'ready') {
    console.log(JSON.stringify({ approved: false, dealId, decision }, null, 2));
    return;
  }

  await query(
    `update public.deal_publish_queue
     set status = 'approved',
         reason = 'auto_random_recent_nonfood',
         updated_at = now()
     where deal_id = $1
       and channel = 'telegram_hotdeal'`,
    [dealId],
  );

  console.log(JSON.stringify({ approved: true, dealId }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
