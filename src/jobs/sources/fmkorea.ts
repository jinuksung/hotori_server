// 역할: FM코리아 크롤링 파이프라인의 실질 로직을 제공한다.
// src/jobs/sources/fmkorea.ts
import "dotenv/config";
import pino from "pino";

import { fetchFmkoreaHotdealListHtml } from "../../crawlers/fmkorea/list";
import { fetchFmkoreaDetailHtmls } from "../../crawlers/fmkorea/detail";

import {
  parseFmHotdealList,
  type FmkoreaListItem,
} from "../../parsers/fmkorea/parseList";
import {
  parseFmHotdealDetail,
  type FmHotdealDetail,
} from "../../parsers/fmkorea/parseDetail";

import { withTx } from "../../db/client";
import { appendRaw } from "../../db/repos/rawDeals.repo";
import { createDeal, updateDeal } from "../../db/repos/deals.repo";
import { upsertSource, findBySourcePost } from "../../db/repos/dealSources.repo";
import { insertLink } from "../../db/repos/links.repo";
import { insertSnapshot } from "../../db/repos/metrics.repo";
import { countCategories } from "../../db/repos/categories.repo";
import { upsertSourceCategory } from "../../db/repos/sourceCategories.repo";
import { findMappedCategoryId } from "../../db/repos/categoryMappings.repo";
import { findNormalizedShopName } from "../../db/repos/shopNameMappings.repo";

import { extractDomain, normalizeUrl } from "../../utils/url";
import {
  detectSoldOut,
  mapShippingType,
  normalizeDealTitle,
  parsePrice,
  selectPurchaseLink,
} from "../pipelineHelpers";
import { inferSubcategory } from "../../parsers/common/inferSubcategory";

console.log("[BOOT] crawl fmkorea loaded", new Date().toISOString());

const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";
const logger = pino({ level: LOG_LEVEL });

const SOURCE = "fmkorea" as const;

// 상세 크롤링 옵션
const DETAIL_TIMEOUT_MS = Number(
  process.env.FMKOREA_DETAIL_TIMEOUT_MS ?? "45000",
);
const DETAIL_HEADLESS =
  (process.env.FMKOREA_DETAIL_HEADLESS ?? "true") === "true";

// 상세 실패 시 모바일 폴백
const ENABLE_MOBILE_FALLBACK =
  (process.env.FMKOREA_ENABLE_MOBILE_FALLBACK ?? "true") === "true";

export type CrawlStats = {
  listItems: number;
  detailFetched: number;
  detailFailures: number;
  processed: number;
  skipped: number;
  parserFailures: number;
  persistFailures: number;
  dumpedFailures: number;
  sourceCategoryUpserts: number;
  sourceCategoryMissing: number;
  categoryMappingHits: number;
  categoryMappingMisses: number;
};

type CategoryMappingMissSample = {
  source: string;
  sourceCategoryKey: string;
  sourceCategoryName: string;
  exampleDealId: number;
  exampleSourcePostId: string;
  examplePostUrl: string;
};

// 역할: 빈 실행 결과용 통계 객체를 생성한다.
function createEmptyStats(listItems: number): CrawlStats {
  return {
    listItems,
    detailFetched: 0,
    detailFailures: 0,
    processed: 0,
    skipped: 0,
    parserFailures: 0,
    persistFailures: 0,
    dumpedFailures: 0,
    sourceCategoryUpserts: 0,
    sourceCategoryMissing: 0,
    categoryMappingHits: 0,
    categoryMappingMisses: 0,
  };
}

// 역할: PC URL을 모바일 URL로 변환한다.
function toMobileUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hostname = "m.fmkorea.com";
    return u.toString();
  } catch {
    return url.replace("https://www.fmkorea.com", "https://m.fmkorea.com");
  }
}


