// 역할: deal_metrics_history 히스토리 적재 레포지토리.

import { query, type DbClient } from "../client";

export type MetricsSnapshotInput = {
  dealId: number;
  source: string;
  views: number | null;
  votes: number | null;
  comments: number | null;
  capturedAt?: string;
};

// 역할: 메트릭 스냅샷을 시계열로 insert-only 저장한다.
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
