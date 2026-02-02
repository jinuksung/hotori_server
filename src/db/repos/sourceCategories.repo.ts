import { query, type DbClient } from "../client";

export type SourceCategoryInput = {
  source: string;
  sourceKey: string;
  name: string;
};

export async function upsertSourceCategory(
  input: SourceCategoryInput,
  client?: DbClient
): Promise<{ id: number }> {
  const result = await query<{ id: number }>(
    `insert into public.source_categories (source, source_key, name)
     values ($1, $2, $3)
     on conflict (source, source_key) do update
       set name = excluded.name
     returning id`,
    [input.source, input.sourceKey, input.name],
    client
  );
  return result.rows[0];
}

export async function findSourceCategoryId(
  source: string,
  sourceKey: string,
  client?: DbClient
): Promise<number | null> {
  const result = await query<{ id: number }>(
    `select id
     from public.source_categories
     where source = $1 and source_key = $2`,
    [source, sourceKey],
    client
  );
  return result.rows[0]?.id ?? null;
}