// 역할: FM코리아 크롤링 전체 플로우를 실행하고 통계를 반환한다.
export async function crawlFmkorea(): Promise<CrawlStats> {
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
    throw new Error(
      `failed to fetch fmkorea list: ${listHtmlResult.error.message}`,
    );
  }

  console.log("[INFO] parsing list html...");
  const parsedList = parseFmHotdealList(listHtmlResult.data);

  if (!parsedList.ok) {
    logger.error(
      { job: "crawl", stage: "list", error: parsedList.error },
      "failed to parse fmkorea list",
    );
    console.log("[ERROR] failed to parse list", parsedList.error);
    throw new Error(
      `failed to parse fmkorea list: ${parsedList.error.message}`,
    );
  }

  if (parsedList.data.items.length === 0) {
    logger.info({ job: "crawl", stage: "list" }, "no hotdeal items found");
    console.log("[INFO] no hotdeal items found");
    return createEmptyStats(0);
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

  const defaultCategoryId = requireDefaultCategoryId();
  const categoryMappingMissSamples = new Map<
    string,
    CategoryMappingMissSample
  >();
  const categoryCountBefore = await withTx((client) =>
    countCategories(client),
  );
  logger.info(
    {
      job: "crawl",
      stage: "categories",
      categoryCount: categoryCountBefore,
      defaultCategoryId,
    },
    "category count before crawl",
  );
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

  logger.info(
    {
      job: "crawl",
      stage: "detail-crawl",
      targetCount: detailTargets.length,
      timeoutMs: DETAIL_TIMEOUT_MS,
      headless: DETAIL_HEADLESS,
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
      continue;
    }

    // fallback off
    detailFailures += 1;
    const failure = result1.failures[0];
    const errorMsg = failure?.error ?? "unknown";
    console.log(`[FAIL] detail failed: ${target.sourcePostId}`, errorMsg);
  }

  const stats: CrawlStats = {
    listItems: parsedList.data.items.length,
    detailFetched: detailResults.length,
    detailFailures,
    processed: 0,
    skipped: 0,
    parserFailures: 0,
    persistFailures: 0,
    dumpedFailures: 0,
    sourceCategoryUpserts: 0,
    sourceCategoryMissing: 0,
    categoryMappingHits: 0,
    categoryMappingMisses: 0,
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
      continue;
    }

    try {
      await persistDeal(
        listItem,
        parsedDetail,
        defaultCategoryId,
        stats,
        categoryMappingMissSamples,
      );
      stats.processed += 1;
      console.log("[OK] persisted", detail.sourcePostId, parsedDetail.title);
    } catch (error) {
      stats.persistFailures += 1;
      console.log("[ERROR] persist failed", detail.sourcePostId, error);
    }
  }

  const categoryCountAfter = await withTx((client) =>
    countCategories(client),
  );
  logger.info(
    {
      job: "crawl",
      stage: "categories",
      categoryCountBefore,
      categoryCountAfter,
      categoryCountDelta: categoryCountAfter - categoryCountBefore,
    },
    "category count after crawl",
  );

  logger.info(
    {
      job: "crawl",
      stage: "category-mapping",
      sourceCategoryUpserts: stats.sourceCategoryUpserts,
      sourceCategoryMissing: stats.sourceCategoryMissing,
      categoryMappingHits: stats.categoryMappingHits,
      categoryMappingMisses: stats.categoryMappingMisses,
      defaultCategoryId,
    },
    "category mapping summary",
  );

  const missingMappingList = Array.from(categoryMappingMissSamples.values());
  if (missingMappingList.length > 0) {
    logger.warn(
      {
        job: "crawl",
        stage: "category-mapping-miss",
        missingCount: missingMappingList.length,
        missing: missingMappingList,
      },
      "category mapping missing (needs manual mapping)",
    );
  }

  logger.info({ job: "crawl", ...stats }, "crawl job finished");
  console.log("[DONE]", stats);
  return stats;
}

