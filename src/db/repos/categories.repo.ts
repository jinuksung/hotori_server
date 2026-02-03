import { query, type DbClient } from "../client";

export type CategoryRow = { id: number; name: string };

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

export async function findByName(
  name: string,
  client?: DbClient,
): Promise<CategoryRow | null> {
  return getByName(name, client);
}
