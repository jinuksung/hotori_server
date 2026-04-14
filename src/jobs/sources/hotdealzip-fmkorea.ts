import "dotenv/config";
import pino from "pino";

import { fetchHotdealzipFmkoreaDeals } from "../../crawlers/hotdealzip/fmkorea";
import { fetchHotdealzipDetailHtml } from "../../crawlers/hotdealzip/detail";
import {
  parseHotdealzipFmkoreaFeed,
  type HotdealzipFmkoreaItem,
} from "../../parsers/hotdealzip/parseFmkoreaFeed";
import { parseHotdealzipDetail } from "../../parsers/hotdealzip/parseDetail";
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
import { cacheThumbnail } from "../../utils/thumbnailCache";
import { shouldTrackForManualResolution } from "../../utils/linkResolution";
import { extractDomain, normalizeUrl } from "../../utils/url";
import { inferCategory } from "../../parsers/common/inferCategory";
import { inferSubcategory } from "../../parsers/common/inferSubcategory";
import {
  detectSoldOut,
  mapShippingType,
  normalizeDealTitle,
  parsePrice,
  inferCategoryByKeywords,
} from "../pipelineHelpers";
import { evaluateAndUpsertPublishQueue } from "../publishHelpers";
import { buildDealGroupKey } from "../../utils/dealGrouping";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
const SOURCE = "hotdealzip_fmkorea" as const;
const ELECTRONICS_CATEGORY_NAME = "ELECTRONICS";
const PC_CATEGORY_NAME = "PC";

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
    detailFetched: listItems,
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

export async function crawlHotdealzipFmkorea(): Promise<CrawlStats> {
  logger.info({ job: "crawl", source: SOURCE }, "crawl job started");

  const feedResult = await fetchHotdealzipFmkoreaDeals();
  if (!feedResult.ok) {
    throw new Error(`failed to fetch hotdealzip fmkorea feed: ${feedResult.error.message}`);
  }

  const items = parseHotdealzipFmkoreaFeed(feedResult.data);
  if (items.length === 0) {
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

  const categoryMappingMissSamples = new Map<string, CategoryMappingMissSample>();

  const stats: CrawlStats = {
    listItems: items.length,
    detailFetched: items.length,
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

  for (const item of items) {
    try {
      await persistDeal(
        item,
        defaultCategoryId,
        electronicsCategoryId,
        pcCategoryId,
        stats,
        categoryMappingMissSamples,
      );
      stats.processed += 1;
    } catch (error) {
      stats.persistFailures += 1;
      logger.error({ job: "crawl", source: SOURCE, error, sourcePostId: item.sourcePostId }, "persist failed");
    }
  }

  logger.info({ job: "crawl", source: SOURCE, ...stats }, "crawl job finished");
  return stats;
}

async function persistDeal(
  item: HotdealzipFmkoreaItem,
  defaultCategoryId: number,
  electronicsCategoryId: number | null,
  pcCategoryId: number | null,
  stats: CrawlStats,
  categoryMappingMissSamples: Map<string, CategoryMappingMissSample>,
): Promise<void> {
  const normalizedPrice = parsePrice(item.priceText);
  const shippingType = mapShippingType(item.shippingText, item.title, normalizedPrice);
  const soldOut = detectSoldOut(item.title, item.raw.status);
  const rawShopName = item.shopText;
  const dealTitle = normalizeDealTitle(item.title);

  const detailHtmlResult = item.seoUrl
    ? await fetchHotdealzipDetailHtml(item.seoUrl)
    : { ok: false as const, error: { message: "seo_url missing" } };
  const detailParsed = detailHtmlResult.ok ? parseHotdealzipDetail(detailHtmlResult.data) : null;
  const purchaseUrl = detailParsed?.buyUrl ?? null;
  const sourceThumbnailUrl = item.thumbUrl ?? detailParsed?.imageUrl ?? null;
  const normalizedPurchaseUrl = purchaseUrl ? (normalizeUrl(purchaseUrl) ?? purchaseUrl) : null;
  const purchaseDomain = normalizedPurchaseUrl ? extractDomain(normalizedPurchaseUrl) : null;

  const existingSourceForThumb = await findBySourcePost(SOURCE, item.sourcePostId);
  const shouldSkipThumbnailCache =
    !!sourceThumbnailUrl &&
    !!existingSourceForThumb?.dealThumbnailUrl &&
    !!existingSourceForThumb?.sourceThumbUrl &&
    existingSourceForThumb.sourceThumbUrl === sourceThumbnailUrl;

  let cachedThumbnailUrl = existingSourceForThumb?.dealThumbnailUrl ?? null;
  const cachedThumbnailResult = sourceThumbnailUrl && !shouldSkipThumbnailCache
    ? await cacheThumbnail({
        source: SOURCE,
        sourcePostId: item.sourcePostId,
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

    if (item.sourceCategoryKey && item.sourceCategoryName) {
      stats.sourceCategoryUpserts += 1;
      const sourceCategory = await upsertSourceCategory(
        {
          source: SOURCE,
          sourceKey: item.sourceCategoryKey,
          name: item.sourceCategoryName,
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
        mappingMissKey = `${SOURCE}:${item.sourceCategoryKey}`;
      }
    } else {
      stats.sourceCategoryMissing += 1;
    }

    if (!resolvedCategoryId) {
      resolvedCategoryId = defaultCategoryId;
    }

    if (resolvedCategoryId === defaultCategoryId) {
      const inferred = inferCategoryByKeywords(dealTitle, null);
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
        bodyText: null,
        linkDomains: rawShopName ? [rawShopName] : null,
      });
      if (inferred?.categoryName === PC_CATEGORY_NAME) {
        resolvedCategoryId = pcCategoryId;
      }
    }

    if (rawShopName) {
      normalizedShopName = (await findNormalizedShopName(SOURCE, rawShopName, client)) ?? rawShopName;
    }

    const subcategory = inferSubcategory(resolvedCategoryId, dealTitle, null, null);
    const dealGroupKey = buildDealGroupKey({
      categoryName: null,
      title: dealTitle,
      representativeUrl: normalizedPurchaseUrl,
    });
    const existingSource = await findBySourcePost(SOURCE, item.sourcePostId, client);
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
      item.sourceCategoryKey &&
      item.sourceCategoryName &&
      !categoryMappingMissSamples.has(mappingMissKey)
    ) {
      categoryMappingMissSamples.set(mappingMissKey, {
        source: SOURCE,
        sourceCategoryKey: item.sourceCategoryKey,
        sourceCategoryName: item.sourceCategoryName,
        exampleDealId: dealId,
        exampleSourcePostId: item.sourcePostId,
        examplePostUrl: item.postUrl,
      });
    }

    await upsertSource(
      {
        dealId,
        source: SOURCE,
        sourcePostId: item.sourcePostId,
        postUrl: item.postUrl,
        sourceCategoryId,
        title: item.title,
        thumbUrl: sourceThumbnailUrl,
        shopNameRaw: rawShopName,
      },
      client,
    );

    await appendRaw(
      {
        source: SOURCE,
        sourcePostId: item.sourcePostId,
        payload: {
          feed: item.raw,
          capturedAt: new Date().toISOString(),
        },
      },
      client,
    );

    await insertSnapshot(
      {
        dealId,
        source: SOURCE,
        views: item.viewCount ?? null,
        votes: null,
        comments: item.commentCount ?? null,
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
