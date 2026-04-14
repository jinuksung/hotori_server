import "dotenv/config";
import crypto from "node:crypto";
import { query } from "../src/db/client";

type DealRow = {
  id: number;
  categoryId: number;
  title: string;
};

type SearchProduct = {
  productId: number;
  productName: string;
  categoryName?: string;
  productUrl?: string;
  rank?: number;
};

type SearchResponse = {
  rCode: string;
  rMessage?: string;
  data?: { productData?: SearchProduct[] };
};

const CATEGORY_IDS = [1, 5];
const LIMIT = Number(process.env.PRODUCT_MASTER_BACKFILL_LIMIT ?? "10");
const REQUEST_DELAY_MS = Number(process.env.PRODUCT_MASTER_REQUEST_DELAY_MS ?? "1500");

function buildAuthorization(path: string, queryString: string) {
  const accessKey = process.env.COUPANG_ACCESS_KEY?.trim();
  const secretKey = process.env.COUPANG_SECRET_KEY?.trim();
  if (!accessKey || !secretKey) throw new Error("Missing Coupang keys");
  const now = new Date();
  const yy = String(now.getUTCFullYear()).slice(2);
  const MM = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const HH = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  const signedDate = `${yy}${MM}${dd}T${HH}${mm}${ss}Z`;
  const message = `${signedDate}GET${path}${queryString}`;
  const signature = crypto.createHmac("sha256", secretKey).update(message).digest("hex");
  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${signedDate}, signature=${signature}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9가-힣]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokenOverlapScore(a: string, b: string): number {
  const aTokens = new Set(normalizeTitle(a).split(" ").filter(Boolean));
  const bTokens = new Set(normalizeTitle(b).split(" ").filter(Boolean));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of aTokens) if (bTokens.has(token)) overlap += 1;
  return overlap / Math.max(aTokens.size, bTokens.size);
}

function buildSearchKeyword(title: string): string {
  const cleaned = title
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[,+]/g, " ")
    .replace(/\b(무료배송|무배|특가|핫딜|국내정발|해외직구|관부가세포함)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, 50);
}

async function search(keyword: string): Promise<SearchProduct[]> {
  const path = "/v2/providers/affiliate_open_api/apis/openapi/v1/products/search";
  const params = new URLSearchParams({ keyword, limit: "3" });
  const queryString = params.toString();
  const response = await fetch(`https://api-gateway.coupang.com${path}?${queryString}`, {
    headers: {
      authorization: buildAuthorization(path, queryString),
      accept: "application/json",
    },
  });
  const payload = (await response.json()) as SearchResponse;
  if (!response.ok || payload.rCode !== "0") {
    throw new Error(`coupang search failed: http=${response.status} body=${JSON.stringify(payload)}`);
  }
  return payload.data?.productData ?? [];
}

async function main() {
  const deals = await query<DealRow>(
    `select d.id, d.category_id as "categoryId", d.title
     from public.deals d
     left join public.deal_product_mapping m on m.deal_id = d.id
     where d.category_id = any($1::bigint[])
       and m.deal_id is null
     order by d.updated_at desc
     limit $2`,
    [CATEGORY_IDS, LIMIT],
  );

  let matched = 0;
  let skipped = 0;
  let failed = 0;

  for (const deal of deals.rows) {
    const keyword = buildSearchKeyword(deal.title);
    if (!keyword) {
      skipped += 1;
      continue;
    }

    let results: SearchProduct[] = [];
    try {
      results = await search(keyword);
    } catch (error) {
      failed += 1;
      console.error({ dealId: deal.id, title: deal.title, keyword, error });
      if (String(error).includes('rCode":"403')) {
        break;
      }
      continue;
    }
    const best = results
      .map((item) => ({ item, score: tokenOverlapScore(deal.title, item.productName) }))
      .sort((a, b) => b.score - a.score)[0];

    if (!best || best.score < 0.45) {
      skipped += 1;
      continue;
    }

    const productGroupKey = `coupang:${best.item.productId}`;
    const upserted = await query<{ id: number }>(
      `insert into public.product_master
        (category_id, normalized_product_name, product_group_key, canonical_title, canonical_source, canonical_product_url, confidence, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, now())
       on conflict (product_group_key) do update
         set canonical_title = excluded.canonical_title,
             canonical_source = excluded.canonical_source,
             canonical_product_url = excluded.canonical_product_url,
             confidence = excluded.confidence,
             updated_at = now()
       returning id`,
      [deal.categoryId, best.item.productName, productGroupKey, best.item.productName, "coupang_search", best.item.productUrl ?? null, best.score],
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
      [deal.id, upserted.rows[0].id, "coupang_search", best.score],
    );

    matched += 1;
    await sleep(REQUEST_DELAY_MS);
  }

  console.log(JSON.stringify({ scanned: deals.rows.length, matched, skipped, failed, requestDelayMs: REQUEST_DELAY_MS }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
