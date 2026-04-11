import pino from "pino";
import { withTx } from "../db/client";
import { insertAliHotHistory, upsertAliHotCurrent, type AliHotRow } from "../db/repos/aliHot.repo";
import { fetchAliHotProducts } from "../utils/aliexpressHotProducts";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

const DEFAULT_PARAMS: Record<string, string | number> = {
  ship_to_country: process.env.ALIEXPRESS_HOT_SHIP_TO_COUNTRY ?? "KR",
  target_currency: process.env.ALIEXPRESS_HOT_TARGET_CURRENCY ?? "USD",
  target_language: process.env.ALIEXPRESS_HOT_TARGET_LANGUAGE ?? "KO",
  platform_product_type: process.env.ALIEXPRESS_HOT_PLATFORM_PRODUCT_TYPE ?? "ALL",
  sort: process.env.ALIEXPRESS_HOT_SORT ?? "LAST_VOLUME_DESC",
  delivery_days: process.env.ALIEXPRESS_HOT_DELIVERY_DAYS ?? "7",
  page_size: Number(process.env.ALIEXPRESS_HOT_PAGE_SIZE ?? "50"),
  tracking_id: "default",
  fields:
    process.env.ALIEXPRESS_HOT_FIELDS ??
    "product_id,product_title,product_detail_url,product_main_image_url,original_price,sale_price,discount_rate,commission_rate,commission_amount,lastest_volume,evaluate_rate,shop_id,shop_name,category_id",
};

const TOTAL_PAGES = Number(process.env.ALIEXPRESS_HOT_PAGES ?? "1");

async function run() {
  logger.info({ job: "aliexpress-hot", pages: TOTAL_PAGES }, "job started");

  const snapshotAt = new Date().toISOString();
  let total = 0;

  for (let page = 1; page <= TOTAL_PAGES; page += 1) {
    const params = {
      ...DEFAULT_PARAMS,
      page_no: page,
    };

    const products = await fetchAliHotProducts(params);
    total += products.length;

    const rows: AliHotRow[] = products.map((product) => ({
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
      sourceCategoryId: product.sourceCategoryId,
      mappedCategoryId: null,
      mappingConfidence: null,
      shopId: product.shopId,
      shopName: product.shopName,
      rawPayload: product.raw,
    }));

    await withTx(async (client) => {
      await insertAliHotHistory(rows, client);
      await upsertAliHotCurrent(rows, client);
    });

    logger.info({ job: "aliexpress-hot", page, count: rows.length }, "page stored");
  }

  logger.info({ job: "aliexpress-hot", total }, "job finished");
  console.log("[DONE]", { total });
}

run().catch((error) => {
  logger.error({ job: "aliexpress-hot", error }, "job failed unexpectedly");
  console.log("[FATAL] aliexpress-hot job failed", error);
  process.exitCode = 1;
});
