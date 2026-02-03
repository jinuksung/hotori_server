// 역할: deal_links 테이블의 링크 저장/조회 레포지토리.

import { query, type DbClient } from "../client";

export type DealLinkInput = {
  dealId: number;
  url: string;
  domain: string;
  isAffiliate: boolean;
};

// 역할: 구매 링크를 추가한다(중복은 무시).
export async function insertLink(
  input: DealLinkInput,
  client?: DbClient
): Promise<void> {
  await query(
    `insert into public.deal_links (deal_id, url, domain, is_affiliate)
     values ($1, $2, $3, $4)
     on conflict (deal_id, url) do nothing`,
    [input.dealId, input.url, input.domain, input.isAffiliate],
    client
  );
}

// 역할: 제휴 링크가 없는 원본 링크 목록을 조회한다.
export async function listNonAffiliateLinksMissingAffiliatePair(
  limit: number,
  client?: DbClient
): Promise<Array<{ dealId: number; url: string }>> {
  const result = await query<{ dealid: number; url: string }>(
    `select dl.deal_id, dl.url
     from public.deal_links dl
     where dl.is_affiliate = false
       and not exists (
         select 1
         from public.deal_links dl2
         where dl2.deal_id = dl.deal_id
           and dl2.is_affiliate = true
       )
     order by dl.id asc
     limit $1`,
    [limit],
    client
  );
  return result.rows.map((row) => ({ dealId: row.dealid, url: row.url }));
}

// 역할: 특정 딜에 제휴 링크가 존재하는지 확인한다.
export async function hasAffiliateLink(
  dealId: number,
  client?: DbClient
): Promise<boolean> {
  const result = await query<{ exists: boolean }>(
    `select exists (
       select 1
       from public.deal_links
       where deal_id = $1 and is_affiliate = true
     ) as exists`,
    [dealId],
    client
  );
  return result.rows[0]?.exists ?? false;
}
