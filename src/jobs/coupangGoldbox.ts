import pino from "pino";
import { withTx, query } from "../db/client";
import { fetchCoupangGoldbox } from "../utils/coupangGoldboxApi";
import { mapCoupangGoldboxCategoryToInternal } from "../utils/coupangGoldboxCategoryMapping";
import { insertCoupangGoldboxHistory, upsertCoupangGoldboxCurrent, type CoupangGoldboxRow } from "../db/repos/coupangGoldbox.repo";
import { cacheThumbnail } from "../utils/thumbnailCache";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
const execFileAsync = promisify(execFile);

async function loadCategoryIdMap() {
  const { rows } = await query<{ id: number; name: string }>(`select id, name from public.categories`);
  return new Map(rows.map((row) => [row.name, row.id]));
}

async function run() {
  const categoryIdMap = await loadCategoryIdMap();
  const fetchedDate = new Date().toISOString().slice(0, 10);
  const products = await fetchCoupangGoldbox();

  const rows: CoupangGoldboxRow[] = [];
  for (const product of products) {
    const mapped = mapCoupangGoldboxCategoryToInternal(product.categoryName);
    const cachedThumbnail = product.productImage
      ? await cacheThumbnail({
          source: "coupang_goldbox",
          sourcePostId: product.productId,
          sourceUrl: product.productImage,
        })
      : null;

    rows.push({
      fetchedDate,
      productId: product.productId,
      productName: product.productName,
      productPrice: product.productPrice,
      productUrl: product.productUrl,
      imageUrl: cachedThumbnail?.ok ? cachedThumbnail.publicUrl : product.productImage,
      categoryName: product.categoryName,
      mappedCategoryId: categoryIdMap.get(mapped.categoryName) ?? null,
      mappingConfidence: mapped.confidence,
      isRocket: product.isRocket,
      isFreeShipping: product.isFreeShipping,
      rawPayload: product,
    });
  }

  await withTx(async (client) => {
    await insertCoupangGoldboxHistory(rows, client);
    await upsertCoupangGoldboxCurrent(rows, client);
  });

  const { stdout, stderr } = await execFileAsync("npx", ["tsx", "scripts/syncCoupangGoldboxToDeals.ts"], {
    cwd: process.cwd(),
    env: process.env,
  });

  logger.info({ job: "coupang-goldbox", fetched: rows.length, stdout, stderr }, "job finished");
  console.log(JSON.stringify({ fetched: rows.length, sync: stdout.trim() }, null, 2));
}

run().catch((error) => {
  logger.error({ job: "coupang-goldbox", error }, "job failed unexpectedly");
  process.exitCode = 1;
});
