import { query, type DbClient } from "../client";

export type RawDealInput = {
  source: string;
  sourcePostId: string;
  payload: unknown;
  crawledAt?: string;
};

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
