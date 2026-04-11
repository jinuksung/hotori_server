// 역할: AliExpress hot products 테이블 저장 레포지토리.

import { query, type DbClient } from "../client";

export type AliHotRow = {
  snapshotAt: string;
  productId: string;
  productTitle: string;
  productUrl: string | null;
  affiliateUrl: string | null;
  imageUrl: string | null;
  price: number | null;
  salePrice: number | null;
  discountRate: number | null;
  commissionRate: number | null;
  commissionAmount: number | null;
  ordersCount: number | null;
  rating: number | null;
  sourceCategoryId: string | null;
  mappedCategoryId: string | null;
  mappingConfidence: number | null;
  shopId: string | null;
  shopName: string | null;
  rawPayload: unknown;
};

// 역할: ali_hot_history에 스냅샷을 append-only로 기록한다.
export async function insertAliHotHistory(
  rows: AliHotRow[],
  client?: DbClient,
): Promise<void> {
  if (rows.length === 0) return;

  const values: unknown[] = [];
  const placeholders = rows
    .map((row, index) => {
      const base = index * 19;
      values.push(
        row.snapshotAt,
        row.productId,
        row.productTitle,
        row.productUrl,
        row.affiliateUrl,
        row.imageUrl,
        row.price,
        row.salePrice,
        row.discountRate,
        row.commissionRate,
        row.commissionAmount,
        row.ordersCount,
        row.rating,
        row.sourceCategoryId,
        row.mappedCategoryId,
        row.mappingConfidence,
        row.shopId,
        row.shopName,
        row.rawPayload,
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15}, $${base + 16}, $${base + 17}, $${base + 18}, $${base + 19})`;
    })
    .join(", ");

  await query(
    `insert into public.ali_hot_history
      (snapshot_at, product_id, product_title, product_url, affiliate_url, image_url,
       price, sale_price, discount_rate, commission_rate, commission_amount,
       orders_count, rating, source_category_id, mapped_category_id, mapping_confidence,
       shop_id, shop_name, raw_payload)
     values ${placeholders}
     on conflict (snapshot_at, product_id) do nothing`,
    values,
    client,
  );
}

// 역할: ali_hot_current 테이블에 최신 상태를 upsert한다.
export async function upsertAliHotCurrent(
  rows: AliHotRow[],
  client?: DbClient,
): Promise<void> {
  if (rows.length === 0) return;

  const values: unknown[] = [];
  const placeholders = rows
    .map((row, index) => {
      const base = index * 19;
      values.push(
        row.productId,
        row.productTitle,
        row.productUrl,
        row.affiliateUrl,
        row.imageUrl,
        row.price,
        row.salePrice,
        row.discountRate,
        row.commissionRate,
        row.commissionAmount,
        row.ordersCount,
        row.rating,
        row.sourceCategoryId,
        row.mappedCategoryId,
        row.mappingConfidence,
        row.shopId,
        row.shopName,
        row.snapshotAt,
        row.snapshotAt,
      );
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13}, $${base + 14}, $${base + 15}, $${base + 16}, $${base + 17}, $${base + 18}, $${base + 19})`;
    })
    .join(", ");

  await query(
    `insert into public.ali_hot_current
      (product_id, product_title, product_url, affiliate_url, image_url,
       price, sale_price, discount_rate, commission_rate, commission_amount,
       orders_count, rating, source_category_id, mapped_category_id, mapping_confidence,
       shop_id, shop_name, last_seen_at, last_collected_at)
     values ${placeholders}
     on conflict (product_id) do update
       set product_title = excluded.product_title,
           product_url = excluded.product_url,
           affiliate_url = coalesce(excluded.affiliate_url, ali_hot_current.affiliate_url),
           image_url = excluded.image_url,
           price = excluded.price,
           sale_price = excluded.sale_price,
           discount_rate = excluded.discount_rate,
           commission_rate = excluded.commission_rate,
           commission_amount = excluded.commission_amount,
           orders_count = excluded.orders_count,
           rating = excluded.rating,
           source_category_id = excluded.source_category_id,
           mapped_category_id = excluded.mapped_category_id,
           mapping_confidence = excluded.mapping_confidence,
           shop_id = excluded.shop_id,
           shop_name = excluded.shop_name,
           is_active = true,
           last_seen_at = excluded.last_seen_at,
           last_collected_at = excluded.last_collected_at,
           updated_at = now()`,
    values,
    client,
  );
}
