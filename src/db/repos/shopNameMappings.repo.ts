// 역할: 쇼핑몰명 원문 → 정규화 매핑 조회 레포지토리.

import { query, type DbClient } from "../client";

// 역할: 원문 쇼핑몰명(raw_name)에 대한 정규화된 쇼핑몰명을 조회한다.
export async function findNormalizedShopName(
  source: string,
  rawName: string,
  client?: DbClient,
): Promise<string | null> {
  const result = await query<{ normalized_name: string }>(
    `select normalized_name
     from public.shop_name_mappings
     where source = $1 and raw_name = $2
     limit 1`,
    [source, rawName],
    client,
  );
  return result.rows[0]?.normalized_name ?? null;
}
