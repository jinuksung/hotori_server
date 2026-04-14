import "dotenv/config";
import { query } from "../src/db/client";
import { evaluateAndUpsertPublishQueue } from "../src/jobs/publishHelpers";

const LOOKBACK_MINUTES = Number(process.env.TREND_APPROVE_LOOKBACK_MINUTES ?? "90");
const MIN_AGE_MINUTES = Number(process.env.TREND_APPROVE_MIN_AGE_MINUTES ?? "20");
const MAX_APPROVALS = Number(process.env.TREND_APPROVE_MAX_PER_RUN ?? "1");
const MIN_SCORE = Number(process.env.TREND_APPROVE_MIN_SCORE ?? "3");
const MIN_SNAPSHOTS = Number(process.env.TREND_APPROVE_MIN_SNAPSHOTS ?? "3");

type CandidateRow = {
  dealId: number;
  score: number;
  viewDelta: number;
  commentDelta: number;
  voteDelta: number;
};

async function main() {
  const candidates = await query<CandidateRow>(
    `with recent_metrics as (
       select ds.deal_id,
              mh.views,
              mh.votes,
              mh.comments,
              mh.created_at,
              row_number() over (partition by ds.deal_id order by mh.created_at desc) as rn
       from public.deal_metrics_history mh
       join public.deal_sources ds
         on ds.deal_id = mh.deal_id
        and ds.source = mh.source
       where ds.source in ('ppomppu', 'fmkorea', 'hotdealzip_fmkorea', 'ruliweb')
         and mh.created_at >= now() - make_interval(mins => $1::int)
     ),
     pivoted as (
       select deal_id,
              max(case when rn = 1 then coalesce(views, 0) end) as latest_views,
              max(case when rn = 2 then coalesce(views, 0) end) as prev_views,
              max(case when rn = 1 then coalesce(comments, 0) end) as latest_comments,
              max(case when rn = 2 then coalesce(comments, 0) end) as prev_comments,
              max(case when rn = 1 then coalesce(votes, 0) end) as latest_votes,
              max(case when rn = 2 then coalesce(votes, 0) end) as prev_votes,
              count(*) as snapshots
       from recent_metrics
       group by deal_id
     )
     select q.deal_id as "dealId",
            greatest(coalesce(p.latest_views, 0) - coalesce(p.prev_views, 0), 0) as "viewDelta",
            greatest(coalesce(p.latest_comments, 0) - coalesce(p.prev_comments, 0), 0) as "commentDelta",
            greatest(coalesce(p.latest_votes, 0) - coalesce(p.prev_votes, 0), 0) as "voteDelta",
            (
              greatest(coalesce(p.latest_comments, 0) - coalesce(p.prev_comments, 0), 0) * 5
              + greatest(coalesce(p.latest_votes, 0) - coalesce(p.prev_votes, 0), 0) * 4
              + ln(greatest(coalesce(p.latest_views, 0) - coalesce(p.prev_views, 0), 0) + 1)
            ) as score
     from public.deal_publish_queue q
     join public.deals d on d.id = q.deal_id
     join public.categories c on c.id = d.category_id
     join pivoted p on p.deal_id = q.deal_id
     where q.channel = 'telegram_hotdeal'
       and q.status = 'ready'
       and q.sent_at is null
       and c.name in ('HOME', 'DIGITAL', 'ELECTRONICS', 'FASHION')
       and d.created_at >= now() - make_interval(mins => $1::int)
       and d.created_at <= now() - make_interval(mins => $2::int)
       and p.snapshots >= $4
     order by score desc, q.created_at asc
     limit $3`,
    [LOOKBACK_MINUTES, MIN_AGE_MINUTES, MAX_APPROVALS, MIN_SNAPSHOTS],
  );

  const approved: CandidateRow[] = [];
  const skipped: Array<{ dealId: number; score: number; reason: string }> = [];

  for (const candidate of candidates.rows) {
    if (candidate.score < MIN_SCORE) {
      skipped.push({ dealId: candidate.dealId, score: candidate.score, reason: "score_below_threshold" });
      continue;
    }

    const decision = await evaluateAndUpsertPublishQueue(candidate.dealId);
    if (decision.status !== "ready") {
      skipped.push({ dealId: candidate.dealId, score: candidate.score, reason: decision.reason ?? decision.status });
      continue;
    }

    await query(
      `update public.deal_publish_queue
       set status = 'approved',
           score = $2,
           reason = 'auto_trending_recent_nonfood',
           payload_json = coalesce(payload_json, '{}'::jsonb)
             || jsonb_build_object(
                  'trendScore', $2,
                  'viewDelta', $3,
                  'commentDelta', $4,
                  'voteDelta', $5,
                  'approvedBy', 'approveTrendingRecentNonFood'
                ),
           updated_at = now()
       where deal_id = $1
         and channel = 'telegram_hotdeal'
         and status = 'ready'`,
      [candidate.dealId, candidate.score, candidate.viewDelta, candidate.commentDelta, candidate.voteDelta],
    );

    approved.push(candidate);
  }

  console.log(JSON.stringify({
    approved: approved.length,
    approvedDeals: approved,
    skipped,
    config: {
      lookbackMinutes: LOOKBACK_MINUTES,
      minAgeMinutes: MIN_AGE_MINUTES,
      maxApprovals: MAX_APPROVALS,
      minScore: MIN_SCORE,
      minSnapshots: MIN_SNAPSHOTS,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