// 역할: 파싱 결과를 DB에 저장하고 관련 메트릭/링크를 적재한다.
async function persistDeal(
  listItem: FmkoreaListItem,
  detail: FmHotdealDetail,
  defaultCategoryId: number,
  stats: CrawlStats,
  categoryMappingMissSamples: Map<string, CategoryMappingMissSample>,
): Promise<void> {
  const normalizedPrice = parsePrice(
    detail.price ?? listItem.priceText ?? null,
  );
  const shippingType = mapShippingType(
    detail.shipping ?? listItem.shippingText ?? null,
    detail.title ?? listItem.title ?? null,
    normalizedPrice,
  );
  const soldOut = detectSoldOut(detail.title, listItem.title);
  const thumbnailUrl = detail.ogImage ?? listItem.thumbUrl ?? null;
  const rawShopName = detail.mall ?? listItem.shopText ?? null;
  const rawTitle = (detail.title ?? listItem.title).trim();
  const dealTitle = normalizeDealTitle(rawTitle);
  const purchaseUrl = selectPurchaseLink(detail);
  const normalizedPurchaseUrl = purchaseUrl
    ? (normalizeUrl(purchaseUrl) ?? purchaseUrl)
    : null;
  const purchaseDomain = normalizedPurchaseUrl
    ? extractDomain(normalizedPurchaseUrl)
    : null;
  const sourceCategoryKey =
    listItem.sourceCategoryKey ?? detail.sourceCategoryKey ?? null;
  const sourceCategoryName =
    listItem.sourceCategoryName ?? detail.sourceCategoryName ?? null;

  await withTx(async (client) => {
    let sourceCategoryId: number | null = null;
    let mappedCategoryId: number | null = null;
    let resolvedCategoryId: number | null = null;
    let mappingMissKey: string | null = null;
    let normalizedShopName: string | null = null;

    if (sourceCategoryKey && sourceCategoryName) {
      stats.sourceCategoryUpserts += 1;
      const sourceCategory = await upsertSourceCategory(
        {
          source: SOURCE,
          sourceKey: sourceCategoryKey,
          name: sourceCategoryName,
        },
        client
      );
      sourceCategoryId = sourceCategory.id;
      mappedCategoryId = await findMappedCategoryId(
        sourceCategoryId,
        client,
      );
      if (mappedCategoryId) {
        resolvedCategoryId = mappedCategoryId;
        stats.categoryMappingHits += 1;
      } else {
        stats.categoryMappingMisses += 1;
        mappingMissKey = `${SOURCE}:${sourceCategoryKey}`;
      }
    } else {
      stats.sourceCategoryMissing += 1;
      logger.info(
        {
          job: "crawl",
          stage: "category",
          sourcePostId: listItem.sourcePostId,
          sourceCategoryKey,
          sourceCategoryName,
        },
        "source category missing from list/detail",
      );
    }

    if (!resolvedCategoryId) {
      resolvedCategoryId = defaultCategoryId;
      if (mappingMissKey) {
        logger.info(
          {
            job: "crawl",
            stage: "category",
            sourcePostId: listItem.sourcePostId,
            sourceCategoryId,
            sourceCategoryKey,
            sourceCategoryName,
            defaultCategoryId,
          },
          "category mapping missing; using default category",
        );
      }
    }

    logger.info(
      {
        job: "crawl",
        stage: "shipping",
        sourcePostId: listItem.sourcePostId,
        price: normalizedPrice,
        shippingText: detail.shipping ?? listItem.shippingText ?? null,
        title: detail.title ?? listItem.title ?? null,
        shippingType,
      },
      "resolved shipping type",
    );

    if (rawShopName) {
      normalizedShopName = await findNormalizedShopName(
        SOURCE,
        rawShopName,
        client,
      );
      if (!normalizedShopName) {
        logger.info(
          {
            job: "crawl",
            stage: "shop",
            sourcePostId: listItem.sourcePostId,
            rawShopName,
          },
          "shop name mapping missing; storing null in deals",
        );
      }
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
          shopName: normalizedShopName,
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
          shopName: normalizedShopName,
          subcategory,
          price: normalizedPrice,
          shippingType,
          soldOut,
          thumbnailUrl,
        },
        client,
      );
    }

    if (
      mappingMissKey &&
      sourceCategoryKey &&
      sourceCategoryName &&
      !categoryMappingMissSamples.has(mappingMissKey)
    ) {
      categoryMappingMissSamples.set(mappingMissKey, {
        source: SOURCE,
        sourceCategoryKey,
        sourceCategoryName,
        exampleDealId: dealId,
        exampleSourcePostId: listItem.sourcePostId,
        examplePostUrl: listItem.postUrl,
      });
    }

    await upsertSource(
      {
        dealId,
        source: SOURCE,
        sourcePostId: listItem.sourcePostId,
        postUrl: listItem.postUrl,
        sourceCategoryId,
        title: detail.title ?? listItem.title,
        thumbUrl: listItem.thumbUrl ?? thumbnailUrl,
        shopNameRaw: rawShopName,
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
        sourceCategoryKey,
        sourceCategoryName,
        defaultCategoryId,
        finalCategoryId: resolvedCategoryId,
      },
      "resolved category for deal",
    );

    if (!detail.documentSrl) {
      logger.warn(
        {
          job: "crawl",
          stage: "raw",
          sourcePostId: listItem.sourcePostId,
          dealId,
          documentSrl: detail.documentSrl,
          detailUrl: detail.url,
          canonicalUrl: detail.canonicalUrl,
        },
        "skip raw_deals insert: document_srl missing",
      );
    } else {
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
    }

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

// 역할: DEFAULT_CATEGORY_ID 환경변수를 검증해 숫자로 반환한다.
function requireDefaultCategoryId(): number {
  const raw = process.env.DEFAULT_CATEGORY_ID?.trim() ?? "";
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(
      "DEFAULT_CATEGORY_ID env is required and must be a positive number",
    );
  }
  return value;
}
