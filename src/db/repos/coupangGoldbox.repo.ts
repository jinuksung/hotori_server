import { query, type DbClient } from "../client";

export type CoupangGoldboxRow = {
  fetchedDate: string;
  productId: string;
  productName: string;
  productPrice: number | null;
  productUrl: string;
  imageUrl: string | null;
  categoryName: string | null;
  mappedCategoryId: number | null;
  mappingConfidence: number | null;
  isRocket: boolean;
  isFreeShipping: boolean;
  rawPayload: unknown;
};

export async function insertCoupangGoldboxHistory(rows: CoupangGoldboxRow[], client?: DbClient): Promise<void> {
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const placeholders = rows.map((row, index) => {
    const base = index * 10;
    values.push(
      row.fetchedDate,
      row.productId,
      row.productName,
      row.productPrice,
      row.productUrl,
      row.imageUrl,
      row.categoryName,
      row.mappedCategoryId,
      row.mappingConfidence,
      row.isRocket,
      row.isFreeShipping,
      row.rawPayload,
    );
    const offset = index * 12;
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12})`;
  }).join(", ");

  await query(
    `insert into public.coupang_goldbox_history
      (fetched_date, product_id, product_name, product_price, product_url, image_url,
       category_name, mapped_category_id, mapping_confidence, is_rocket, is_free_shipping, raw_payload)
     values ${placeholders}
     on conflict (fetched_date, product_id) do nothing`,
    values,
    client,
  );
}

export async function upsertCoupangGoldboxCurrent(rows: CoupangGoldboxRow[], client?: DbClient): Promise<void> {
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const placeholders = rows.map((row, index) => {
    const offset = index * 12;
    values.push(
      row.productId,
      row.productName,
      row.productPrice,
      row.productUrl,
      row.imageUrl,
      row.categoryName,
      row.mappedCategoryId,
      row.mappingConfidence,
      row.isRocket,
      row.isFreeShipping,
      row.rawPayload,
      row.fetchedDate,
    );
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10}, $${offset + 11}, $${offset + 12})`;
  }).join(", ");

  await query(
    `insert into public.coupang_goldbox_current
      (product_id, product_name, product_price, product_url, image_url,
       category_name, mapped_category_id, mapping_confidence, is_rocket, is_free_shipping,
       raw_payload, last_collected_at)
     values ${placeholders}
     on conflict (product_id) do update
       set product_name = excluded.product_name,
           product_price = excluded.product_price,
           product_url = excluded.product_url,
           image_url = excluded.image_url,
           category_name = excluded.category_name,
           mapped_category_id = excluded.mapped_category_id,
           mapping_confidence = excluded.mapping_confidence,
           is_rocket = excluded.is_rocket,
           is_free_shipping = excluded.is_free_shipping,
           raw_payload = excluded.raw_payload,
           is_active = true,
           last_seen_at = now(),
           last_collected_at = excluded.last_collected_at,
           updated_at = now()`,
    values,
    client,
  );
}
