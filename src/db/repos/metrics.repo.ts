import { query, type DbClient } from "../client";

export type MetricsSnapshotInput = {
  dealId: number;
  source: string;
  views: number | null;
  votes: number | null;
  comments: number | null;
  capturedAt?: string;
};

export async function insertSnapshot(
  input: MetricsSnapshotInput,
  client?: DbClient
): Promise<void> {
  if (input.capturedAt) {
    await query(
      `insert into public.deal_metrics_history
        (deal_id, source, views, votes, comments, captured_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        input.dealId,
        input.source,
        input.views,
        input.votes,
        input.comments,
        input.capturedAt,
      ],
      client
    );
    return;
  }

  await query(
    `insert into public.deal_metrics_history
      (deal_id, source, views, votes, comments)
     values ($1, $2, $3, $4, $5)`,
    [input.dealId, input.source, input.views, input.votes, input.comments],
    client
  );
}
