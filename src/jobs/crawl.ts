// src/jobs/crawl.ts
import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import pino from "pino";

import { fetchFmkoreaHotdealListHtml } from "../crawlers/fmkorea/list";
import { fetchFmkoreaDetailHtmls } from "../crawlers/fmkorea/detail";

import {
  parseFmHotdealList,
  type FmkoreaListItem,
} from "../parsers/fmkorea/parseList";
import {
  parseFmHotdealDetail,
  type FmHotdealDetail,
} from "../parsers/fmkorea/parseDetail";

import { withTx } from "../db/client";
import { appendRaw } from "../db/repos/rawDeals.repo";
import { createDeal, updateDeal } from "../db/repos/deals.repo";
import { upsertSource, findBySourcePost } from "../db/repos/dealSources.repo";
import { insertLink } from "../db/repos/links.repo";
import { insertSnapshot } from "../db/repos/metrics.repo";
import { findByName, getOrCreateByName } from "../db/repos/categories.repo";
import { upsertSourceCategory } from "../db/repos/sourceCategories.repo";
import { findMappedCategoryIdBySourceCategoryId } from "../db/repos/categoryMappings.repo";

import { extractDomain, normalizeUrl } from "../utils/url";
import {
  detectSoldOut,
  mapShippingType,
  parsePrice,
  selectPurchaseLink,
  stripShopPrefix,
} from "./pipelineHelpers";
import { inferSubcategory } from "../parsers/common/inferSubcategory";
import { inferCategory } from "../parsers/common/inferCategory";

console.log("[BOOT] crawl.ts loaded", new Date().toISOString());

const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";
const logger = pino({ level: LOG_LEVEL });

const SOURCE = "fmkorea" as const;
const DEFAULT_CATEGORY_NAME =
  process.env.DEFAULT_CATEGORY_NAME?.trim() || "UNCATEGORIZED";

// 덤프 디렉토리 (실행 위치 기준으로 항상 생성)
const DUMP_DIR =
  process.env.FMKOREA_DETAIL_DUMP_DIR?.trim() ||
  path.join(process.cwd(), "tmp", "fmkorea-detail-dumps");

// 상세 크롤링 옵션
const DETAIL_TIMEOUT_MS = Number(
  process.env.FMKOREA_DETAIL_TIMEOUT_MS ?? "45000",
);
const DETAIL_HEADLESS =
  (process.env.FMKOREA_DETAIL_HEADLESS ?? "true") === "true";

// 상세 실패 시 모바일 폴백
const ENABLE_MOBILE_FALLBACK =
  (process.env.FMKOREA_ENABLE_MOBILE_FALLBACK ?? "true") === "true";

type CrawlStats = {
  listItems: number;
  detailFetched: number;
  detailFailures: number;
  processed: number;
  skipped: number;
  parserFailures: number;
  persistFailures: number;
  dumpedFailures: number;
};

async function ensureDumpDir() {
  await fs.mkdir(DUMP_DIR, { recursive: true });
}

function toMobileUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hostname = "m.fmkorea.com";
    return u.toString();
  } catch {
    return url.replace("https://www.fmkorea.com", "https://m.fmkorea.com");
  }
}

function safeFilename(s: string) {
  return s.replace(/[^\w.-]+/g, "_").slice(0, 180);
}

