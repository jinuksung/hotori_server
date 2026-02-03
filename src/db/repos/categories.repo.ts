// 역할: categories 테이블 조회 전용 레포지토리.

import { query, type DbClient } from "../client";

export type CategoryRow = { id: number; name: string };

// 역할: 카테고리명을 기준으로 단일 카테고리를 조회한다.
export async function getByName(
  name: string,
  client?: DbClient
): Promise<CategoryRow | null> {
  const result = await query<CategoryRow>(
    `select id, name
     from public.categories
     where name = $1`,
    [name],
    client
  );
  return result.rows[0] ?? null;
}

// 역할: categories 테이블의 총 행 수를 조회한다.
export async function countCategories(
  client?: DbClient
): Promise<number> {
  const result = await query<{ count: string }>(
    `select count(*)::text as count
     from public.categories`,
    [],
    client
  );
  const raw = result.rows[0]?.count ?? "0";
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

// 역할: getByName의 별칭(호환성 유지용).
export async function findByName(
  name: string,
  client?: DbClient,
): Promise<CategoryRow | null> {
  return getByName(name, client);
}
