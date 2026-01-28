import { query, type DbClient } from "../client";

export type DealSourceInput = {
  dealId: number;
  source: string;
  sourcePostId: string;
  postUrl: string;
  sourceCategoryId: number | null;
  title: string;
  thumbUrl: string | null;
};

export async function upsertSource(
  input: DealSourceInput,
  client?: DbClient
): Promise<{ id: number; dealId: number }> {
  const result = await query<{ id: number; dealid: number }>(
    `insert into public.deal_sources
      (deal_id, source, source_post_id, post_url, source_category_id, title, thumb_url)
     values
      ($1, $2, $3, $4, $5, $6, $7)
     on conflict (source, source_post_id) do update
       set deal_id = excluded.deal_id,
           post_url = excluded.post_url,
           source_category_id = excluded.source_category_id,
           title = excluded.title,
           thumb_url = excluded.thumb_url
     returning id, deal_id`,
    [
      input.dealId,
      input.source,
      input.sourcePostId,
      input.postUrl,
      input.sourceCategoryId,
      input.title,
      input.thumbUrl,
    ],
    client
  );
  const row = result.rows[0];
  return { id: row.id, dealId: row.dealid };
}

export async function findBySourcePost(
  source: string,
  sourcePostId: string,
  client?: DbClient
): Promise<{ id: number; dealId: number; postUrl: string } | null> {
  const result = await query<{ id: number; dealid: number; post_url: string }>(
    `select id, deal_id, post_url
     from public.deal_sources
     where source = $1 and source_post_id = $2`,
    [source, sourcePostId],
    client
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, dealId: row.dealid, postUrl: row.post_url };
}

export async function listRecentPosts(
  source: string,
  limit: number,
  client?: DbClient
): Promise<Array<{ dealId: number; postUrl: string; sourcePostId: string }>> {
  const result = await query<{
    dealid: number;
    post_url: string;
    source_post_id: string;
  }>(
    `select deal_id, post_url, source_post_id
     from public.deal_sources
     where source = $1
     order by created_at desc
     limit $2`,
    [source, limit],
    client
  );
  return result.rows.map((row) => ({
    dealId: row.dealid,
    postUrl: row.post_url,
    sourcePostId: row.source_post_id,
  }));
}
