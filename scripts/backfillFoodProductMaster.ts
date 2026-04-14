import "dotenv/config";
import { query } from "../src/db/client";

type FoodDealRow = {
  id: number;
  categoryId: number;
  title: string;
};

const LIMIT = Number(process.env.FOOD_PRODUCT_MASTER_LIMIT ?? "200");

const BRAND_HINTS = [
  "리챔", "스팸", "삼다수", "농심", "오뚜기", "팔도", "비비고", "햇반", "동원", "청정원", "백설", "CJ", "GNC", "하림", "매일", "남양", "빙그레", "롯데웰푸드", "오리온", "크라운", "해태", "풀무원", "대상", "코카콜라", "펩시", "칠성", "동서", "맥심", "스타벅스"
];

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").replace(/\s+/g, " ").trim();
}

function extractBrand(title: string): string | null {
  for (const hint of BRAND_HINTS) {
    if (title.includes(hint)) return hint;
  }
  const match = title.match(/^([A-Za-z][A-Za-z0-9]+|[가-힣A-Za-z0-9]+)\s/);
  return match?.[1] ?? null;
}

function extractSpec(title: string): string | null {
  const specs = Array.from(title.matchAll(/(\d+(?:\.\d+)?)\s*(kg|g|ml|l|L)/g)).map((m) => `${m[1]}${m[2].toLowerCase()}`);
  if (specs.length === 0) return null;
  return Array.from(new Set(specs)).join("+");
}

function removeBrandAndSpec(title: string, brand: string | null, spec: string | null): string {
  let value = title;
  if (brand) value = value.replace(brand, " ");
  if (spec) {
    for (const token of spec.split("+")) {
      value = value.replace(token, " ");
    }
  }
  return normalizeText(value)
    .replace(/\b(1개|2개|3개|4개|5개|6개|10개|12개|24개|묶음|세트|특가|핫딜|무료배송|무배)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  const deals = await query<FoodDealRow>(
    `select d.id, d.category_id as "categoryId", d.title
     from public.deals d
     join public.categories c on c.id = d.category_id
     left join public.deal_product_mapping m on m.deal_id = d.id
     where c.name = 'FOOD'
       and m.deal_id is null
     order by d.updated_at desc
     limit $1`,
    [LIMIT],
  );

  let matched = 0;
  let skipped = 0;

  for (const deal of deals.rows) {
    const brand = extractBrand(deal.title);
    const spec = extractSpec(deal.title);
    const productName = removeBrandAndSpec(deal.title, brand, spec);

    if (!productName || !spec) {
      skipped += 1;
      continue;
    }

    const productGroupKey = `food:${normalizeText([brand ?? "", productName, spec].filter(Boolean).join("|"))}`;
    const upserted = await query<{ id: number }>(
      `insert into public.product_master
        (category_id, normalized_brand, normalized_product_name, normalized_spec, product_group_key, canonical_title, canonical_source, confidence, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now())
       on conflict (product_group_key) do update
         set canonical_title = excluded.canonical_title,
             confidence = greatest(public.product_master.confidence, excluded.confidence),
             updated_at = now()
       returning id`,
      [deal.categoryId, brand, productName, spec, productGroupKey, deal.title, "food_title_rule", 0.8],
    );

    await query(
      `insert into public.deal_product_mapping
        (deal_id, product_master_id, match_method, match_confidence, matched_at, updated_at)
       values ($1, $2, $3, $4, now(), now())
       on conflict (deal_id) do update
         set product_master_id = excluded.product_master_id,
             match_method = excluded.match_method,
             match_confidence = excluded.match_confidence,
             matched_at = now(),
             updated_at = now()`,
      [deal.id, upserted.rows[0].id, "food_title_rule", 0.8],
    );

    matched += 1;
  }

  console.log(JSON.stringify({ scanned: deals.rows.length, matched, skipped }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
