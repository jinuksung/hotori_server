import "dotenv/config";
import pino from "pino";

import { fetchPpomppuHotdealListHtml } from "../../crawlers/ppomppu/list";
import { fetchPpomppuDetailHtmls } from "../../crawlers/ppomppu/detail";
import {
  parsePpomppuHotdealList,
  type PpomppuListItem,
} from "../../parsers/ppomppu/parseList";
import {
  parsePpomppuDetail,
  type PpomppuDetail,
} from "../../parsers/ppomppu/parseDetail";

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
import { upsertPendingLinkResolution } from "../../db/repos/linkResolutions.repo";

import { extractDomain, normalizeUrl } from "../../utils/url";
import { shouldTrackForManualResolution } from "../../utils/linkResolution";
import { cacheThumbnail } from "../../utils/thumbnailCache";
import {
  detectSoldOut,
  mapShippingType,
  normalizeDealTitle,
  parsePrice,
  selectPurchaseLink,
  inferCategoryByKeywords,
} from "../pipelineHelpers";
import { inferSubcategory } from "../../parsers/common/inferSubcategory";
import { inferCategory } from "../../parsers/common/inferCategory";
import { evaluateAndUpsertPublishQueue } from "../publishHelpers";
import { buildDealGroupKey } from "../../utils/dealGrouping";

console.log("[BOOT] crawl ppomppu loaded", new Date().toISOString());

const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";
const logger = pino({ level: LOG_LEVEL });

const SOURCE = "ppomppu" as const;
const ELECTRONICS_CATEGORY_NAME = "ELECTRONICS";
const PC_CATEGORY_NAME = "PC";
const DETAIL_TIMEOUT_MS = Number(process.env.PPOMPPU_DETAIL_TIMEOUT_MS ?? "45000");
const DETAIL_HEADLESS = (process.env.PPOMPPU_DETAIL_HEADLESS ?? "true") === "true";

