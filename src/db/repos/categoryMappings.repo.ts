import { query, type DbClient } from "../client";

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

export async function findMappedCategoryId(
  sourceCategoryId: number,
  client?: DbClient,
): Promise<number | null> {
  return findMappedCategoryIdBySourceCategoryId(sourceCategoryId, client);
}
