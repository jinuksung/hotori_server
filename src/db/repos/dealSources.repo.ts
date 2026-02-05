// 역할: deal_sources 테이블의 조회/업서트 레포지토리.

import { query, type DbClient } from "../client";

export type DealSourceInput = {
  dealId: number;
  source: string;
  sourcePostId: string;
  postUrl: string;
  sourceCategoryId: number | null;
  title: string;
  thumbUrl: string | null;
  shopNameRaw: string | null;
};

// 역할: 원본 게시글 정보를 source+source_post_id 기준으로 업서트한다.
export async function upsertSource(
  input: DealSourceInput,
  client?: DbClient,
): Promise<{ id: number; dealId: number }> {
  const result = await query<{ id: number; dealId: number }>(
    `insert into public.deal_sources
      (deal_id, source, source_post_id, post_url, source_category_id, title, thumb_url, shop_name_raw)
     values
      ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (source, source_post_id) do update
       set deal_id = excluded.deal_id,
           post_url = excluded.post_url,
           source_category_id = excluded.source_category_id,
           title = excluded.title,
           thumb_url = excluded.thumb_url,
           shop_name_raw = excluded.shop_name_raw
     returning id, deal_id as "dealId"`,
    [
      input.dealId,
      input.source,
      input.sourcePostId,
      input.postUrl,
      input.sourceCategoryId,
      input.title,
      input.thumbUrl,
      input.shopNameRaw,
    ],
    client,
  );

  const row = result.rows[0];
  return { id: row.id, dealId: row.dealId };
}

// 역할: source+source_post_id로 deal_sources 단건을 조회한다.
export async function findBySourcePost(
  source: string,
  sourcePostId: string,
  client?: DbClient,
): Promise<{
  id: number;
  dealId: number;
  postUrl: string;
  sourceThumbUrl: string | null;
  dealThumbnailUrl: string | null;
} | null> {
  const result = await query<{
    id: number;
    dealId: number;
    postUrl: string;
    sourceThumbUrl: string | null;
    dealThumbnailUrl: string | null;
  }>(
    `select ds.id,
            ds.deal_id as "dealId",
            ds.post_url as "postUrl",
            ds.thumb_url as "sourceThumbUrl",
            d.thumbnail_url as "dealThumbnailUrl"
     from public.deal_sources ds
     join public.deals d on d.id = ds.deal_id
     where ds.source = $1 and ds.source_post_id = $2`,
    [source, sourcePostId],
    client,
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, dealId: row.dealId, postUrl: row.postUrl };
}

// 역할: 최근 수집된 원본 게시글 목록을 최신순으로 조회한다.
export async function listRecentPosts(
  source: string,
  limit: number,
  client?: DbClient,
): Promise<Array<{ dealId: number; postUrl: string; sourcePostId: string }>> {
  const result = await query<{
    dealId: number;
    postUrl: string;
    sourcePostId: string;
  }>(
    `select deal_id as "dealId",
            post_url as "postUrl",
            source_post_id as "sourcePostId"
     from public.deal_sources
     where source = $1
     order by created_at desc
     limit $2`,
    [source, limit],
    client,
  );
  return result.rows.map((row) => ({
    dealId: row.dealId,
    postUrl: row.postUrl,
    sourcePostId: row.sourcePostId,
  }));
}
