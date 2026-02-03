// 역할: raw_deals 테이블에 원본 수집 데이터를 누적 저장한다.

import { query, type DbClient } from "../client";

export type RawDealInput = {
  source: string;
  sourcePostId: string;
  payload: unknown;
  crawledAt?: string;
};

// 역할: raw_deals에 append-only로 raw payload를 기록한다.
export async function appendRaw(
  input: RawDealInput,
  client?: DbClient
): Promise<void> {
  if (input.crawledAt) {
    await query(
      `insert into public.raw_deals
        (source, source_post_id, payload, crawled_at)
       values ($1, $2, $3, $4)`,
      [input.source, input.sourcePostId, input.payload, input.crawledAt],
      client
    );
    return;
  }

  await query(
    `insert into public.raw_deals
      (source, source_post_id, payload)
     values ($1, $2, $3)`,
    [input.source, input.sourcePostId, input.payload],
    client
  );
}
