import pino from "pino";
import { query, withTx } from "../db/client";
import { insertAliHotHistory, upsertAliHotCurrent, type AliHotRow } from "../db/repos/aliHot.repo";
import { fetchAliHotProducts } from "../utils/aliexpressHotProducts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pickTopKeywordsPerCategory, TARGET_NAVER_CATEGORY_CIDS } from "../utils/shoppingKeywordSelection";
import { mapAliCategoryToInternal } from "../utils/aliexpressCategoryMapping";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

const execFileAsync = promisify(execFile);

const DEFAULT_PARAMS: Record<string, string | number> = {
  ship_to_country: process.env.ALIEXPRESS_HOT_SHIP_TO_COUNTRY ?? "KR",
  target_currency: process.env.ALIEXPRESS_HOT_TARGET_CURRENCY ?? "KRW",
  target_language: process.env.ALIEXPRESS_HOT_TARGET_LANGUAGE ?? "KO",
  platform_product_type: process.env.ALIEXPRESS_HOT_PLATFORM_PRODUCT_TYPE ?? "ALL",
  sort: process.env.ALIEXPRESS_HOT_SORT ?? "LAST_VOLUME_DESC",
  delivery_days: process.env.ALIEXPRESS_HOT_DELIVERY_DAYS ?? "3",
  page_size: Number(process.env.ALIEXPRESS_HOT_PAGE_SIZE ?? "50"),
  tracking_id: "default",
  fields:
    process.env.ALIEXPRESS_HOT_FIELDS ??
    "product_id,product_title,product_detail_url,product_main_image_url,original_price,sale_price,discount_rate,commission_rate,commission_amount,lastest_volume,evaluate_rate,shop_id,shop_name,category_id",
  ...(process.env.ALIEXPRESS_HOT_MIN_SALE_PRICE?.trim() ? { min_sale_price: process.env.ALIEXPRESS_HOT_MIN_SALE_PRICE.trim() } : {}),
};

async function resolveDynamicKeywords() {
  if (process.env.ALIEXPRESS_HOT_KEYWORDS?.trim()) {
    return process.env.ALIEXPRESS_HOT_KEYWORDS.trim();
  }

  const { rows } = await query<{ category_name: string; category_cid: string; keyword: string; rank: number }>(
    `with latest as (
       select max(collected_at) as collected_at
       from public.shopping_keyword_rank
       where category_cid = any($1::text[])
     )
     select category_name, category_cid, keyword, rank
     from public.shopping_keyword_rank
     where collected_at = (select collected_at from latest)
       and category_cid = any($1::text[])
     order by category_cid, rank asc`,
    [[...TARGET_NAVER_CATEGORY_CIDS]],
  );

  const picked = pickTopKeywordsPerCategory(rows, 3);
  const keywords = [...picked.values()].flatMap((items) => items.map((item) => item.keyword));
  return keywords.join(",");
}

const TOTAL_PAGES = Number(process.env.ALIEXPRESS_HOT_PAGES ?? "1");

async function loadCategoryIdMap() {
  const { rows } = await query<{ id: number; name: string }>(
    `select id, name from public.categories`,
  );
  return new Map(rows.map((row) => [row.name, row.id]));
}

async function run() {
  const keywords = await resolveDynamicKeywords();
  const categoryIdMap = await loadCategoryIdMap();
  logger.info({ job: "aliexpress-hot", pages: TOTAL_PAGES, keywords }, "job started");

  const snapshotAt = new Date().toISOString();
  let total = 0;

  for (let page = 1; page <= TOTAL_PAGES; page += 1) {
    const params = {
      ...DEFAULT_PARAMS,
      ...(keywords ? { keywords } : {}),
      page_no: page,
    };

    logger.info({ job: "aliexpress-hot", page, requestParams: params }, "request params");
    const products = await fetchAliHotProducts(params);
    total += products.length;

    const rows: AliHotRow[] = products.map((product) => {
      const raw = (product.raw ?? {}) as Record<string, unknown>;
      const firstLevelCategoryName = typeof raw.first_level_category_name === "string" ? raw.first_level_category_name : null;
      const secondLevelCategoryName = typeof raw.second_level_category_name === "string" ? raw.second_level_category_name : null;
      const mapped = mapAliCategoryToInternal({
        title: product.productTitle,
        firstLevelCategoryName,
        secondLevelCategoryName,
      });

      return {
        snapshotAt,
        productId: product.productId,
        productTitle: product.productTitle,
        productUrl: product.productUrl,
        affiliateUrl: null,
        imageUrl: product.imageUrl,
        price: product.price,
        salePrice: product.salePrice,
        discountRate: product.discountRate,
        commissionRate: product.commissionRate,
        commissionAmount: product.commissionAmount,
        ordersCount: product.ordersCount,
        rating: product.rating,
        sourceCategoryId:
          product.sourceCategoryId ??
          (typeof raw.second_level_category_id === "number" || typeof raw.second_level_category_id === "string"
            ? String(raw.second_level_category_id)
            : typeof raw.first_level_category_id === "number" || typeof raw.first_level_category_id === "string"
              ? String(raw.first_level_category_id)
              : null),
        mappedCategoryId: mapped.categoryName ? String(categoryIdMap.get(mapped.categoryName) ?? "") || null : null,
        mappingConfidence: mapped.confidence,
        shopId: product.shopId,
        shopName: product.shopName,
        rawPayload: product.raw,
      };
    });

    await withTx(async (client) => {
      await insertAliHotHistory(rows, client);
      await upsertAliHotCurrent(rows, client);
    });

    logger.info({ job: "aliexpress-hot", page, count: rows.length }, "page stored");
  }

  if (total > 0) {
    try {
      const { stdout, stderr } = await execFileAsync("npx", ["tsx", "scripts/backfillAliHotAffiliateUrls.ts"], {
        cwd: process.cwd(),
        env: process.env,
      });
      logger.info({ job: "aliexpress-hot", stdout, stderr }, "affiliate backfill executed after hot fetch");
    } catch (error) {
      logger.error({ job: "aliexpress-hot", error }, "affiliate backfill failed after hot fetch");
    }

    try {
      const { stdout, stderr } = await execFileAsync("npx", ["tsx", "scripts/syncAliHotToDeals.ts"], {
        cwd: process.cwd(),
        env: process.env,
      });
      logger.info({ job: "aliexpress-hot", stdout, stderr }, "deals sync executed after affiliate backfill");
    } catch (error) {
      logger.error({ job: "aliexpress-hot", error }, "deals sync failed after affiliate backfill");
    }
  }

  logger.info({ job: "aliexpress-hot", total }, "job finished");
  console.log("[DONE]", { total });
}

run().catch((error) => {
  logger.error({ job: "aliexpress-hot", error }, "job failed unexpectedly");
  console.log("[FATAL] aliexpress-hot job failed", error);
  process.exitCode = 1;
});
