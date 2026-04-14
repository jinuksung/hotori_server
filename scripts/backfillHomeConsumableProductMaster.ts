import "dotenv/config";
import { query } from "../src/db/client";

type DealRow = {
  id: number;
  categoryId: number;
  title: string;
};

const LIMIT = Number(process.env.HOME_PRODUCT_MASTER_LIMIT ?? "200");
const CONSUMABLE_KEYWORDS = [
  "휴지", "롤화장지", "키친타올", "물티슈", "세제", "섬유유연제", "샴푸", "린스", "치약", "칫솔", "핸드워시", "바디워시", "가글", "세정제", "수세미", "기저귀", "생리대", "마스크", "주방세제"
];
const BRAND_HINTS = [
  "크리넥스", "깨끗한나라", "코멧", "유한킴벌리", "피죤", "테크", "퍼실", "다우니", "엘라스틴", "려", "미쟝센", "메디안", "2080", "페리오", "리스테린", "랩신", "아이깨끗해", "하기스", "좋은느낌", "쏘피", "케라시스", "닥터브로너스"
];

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").replace(/\s+/g, " ").trim();
}

function isConsumable(title: string): boolean {
  return CONSUMABLE_KEYWORDS.some((keyword) => title.includes(keyword));
}

function extractBrand(title: string): string | null {
  for (const hint of BRAND_HINTS) {
    if (title.includes(hint)) return hint;
  }
  const match = title.match(/^([A-Za-z][A-Za-z0-9]+|[가-힣A-Za-z0-9]+)\s/);
  return match?.[1] ?? null;
}

function extractSpec(title: string): string | null {
  const specs = Array.from(title.matchAll(/(\d+(?:\.\d+)?)\s*(kg|g|ml|l|L|m|매|롤|p|겹)/g)).map((m) => `${m[1]}${m[2].toLowerCase()}`);
  if (specs.length === 0) return null;
  return Array.from(new Set(specs)).join("+");
}

function removeBrandAndSpec(title: string, brand: string | null, spec: string | null): string {
  let value = title;
  if (brand) value = value.replace(brand, " ");
  if (spec) {
    for (const token of spec.split("+")) value = value.replace(token, " ");
  }
  return normalizeText(value)
    .replace(/\b(1개|2개|3개|4개|5개|6개|10개|12개|24개|특가|핫딜|무료배송|무배|세트|대용량)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  const deals = await query<DealRow>(
    `select d.id, d.category_id as "categoryId", d.title
     from public.deals d
     join public.categories c on c.id = d.category_id
     left join public.deal_product_mapping m on m.deal_id = d.id
     where c.name = 'HOME'
       and m.deal_id is null
     order by d.updated_at desc
     limit $1`,
    [LIMIT],
  );

  let matched = 0;
  let skipped = 0;

  for (const deal of deals.rows) {
    if (!isConsumable(deal.title)) {
      skipped += 1;
      continue;
    }

    const brand = extractBrand(deal.title);
    const spec = extractSpec(deal.title);
    const productName = removeBrandAndSpec(deal.title, brand, spec);
    if (!productName || !spec) {
      skipped += 1;
      continue;
    }

    const productGroupKey = `home:${normalizeText([brand ?? "", productName, spec].filter(Boolean).join("|"))}`;
    const upserted = await query<{ id: number }>(
      `insert into public.product_master
        (category_id, normalized_brand, normalized_product_name, normalized_spec, product_group_key, canonical_title, canonical_source, confidence, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, now())
       on conflict (product_group_key) do update
         set canonical_title = excluded.canonical_title,
             confidence = greatest(public.product_master.confidence, excluded.confidence),
             updated_at = now()
       returning id`,
      [deal.categoryId, brand, productName, spec, productGroupKey, deal.title, "home_title_rule", 0.75],
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
      [deal.id, upserted.rows[0].id, "home_title_rule", 0.75],
    );

    matched += 1;
  }

  console.log(JSON.stringify({ scanned: deals.rows.length, matched, skipped }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