export type CrawlStats = {
  listItems: number;
  detailFetched: number;
  detailFailures: number;
  processed: number;
  inserted: number;
  updated: number;
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

function createEmptyStats(listItems: number): CrawlStats {
  return {
    listItems,
    detailFetched: 0,
    detailFailures: 0,
    processed: 0,
    inserted: 0,
    updated: 0,
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

export async function crawlPpomppu(): Promise<CrawlStats> {
  logger.info({ job: "crawl", source: SOURCE }, "crawl job started");
  console.log("[INFO] crawl ppomppu job started");

  const listHtmlResult = await fetchPpomppuHotdealListHtml();
  if (!listHtmlResult.ok) {
    throw new Error(`failed to fetch ppomppu list: ${listHtmlResult.error.message}`);
  }

  const parsedList = parsePpomppuHotdealList(listHtmlResult.data);
  if (!parsedList.ok) {
    throw new Error(`failed to parse ppomppu list: ${parsedList.error.message}`);
  }

  if (parsedList.data.items.length === 0) {
    return createEmptyStats(0);
  }

  const defaultCategoryId = requireDefaultCategoryId();
  const categoryNameRows = await findByNames([
    ELECTRONICS_CATEGORY_NAME,
    PC_CATEGORY_NAME,
    "FOOD",
    "HOME",
    "DIGITAL",
    "FASHION",
  ]);
  const electronicsCategoryId =
    categoryNameRows.find((row) => row.name === ELECTRONICS_CATEGORY_NAME)?.id ?? null;
  const pcCategoryId =
    categoryNameRows.find((row) => row.name === PC_CATEGORY_NAME)?.id ?? null;
  const foodCategoryId = categoryNameRows.find((row) => row.name === "FOOD")?.id ?? null;
  const homeCategoryId = categoryNameRows.find((row) => row.name === "HOME")?.id ?? null;
  const digitalCategoryId = categoryNameRows.find((row) => row.name === "DIGITAL")?.id ?? null;
  const fashionCategoryId = categoryNameRows.find((row) => row.name === "FASHION")?.id ?? null;

  const categoryMappingMissSamples = new Map<string, CategoryMappingMissSample>();
  const categoryCountBefore = await withTx((client) => countCategories(client));
  logger.info(
    {
      job: "crawl",
      source: SOURCE,
      stage: "categories",
      categoryCount: categoryCountBefore,
      defaultCategoryId,
    },
    "category count before crawl",
  );

  const itemsBySourcePostId = new Map(
    parsedList.data.items.map((item) => [item.sourcePostId, item]),
  );

  const detailTargets = parsedList.data.items.map((item) => ({
    sourcePostId: item.sourcePostId,
    postUrl: item.postUrl,
  }));

  const detailResult = await fetchPpomppuDetailHtmls(detailTargets, {
    headless: DETAIL_HEADLESS,
    timeoutMs: DETAIL_TIMEOUT_MS,
    waitUntil: "domcontentloaded",
  });

  const detailResults = detailResult.successes.map((success) => ({
    sourcePostId: success.sourcePostId,
    html: success.html,
    postUrl: success.postUrl,
  }));

  const stats: CrawlStats = {
    listItems: parsedList.data.items.length,
    detailFetched: detailResults.length,
    detailFailures: detailResult.failures.length,
    processed: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    parserFailures: 0,
    persistFailures: 0,
    dumpedFailures: 0,
    sourceCategoryUpserts: 0,
    sourceCategoryMissing: 0,
    categoryMappingHits: 0,
    categoryMappingMisses: 0,
  };

  for (const detail of detailResults) {
    const listItem = itemsBySourcePostId.get(detail.sourcePostId);
    if (!listItem) {
      stats.skipped += 1;
      continue;
    }

    let parsedDetail: PpomppuDetail;
    try {
      parsedDetail = parsePpomppuDetail(detail.html);
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
    } catch (error) {
      stats.persistFailures += 1;
      console.log("[ERROR] persist failed", detail.sourcePostId, error);
    }
  }

  return stats;
}

async function persistDeal(
  listItem: PpomppuListItem,
  detail: PpomppuDetail,
  defaultCategoryId: number,
  electronicsCategoryId: number | null,
  pcCategoryId: number | null,
  stats: CrawlStats,
  categoryMappingMissSamples: Map<string, CategoryMappingMissSample>,
): Promise<void> {
  const normalizedPrice = parsePrice(detail.price ?? listItem.priceText ?? null);
  const shippingType = mapShippingType(
    detail.shipping ?? listItem.shippingText ?? null,
    detail.title ?? listItem.title ?? null,
    normalizedPrice,
  );
  const soldOut = detectSoldOut(detail.title, listItem.title, detail.summaryText);
  const sourceThumbnailUrl = detail.ogImage ?? listItem.thumbUrl ?? null;
  const rawShopName = detail.mall ?? listItem.shopText ?? null;
  const rawTitle = (detail.title ?? listItem.title).trim();
  const dealTitle = normalizeDealTitle(rawTitle);
  const purchaseUrl = selectPurchaseLink(detail);
  const normalizedPurchaseUrl = purchaseUrl ? (normalizeUrl(purchaseUrl) ?? purchaseUrl) : null;
  const purchaseDomain = normalizedPurchaseUrl ? extractDomain(normalizedPurchaseUrl) : null;
  const sourceCategoryKey = listItem.sourceCategoryKey ?? detail.sourceCategoryKey ?? null;
  const sourceCategoryName = listItem.sourceCategoryName ?? detail.sourceCategoryName ?? null;

  const existingSourceForThumb = await findBySourcePost(SOURCE, listItem.sourcePostId);
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
    }

    if (!resolvedCategoryId) {
      resolvedCategoryId = defaultCategoryId;
    }

    if (resolvedCategoryId === defaultCategoryId) {
      const inferred = inferCategoryByKeywords(dealTitle, detail.summaryText ?? null);
      if (inferred === "FOOD" && foodCategoryId) resolvedCategoryId = foodCategoryId;
      if (inferred === "HOME" && homeCategoryId) resolvedCategoryId = homeCategoryId;
      if (inferred === "DIGITAL" && digitalCategoryId) resolvedCategoryId = digitalCategoryId;
      if (inferred === "FASHION" && fashionCategoryId) resolvedCategoryId = fashionCategoryId;
      if (inferred === "ELECTRONICS" && electronicsCategoryId) {
        resolvedCategoryId = electronicsCategoryId;
      }
    }

    if (
      electronicsCategoryId &&
      pcCategoryId &&
      resolvedCategoryId === electronicsCategoryId
    ) {
      const inferred = inferCategory({
        title: dealTitle,
        bodyText: detail.summaryText ?? null,
        linkDomains: purchaseDomain ? [purchaseDomain] : null,
      });
      if (inferred?.categoryName === PC_CATEGORY_NAME) {
        resolvedCategoryId = pcCategoryId;
      }
    }

    if (rawShopName) {
      normalizedShopName = await findNormalizedShopName(SOURCE, rawShopName, client);
    }

    const subcategory = inferSubcategory(
      resolvedCategoryId,
      dealTitle,
      detail.summaryText ?? null,
      purchaseDomain ? [purchaseDomain] : null,
    );
    const dealGroupKey = buildDealGroupKey({
      categoryName: null,
      title: dealTitle,
      representativeUrl: normalizedPurchaseUrl,
    });

    const existingSource = await findBySourcePost(SOURCE, listItem.sourcePostId, client);
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
          thumbnailUrl: cachedThumbnailUrl ?? null,
          dealGroupKey,
        },
        client,
      );
      dealId = created.id;
      stats.inserted += 1;
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
          thumbnailUrl: cachedThumbnailUrl ?? existingSource?.dealThumbnailUrl ?? null,
          dealGroupKey,
        },
        client,
      );
      stats.updated += 1;
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
        thumbUrl: sourceThumbnailUrl,
        shopNameRaw: rawShopName,
      },
      client,
    );

    if (detail.documentSrl) {
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

    if (purchaseUrl && normalizedPurchaseUrl && purchaseDomain) {
      await insertLink(
        {
          dealId,
          url: normalizedPurchaseUrl,
          domain: purchaseDomain,
          isAffiliate: false,
        },
        client,
      );

      if (shouldTrackForManualResolution(normalizedPurchaseUrl)) {
        await upsertPendingLinkResolution(
          {
            sourceUrl: normalizedPurchaseUrl,
            sourceName: SOURCE,
            dealId,
            note: dealTitle,
          },
          client,
        );
      }
    }

    await evaluateAndUpsertPublishQueue(dealId, client);
  });
}

function requireDefaultCategoryId(): number {
  const raw = process.env.DEFAULT_CATEGORY_ID?.trim() ?? "";
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("DEFAULT_CATEGORY_ID env is required and must be a positive number");
  }
  return value;
}
