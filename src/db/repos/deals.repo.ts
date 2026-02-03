// 역할: deals 테이블의 생성/갱신/조회 레포지토리.

import { query, type DbClient } from "../client";

export type DealInput = {
  categoryId: number;
  title: string;
  shopName: string | null;
  subcategory: string | null;
  price: number | null;
  shippingType: string;
  soldOut: boolean;
  thumbnailUrl: string | null;
};

// 역할: 정규화된 딜을 생성한다.
export async function createDeal(
  input: DealInput,
  client?: DbClient
): Promise<{ id: number }> {
  const result = await query<{ id: number }>(
    `insert into public.deals
      (category_id, title, shop_name, subcategory, price, shipping_type, sold_out, thumbnail_url)
     values
      ($1, $2, $3, $4, $5, $6, $7, $8)
     returning id`,
    [
      input.categoryId,
      input.title,
      input.shopName,
      input.subcategory,
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

// 역할: 딜의 변경 가능한 필드를 부분 업데이트한다.
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
  if (patch.shopName !== undefined) {
    setClauses.push(`shop_name = $${idx++}`);
    values.push(patch.shopName);
  }
  if (patch.subcategory !== undefined) {
    setClauses.push(`subcategory = $${idx++}`);
    values.push(patch.subcategory);
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

// 역할: 특정 딜의 updated_at을 현재 시각으로 갱신한다.
export async function touchUpdatedAt(id: number, client?: DbClient): Promise<void> {
  await query(
    `update public.deals
     set updated_at = now()
     where id = $1`,
    [id],
    client
  );
}

export type DealSubcategoryRow = {
  id: number;
  categoryId: number;
  title: string;
  subcategory: string | null;
  sourceTitle: string | null;
  linkDomains: string[] | null;
};

// 역할: 서브카테고리 재계산을 위한 딜 목록을 순차 조회한다.
export async function listDealsForSubcategory(
  lastId: number,
  limit: number,
  client?: DbClient
): Promise<DealSubcategoryRow[]> {
  const result = await query<{
    id: number;
    category_id: number;
    title: string;
    subcategory: string | null;
    source_title: string | null;
    link_domains: string[] | null;
  }>(
    `select d.id,
            d.category_id,
            d.title,
            d.subcategory,
            ds.title as source_title,
            dl.domains as link_domains
     from public.deals d
     left join lateral (
       select title
       from public.deal_sources
       where deal_id = d.id
       order by created_at desc
       limit 1
     ) ds on true
     left join lateral (
       select array_agg(domain order by domain) as domains
       from public.deal_links
       where deal_id = d.id
     ) dl on true
     where d.id > $1
     order by d.id asc
     limit $2`,
    [lastId, limit],
    client
  );

  return result.rows.map((row) => ({
    id: row.id,
    categoryId: row.category_id,
    title: row.title,
    subcategory: row.subcategory,
    sourceTitle: row.source_title,
    linkDomains: row.link_domains,
  }));
}