async function dumpFailure(args: {
  sourcePostId: string;
  postUrl: string;
  error: string;
  html?: string;
}) {
  await ensureDumpDir();
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${ts}_${args.sourcePostId}_${safeFilename(args.postUrl)}`;

  const metaPath = path.join(DUMP_DIR, `${base}.json`);
  const htmlPath = path.join(DUMP_DIR, `${base}.html`);

  const meta = {
    capturedAt: new Date().toISOString(),
    sourcePostId: args.sourcePostId,
    postUrl: args.postUrl,
    error: args.error,
    dumpDir: DUMP_DIR,
  };

  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf-8");
  if (args.html) {
    await fs.writeFile(htmlPath, args.html, "utf-8");
  }

  logger.warn(
    {
      job: "crawl",
      stage: "dump",
      metaPath,
      htmlPath: args.html ? htmlPath : null,
    },
    "saved failure dump",
  );
  console.log("[DUMP]", metaPath, args.html ? htmlPath : "");
}

async function main() {
  logger.info({ job: "crawl" }, "crawl job started");
  console.log("[INFO] crawl job started");

  // 1) LIST
  console.log("[INFO] fetching list html...");
  const listHtmlResult = await fetchFmkoreaHotdealListHtml();

  if (!listHtmlResult.ok) {
    logger.error(
      { job: "crawl", stage: "list", error: listHtmlResult.error },
      "failed to fetch fmkorea list",
    );
    console.log("[ERROR] failed to fetch list", listHtmlResult.error);
    process.exitCode = 1;
    return;
  }

  console.log("[INFO] parsing list html...");
  const parsedList = parseFmHotdealList(listHtmlResult.data);

  if (!parsedList.ok) {
    logger.error(
      { job: "crawl", stage: "list", error: parsedList.error },
      "failed to parse fmkorea list",
    );
    console.log("[ERROR] failed to parse list", parsedList.error);
    process.exitCode = 1;
    return;
  }

  if (parsedList.data.items.length === 0) {
    logger.info({ job: "crawl", stage: "list" }, "no hotdeal items found");
    console.log("[INFO] no hotdeal items found");
    return;
  }

  logger.info(
    { job: "crawl", stage: "list", itemCount: parsedList.data.items.length },
    "parsed fmkorea list",
  );
  console.log("[INFO] list items:", parsedList.data.items.length);
  const categoryMissing = parsedList.data.items.filter(
    (item) => !item.sourceCategoryKey || !item.sourceCategoryName,
  );
  logger.debug(
    {
      job: "crawl",
      stage: "list-category",
      missingCount: categoryMissing.length,
      sampleMissing: categoryMissing.slice(0, 5).map((item) => ({
        sourcePostId: item.sourcePostId,
        postUrl: item.postUrl,
      })),
      samplePresent: parsedList.data.items.slice(0, 5).map((item) => ({
        sourcePostId: item.sourcePostId,
        sourceCategoryKey: item.sourceCategoryKey,
        sourceCategoryName: item.sourceCategoryName,
      })),
    },
    "parsed category info from list",
  );

  const categoryId = await ensureDefaultCategory();
  const categoryNameCache = new Map<string, number>();
  const itemsBySourcePostId = new Map(
    parsedList.data.items.map((item) => [item.sourcePostId, item]),
  );

  // 2) DETAIL CRAWL
  const detailTargets = parsedList.data.items.map((item) => ({
    sourcePostId: item.sourcePostId,
    postUrl: item.postUrl,
  }));

  const detailResults: Array<{
    sourcePostId: string;
    html: string;
    postUrl: string;
  }> = [];
  let detailFailures = 0;
  let dumpedFailures = 0;

  logger.info(
    {
      job: "crawl",
      stage: "detail-crawl",
      targetCount: detailTargets.length,
      timeoutMs: DETAIL_TIMEOUT_MS,
      headless: DETAIL_HEADLESS,
      dumpDir: DUMP_DIR,
      mobileFallback: ENABLE_MOBILE_FALLBACK,
    },
    "starting detail crawl",
  );

  console.log(
    "[INFO] starting detail crawl",
    JSON.stringify(
      {
        targetCount: detailTargets.length,
        timeoutMs: DETAIL_TIMEOUT_MS,
        headless: DETAIL_HEADLESS,
        dumpDir: DUMP_DIR,
        mobileFallback: ENABLE_MOBILE_FALLBACK,
      },
      null,
      2,
    ),
  );

  for (const target of detailTargets) {
    console.log(`\n[DETAIL] ${target.sourcePostId} -> ${target.postUrl}`);

    // 1차: 원본 URL
    const result1 = await fetchFmkoreaDetailHtmls([target], {
      headless: DETAIL_HEADLESS,
      timeoutMs: DETAIL_TIMEOUT_MS,
      waitUntil: "domcontentloaded",
    });

    if (result1.successes.length > 0) {
      const s = result1.successes[0];
      detailResults.push({
        sourcePostId: s.sourcePostId,
        html: s.html,
        postUrl: s.postUrl,
      });
      console.log(`[OK] detail success: ${s.sourcePostId}`);
      continue;
    }

    // 2차: 모바일 폴백
    if (ENABLE_MOBILE_FALLBACK) {
      const mobileTarget = { ...target, postUrl: toMobileUrl(target.postUrl) };
      console.log(`[RETRY] mobile url -> ${mobileTarget.postUrl}`);

      const result2 = await fetchFmkoreaDetailHtmls([mobileTarget], {
        headless: DETAIL_HEADLESS,
        timeoutMs: DETAIL_TIMEOUT_MS,
        waitUntil: "domcontentloaded",
        mobileBaseUrl: "https://m.fmkorea.com",
      });

      if (result2.successes.length > 0) {
        const s = result2.successes[0];
        detailResults.push({
          sourcePostId: s.sourcePostId,
          html: s.html,
          postUrl: s.postUrl,
        });
        console.log(`[OK] detail success (mobile): ${s.sourcePostId}`);
        continue;
      }

      detailFailures += 1;
      const failure = result2.failures[0] ?? result1.failures[0];
      const errorMsg = failure?.error ?? "unknown";

      console.log(`[FAIL] detail failed: ${target.sourcePostId}`, errorMsg);

      try {
        await dumpFailure({
          sourcePostId: target.sourcePostId,
          postUrl: mobileTarget.postUrl,
          error: errorMsg,
        });
        dumpedFailures += 1;
      } catch (e) {
        console.log("[ERROR] dump failed", e);
      }
      continue;
    }

    // fallback off
    detailFailures += 1;
    const failure = result1.failures[0];
    const errorMsg = failure?.error ?? "unknown";
    console.log(`[FAIL] detail failed: ${target.sourcePostId}`, errorMsg);

    try {
      await dumpFailure({
        sourcePostId: target.sourcePostId,
        postUrl: target.postUrl,
        error: errorMsg,
      });
      dumpedFailures += 1;
    } catch (e) {
      console.log("[ERROR] dump failed", e);
    }
  }

  const stats: CrawlStats = {
    listItems: parsedList.data.items.length,
    detailFetched: detailResults.length,
    detailFailures,
    processed: 0,
    skipped: 0,
    parserFailures: 0,
    persistFailures: 0,
    dumpedFailures,
  };

  // 3) PARSE + PERSIST
  console.log(
    "\n[INFO] starting persist pipeline. detailFetched:",
    detailResults.length,
  );

  for (const detail of detailResults) {
    const listItem = itemsBySourcePostId.get(detail.sourcePostId);
    if (!listItem) {
      stats.skipped += 1;
      console.log("[SKIP] list item missing", detail.sourcePostId);
      continue;
    }

    let parsedDetail: FmHotdealDetail;
    try {
      parsedDetail = parseFmHotdealDetail(detail.html);
    } catch (error) {
      stats.parserFailures += 1;
      console.log("[ERROR] parse detail failed", detail.sourcePostId, error);

      try {
        await dumpFailure({
          sourcePostId: detail.sourcePostId,
          postUrl: detail.postUrl,
          error: `parse failed: ${error instanceof Error ? error.message : String(error)}`,
          html: detail.html,
        });
        stats.dumpedFailures += 1;
      } catch (e) {
        console.log("[ERROR] dump failed", e);
      }
      continue;
    }

    try {
      await persistDeal(listItem, parsedDetail, categoryId, categoryNameCache);
      stats.processed += 1;
      console.log("[OK] persisted", detail.sourcePostId, parsedDetail.title);
    } catch (error) {
      stats.persistFailures += 1;
      console.log("[ERROR] persist failed", detail.sourcePostId, error);
    }
  }

  logger.info({ job: "crawl", ...stats }, "crawl job finished");
  console.log("[DONE]", stats);
}

async function ensureDefaultCategory(): Promise<number> {
  const category = await getOrCreateByName(DEFAULT_CATEGORY_NAME);
  return category.id;
}

async function persistDeal(
  listItem: FmkoreaListItem,
  detail: FmHotdealDetail,
  defaultCategoryId: number,
  categoryNameCache: Map<string, number>,
): Promise<void> {
  const normalizedPrice = parsePrice(
    detail.price ?? listItem.priceText ?? null,
  );
  const shippingType = mapShippingType(
    detail.shipping ?? listItem.shippingText ?? null,
  );
  const soldOut = detectSoldOut(detail.title, listItem.title);
  const thumbnailUrl = detail.ogImage ?? listItem.thumbUrl ?? null;
  const shopName = detail.mall ?? listItem.shopText ?? null;
  const rawTitle = (detail.title ?? listItem.title).trim();
  const dealTitle = stripShopPrefix(rawTitle);
  const purchaseUrl = selectPurchaseLink(detail);
  const normalizedPurchaseUrl = purchaseUrl
    ? (normalizeUrl(purchaseUrl) ?? purchaseUrl)
    : null;
  const purchaseDomain = normalizedPurchaseUrl
    ? extractDomain(normalizedPurchaseUrl)
    : null;

  await withTx(async (client) => {
    let sourceCategoryId: number | null = null;
    let mappedCategoryId: number | null = null;
    let inferredCategoryName: string | null = null;
    let inferredCategoryId: number | null = null;
    let resolvedCategoryId: number | null = null;

    if (listItem.sourceCategoryKey && listItem.sourceCategoryName) {
      const sourceCategory = await upsertSourceCategory(
        {
          source: SOURCE,
          sourceKey: listItem.sourceCategoryKey,
          name: listItem.sourceCategoryName,
        },
        client
      );
      sourceCategoryId = sourceCategory.id;
      mappedCategoryId = await findMappedCategoryIdBySourceCategoryId(
        sourceCategoryId,
        client,
      );
      if (mappedCategoryId) {
        resolvedCategoryId = mappedCategoryId;
      }
    } else {
      logger.info(
        {
          job: "crawl",
          stage: "category",
          sourcePostId: listItem.sourcePostId,
          sourceCategoryKey: listItem.sourceCategoryKey,
          sourceCategoryName: listItem.sourceCategoryName,
        },
        "source category missing from list item",
      );
    }

    if (!resolvedCategoryId) {
      const inferred = inferCategory({
        title: dealTitle,
        bodyText: detail.summaryText ?? null,
        linkDomains: purchaseDomain ? [purchaseDomain] : null,
      });
      if (inferred) {
        inferredCategoryName = inferred.categoryName;
        inferredCategoryId = await resolveCategoryIdByName(
          inferred.categoryName,
          categoryNameCache,
          client,
        );
        if (inferredCategoryId) {
          resolvedCategoryId = inferredCategoryId;
        }
      }
    }

    if (!resolvedCategoryId) {
      resolvedCategoryId = defaultCategoryId;
    }

    const subcategory = inferSubcategory(
      resolvedCategoryId,
      dealTitle,
      detail.summaryText,
      purchaseDomain ? [purchaseDomain] : null
    );

    const existingSource = await findBySourcePost(
      SOURCE,
      listItem.sourcePostId,
      client,
    );
    let dealId = existingSource?.dealId ?? null;

    if (!dealId) {
      const created = await createDeal(
        {
          categoryId: resolvedCategoryId,
          title: dealTitle,
          shopName,
          subcategory,
          price: normalizedPrice,
          shippingType,
          soldOut,
          thumbnailUrl,
        },
        client,
      );
      dealId = created.id;
    } else {
      await updateDeal(
        dealId,
        {
          categoryId: resolvedCategoryId,
          title: dealTitle,
          shopName,
          subcategory,
          price: normalizedPrice,
          shippingType,
          soldOut,
          thumbnailUrl,
        },
        client,
      );
    }

    await upsertSource(
      {
        dealId,
        source: SOURCE,
        sourcePostId: listItem.sourcePostId,
        postUrl: listItem.postUrl,
        sourceCategoryId,
        title: listItem.title,
        thumbUrl: listItem.thumbUrl ?? thumbnailUrl,
      },
      client,
    );

    logger.info(
      {
        job: "crawl",
        stage: "category",
        sourcePostId: listItem.sourcePostId,
        sourceCategoryId,
        mappedCategoryId,
        inferredCategoryName,
        inferredCategoryId,
        finalCategoryId: resolvedCategoryId,
      },
      "resolved category for deal",
    );

    await appendRaw(
      {
        source: SOURCE,
        sourcePostId: listItem.sourcePostId,
        payload: {
          list: listItem,
          detail,
          capturedAt: new Date().toISOString(),
        },
      },
      client,
    );

    logger.info(
      {
        job: "crawl",
        stage: "metrics",
        dealId,
        sourcePostId: listItem.sourcePostId,
        views: detail.viewCount ?? null,
        votes: detail.upvoteCount ?? null,
        comments: detail.commentCount ?? null,
      },
      "insertSnapshot"
    );

    await insertSnapshot(
      {
        dealId,
        source: SOURCE,
        views: detail.viewCount ?? null,
        votes: detail.upvoteCount ?? null,
        comments: detail.commentCount ?? null,
      },
      client,
    );

    if (purchaseUrl) {
      if (normalizedPurchaseUrl && purchaseDomain) {
        await insertLink(
          {
            dealId,
            url: normalizedPurchaseUrl,
            domain: purchaseDomain,
            isAffiliate: false,
          },
          client,
        );
      }
    }
  });
}

async function resolveCategoryIdByName(
  name: string,
  cache: Map<string, number>,
  client: Parameters<typeof findByName>[1],
): Promise<number | null> {
  const normalized = name.trim();
  if (!normalized) return null;
  const cached = cache.get(normalized);
  if (cached) return cached;
  const row = await findByName(normalized, client);
  if (!row) return null;
  cache.set(normalized, row.id);
  return row.id;
}

main().catch((error) => {
  logger.error({ job: "crawl", error }, "crawl job failed unexpectedly");
  console.log("[FATAL] crawl job failed", error);
  process.exitCode = 1;
});
