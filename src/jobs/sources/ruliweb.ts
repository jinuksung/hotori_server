// 역할: 루리웹 크롤링 파이프라인의 실질 로직을 제공한다.
// src/jobs/sources/ruliweb.ts
import "dotenv/config";
import pino from "pino";

import { fetchRuliwebHotdealListHtml } from "../../crawlers/ruliweb/list";
import { fetchRuliwebDetailHtmls } from "../../crawlers/ruliweb/detail";

import {
  parseRuliwebHotdealList,
  type RuliwebListItem,
} from "../../parsers/ruliweb/parseList";
import {
  parseRuliwebDetail,
  type RuliwebDetail,
} from "../../parsers/ruliweb/parseDetail";

import { withTx } from "../../db/client";
import { appendRaw } from "../../db/repos/rawDeals.repo";
import { createDeal, updateDeal } from "../../db/repos/deals.repo";
import { upsertSource, findBySourcePost } from "../../db/repos/dealSources.repo";
import { insertLink } from "../../db/repos/links.repo";
import { insertSnapshot } from "../../db/repos/metrics.repo";
import { countCategories, findByNames } from "../../db/repos/categories.repo";
import { upsertSourceCategory } from "../../db/repos/sourceCategories.repo";
import { findMappedCategoryId } from "../../db/repos/categoryMappings.repo";
import { findNormalizedShopName } from "../../db/repos/shopNameMappings.repo";

import { extractDomain, normalizeUrl } from "../../utils/url";
import { cacheThumbnail } from "../../utils/thumbnailCache";
import {
  detectSoldOut,
  mapShippingType,
  normalizeDealTitle,
  parsePrice,
  selectPurchaseLink,
} from "../pipelineHelpers";
import { inferSubcategory } from "../../parsers/common/inferSubcategory";
import { inferCategory } from "../../parsers/common/inferCategory";

console.log("[BOOT] crawl ruliweb loaded", new Date().toISOString());

const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";
const logger = pino({ level: LOG_LEVEL });

const SOURCE = "ruliweb" as const;
const ELECTRONICS_CATEGORY_NAME = "ELECTRONICS";
const PC_CATEGORY_NAME = "PC";

const DETAIL_TIMEOUT_MS = Number(
  process.env.RULIWEB_DETAIL_TIMEOUT_MS ?? "45000",
);
const DETAIL_HEADLESS =
  (process.env.RULIWEB_DETAIL_HEADLESS ?? "true") === "true";

function isNoticeCategoryName(name?: string | null): boolean {
  return (name ?? "").trim() === "공지";
}

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

