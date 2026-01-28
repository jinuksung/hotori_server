import { query, type DbClient } from "../client";

export type DealInput = {
  categoryId: number;
  title: string;
  price: number | null;
  shippingType: string;
  soldOut: boolean;
  thumbnailUrl: string | null;
};

export async function createDeal(
  input: DealInput,
  client?: DbClient
): Promise<{ id: number }> {
  const result = await query<{ id: number }>(
    `insert into public.deals
      (category_id, title, price, shipping_type, sold_out, thumbnail_url)
     values
      ($1, $2, $3, $4, $5, $6)
     returning id`,
    [
      input.categoryId,
      input.title,
      input.price,
      input.shippingType,
      input.soldOut,
      input.thumbnailUrl,
    ],
    client
  );
  return result.rows[0];
}

export type DealPatch = Partial<DealInput>;

export async function updateDeal(
  id: number,
  patch: DealPatch,
  client?: DbClient
): Promise<void> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (patch.categoryId !== undefined) {
    setClauses.push(`category_id = $${idx++}`);
    values.push(patch.categoryId);
  }
  if (patch.title !== undefined) {
    setClauses.push(`title = $${idx++}`);
    values.push(patch.title);
  }
  if (patch.price !== undefined) {
    setClauses.push(`price = $${idx++}`);
    values.push(patch.price);
  }
  if (patch.shippingType !== undefined) {
    setClauses.push(`shipping_type = $${idx++}`);
    values.push(patch.shippingType);
  }
  if (patch.soldOut !== undefined) {
    setClauses.push(`sold_out = $${idx++}`);
    values.push(patch.soldOut);
  }
  if (patch.thumbnailUrl !== undefined) {
    setClauses.push(`thumbnail_url = $${idx++}`);
    values.push(patch.thumbnailUrl);
  }

  if (setClauses.length === 0) {
    return;
  }

  setClauses.push("updated_at = now()");
  values.push(id);

  await query(
    `update public.deals
     set ${setClauses.join(", ")}
     where id = $${idx}`,
    values,
    client
  );
}

export async function touchUpdatedAt(id: number, client?: DbClient): Promise<void> {
  await query(
    `update public.deals
     set updated_at = now()
     where id = $1`,
    [id],
    client
  );
}
