import { query, type DbClient } from "../client";

export type CategoryRow = { id: number; name: string };

export async function getOrCreateByName(
  name: string,
  client?: DbClient
): Promise<CategoryRow> {
  const result = await query<CategoryRow>(
    `insert into public.categories (name)
     values ($1)
     on conflict (name) do update set name = excluded.name
     returning id, name`,
    [name],
    client
  );
  return result.rows[0];
}

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