// 역할: 루리웹 크롤링 전체 플로우를 실행하고 통계를 반환한다.
export async function crawlRuliweb(): Promise<CrawlStats> {
  logger.info({ job: "crawl" }, "crawl job started");
  console.log("[INFO] crawl job started");

  // 1) LIST
  console.log("[INFO] fetching list html...");
  const listHtmlResult = await fetchRuliwebHotdealListHtml();

  if (!listHtmlResult.ok) {
    logger.error(
      { job: "crawl", stage: "list", error: listHtmlResult.error },
      "failed to fetch ruliweb list",
    );
    console.log("[ERROR] failed to fetch list", listHtmlResult.error);
    throw new Error(
      `failed to fetch ruliweb list: ${listHtmlResult.error.message}`,
    );
  }

  console.log("[INFO] parsing list html...");
  const parsedList = parseRuliwebHotdealList(listHtmlResult.data);

  if (!parsedList.ok) {
    logger.error(
      { job: "crawl", stage: "list", error: parsedList.error },
      "failed to parse ruliweb list",
    );
    console.log("[ERROR] failed to parse list", parsedList.error);
    throw new Error(
      `failed to parse ruliweb list: ${parsedList.error.message}`,
    );
  }

  if (parsedList.data.items.length === 0) {
    logger.info({ job: "crawl", stage: "list" }, "no hotdeal items found");
    console.log("[INFO] no hotdeal items found");
    return createEmptyStats(0);
  }

  const filteredItems = parsedList.data.items.filter(
    (item) => !isNoticeCategoryName(item.sourceCategoryName),
  );
  const noticeSkipped = parsedList.data.items.length - filteredItems.length;
  if (noticeSkipped > 0) {
    logger.info(
      { job: "crawl", stage: "list", noticeSkipped },
      "excluded notice category items",
    );
    console.log("[INFO] notice items excluded:", noticeSkipped);
  }

  if (filteredItems.length === 0) {
    logger.info(
      { job: "crawl", stage: "list" },
      "no hotdeal items left after notice filter",
    );
    console.log("[INFO] no hotdeal items left after notice filter");
    return createEmptyStats(0);
  }

  logger.info(
    { job: "crawl", stage: "list", itemCount: filteredItems.length },
    "parsed ruliweb list",
  );
  console.log("[INFO] list items:", filteredItems.length);

  const defaultCategoryId = requireDefaultCategoryId();
  const categoryNameRows = await findByNames(
    [ELECTRONICS_CATEGORY_NAME, PC_CATEGORY_NAME],
  );
  const electronicsCategoryId =
    categoryNameRows.find((row) => row.name === ELECTRONICS_CATEGORY_NAME)
      ?.id ?? null;
  const pcCategoryId =
    categoryNameRows.find((row) => row.name === PC_CATEGORY_NAME)?.id ?? null;

  if (!electronicsCategoryId) {
    logger.warn(
      { job: "crawl", stage: "categories", category: ELECTRONICS_CATEGORY_NAME },
      "electronics category missing; category override disabled",
    );
  }
  if (!pcCategoryId) {
    logger.warn(
      { job: "crawl", stage: "categories", category: PC_CATEGORY_NAME },
      "pc category missing; category override disabled",
    );
  }
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
    filteredItems.map((item) => [item.sourcePostId, item]),
  );

  // 2) DETAIL CRAWL
  const detailTargets = filteredItems.map((item) => ({
    sourcePostId: item.sourcePostId,
    postUrl: item.postUrl,
  }));

  logger.info(
    {
      job: "crawl",
      stage: "detail-crawl",
      targetCount: detailTargets.length,
      timeoutMs: DETAIL_TIMEOUT_MS,
      headless: DETAIL_HEADLESS,
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
      },
      null,
      2,
    ),
  );

  const detailResult = await fetchRuliwebDetailHtmls(detailTargets, {
    headless: DETAIL_HEADLESS,
    timeoutMs: DETAIL_TIMEOUT_MS,
    waitUntil: "domcontentloaded",
  });

  const detailResults: Array<{
    sourcePostId: string;
    html: string;
    postUrl: string;
  }> = detailResult.successes.map((success) => ({
    sourcePostId: success.sourcePostId,
    html: success.html,
    postUrl: success.postUrl,
  }));

  const stats: CrawlStats = {
    listItems: filteredItems.length,
    detailFetched: detailResults.length,
    detailFailures: detailResult.failures.length,
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

  detailResult.failures.forEach((failure) => {
    console.log(`[FAIL] detail failed: ${failure.sourcePostId}`, failure.error);
  });

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

    let parsedDetail: RuliwebDetail;
    try {
      parsedDetail = parseRuliwebDetail(detail.html);
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
        electronicsCategoryId,
        pcCategoryId,
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
  listItem: RuliwebListItem,
  detail: RuliwebDetail,
  defaultCategoryId: number,
  electronicsCategoryId: number | null,
  pcCategoryId: number | null,
  stats: CrawlStats,
  categoryMappingMissSamples: Map<string, CategoryMappingMissSample>,
): Promise<void> {
  const normalizedPrice = parsePrice(detail.price ?? null);
  const shippingType = mapShippingType(
    detail.shipping ?? null,
    detail.title ?? listItem.title ?? null,
    normalizedPrice,
  );
  const soldOut = detectSoldOut(detail.title, listItem.title);
  const sourceThumbnailUrl = detail.ogImage ?? listItem.thumbUrl ?? null;
  const rawShopName = detail.mall ?? null;
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

  const existingSourceForThumb = await findBySourcePost(
    SOURCE,
    listItem.sourcePostId,
  );
  const shouldSkipThumbnailCache =
    !!sourceThumbnailUrl &&
    !!existingSourceForThumb?.dealThumbnailUrl &&
    !!existingSourceForThumb?.sourceThumbUrl &&
    existingSourceForThumb.sourceThumbUrl === sourceThumbnailUrl;

  let cachedThumbnailUrl = existingSourceForThumb?.dealThumbnailUrl ?? null;
  const cachedThumbnailResult = sourceThumbnailUrl && !shouldSkipThumbnailCache
    ? await cacheThumbnail({
        source: SOURCE,
        sourcePostId: listItem.sourcePostId,
        sourceUrl: sourceThumbnailUrl,
      })
    : null;

  if (cachedThumbnailResult?.ok) {
    cachedThumbnailUrl = cachedThumbnailResult.publicUrl;
  }

  if (cachedThumbnailResult && !cachedThumbnailResult.ok && sourceThumbnailUrl) {
    logger.info(
      {
        job: "crawl",
        stage: "thumbnail",
        sourcePostId: listItem.sourcePostId,
        reason: cachedThumbnailResult.reason,
        status: cachedThumbnailResult.status,
        sourceUrl: sourceThumbnailUrl,
      },
      "thumbnail cache skipped/failed",
    );
  } else if (shouldSkipThumbnailCache) {
    logger.debug(
      {
        job: "crawl",
        stage: "thumbnail",
        sourcePostId: listItem.sourcePostId,
      },
      "thumbnail cache skipped (already cached)",
    );
  }

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
        client,
      );
      sourceCategoryId = sourceCategory.id;
      mappedCategoryId = await findMappedCategoryId(sourceCategoryId, client);
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

    if (
      electronicsCategoryId &&
      pcCategoryId &&
      resolvedCategoryId === electronicsCategoryId
    ) {
      const inferred = inferCategory({
        title: dealTitle,
        bodyText: null,
        linkDomains: purchaseDomain ? [purchaseDomain] : null,
      });
      if (inferred?.categoryName === PC_CATEGORY_NAME) {
        resolvedCategoryId = pcCategoryId;
        logger.info(
          {
            job: "crawl",
            stage: "category",
            sourcePostId: listItem.sourcePostId,
            inferredCategory: inferred.categoryName,
            finalCategoryId: resolvedCategoryId,
          },
          "category overridden by inference",
        );
      }
    }

    logger.info(
      {
        job: "crawl",
        stage: "shipping",
        sourcePostId: listItem.sourcePostId,
        price: normalizedPrice,
        shippingText: detail.shipping ?? null,
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
      null,
      purchaseDomain ? [purchaseDomain] : null,
    );

    const existing = await findBySourcePost(
      SOURCE,
      listItem.sourcePostId,
      client,
    );

    let dealId: number;
    if (existing) {
      dealId = existing.dealId;
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
          thumbnailUrl: sourceThumbnailUrl
            ? cachedThumbnailUrl ?? undefined
            : null,
        },
        client,
      );
    } else {
      const created = await createDeal(
        {
          categoryId: resolvedCategoryId,
          title: dealTitle,
          shopName: normalizedShopName,
          subcategory,
          price: normalizedPrice,
          shippingType,
          soldOut,
          thumbnailUrl: cachedThumbnailUrl ?? null,
        },
        client,
      );
      dealId = created.id;
    }

    await upsertSource(
      {
        dealId,
        source: SOURCE,
        sourcePostId: listItem.sourcePostId,
        postUrl: listItem.postUrl,
        sourceCategoryId,
        title: detail.title ?? listItem.title,
        thumbUrl: sourceThumbnailUrl,
        shopNameRaw: rawShopName,
      },
      client,
    );

    if (mappingMissKey && dealId) {
      const key = mappingMissKey;
      if (!categoryMappingMissSamples.has(key)) {
        categoryMappingMissSamples.set(key, {
          source: SOURCE,
          sourceCategoryKey: sourceCategoryKey!,
          sourceCategoryName: sourceCategoryName!,
          exampleDealId: dealId,
          exampleSourcePostId: listItem.sourcePostId,
          examplePostUrl: listItem.postUrl,
        });
      }
    }

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
      "insertSnapshot",
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
  const value = process.env.DEFAULT_CATEGORY_ID ?? "";
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `DEFAULT_CATEGORY_ID is required and must be > 0. (current: ${value})`,
    );
  }
  return parsed;
}
