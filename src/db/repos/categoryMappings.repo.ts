// 역할: source_categories ↔ categories 매핑 조회 레포지토리.

import { query, type DbClient } from "../client";

// 역할: source_category_id로 매핑된 category_id를 조회한다.
export async function findMappedCategoryIdBySourceCategoryId(
  sourceCategoryId: number,
  client?: DbClient,
): Promise<number | null> {
  const result = await query<{ category_id: number }>(
    `select category_id
     from public.category_mappings
     where source_category_id = $1
     limit 1`,
    [sourceCategoryId],
    client,
  );
  return result.rows[0]?.category_id ?? null;
}

// 역할: findMappedCategoryIdBySourceCategoryId의 별칭.
export async function findMappedCategoryId(
  sourceCategoryId: number,
  client?: DbClient,
): Promise<number | null> {
  return findMappedCategoryIdBySourceCategoryId(sourceCategoryId, client);
}
