// 역할: 최근 딜의 메트릭을 갱신하고 히스토리로 누적하는 배치 작업.

import pino from "pino";
import { fetchFmkoreaDetailHtmls } from "../crawlers/fmkorea/detail";
import { parseFmHotdealDetail, type FmHotdealDetail } from "../parsers/fmkorea/parseDetail";
import { listRecentPosts } from "../db/repos/dealSources.repo";
import { updateDeal } from "../db/repos/deals.repo";
import { insertSnapshot } from "../db/repos/metrics.repo";
import { appendRaw } from "../db/repos/rawDeals.repo";
import { withTx } from "../db/client";
import { findNormalizedShopName } from "../db/repos/shopNameMappings.repo";
import {
  detectSoldOut,
  mapShippingType,
  normalizeDealTitle,
  parsePrice,
} from "./pipelineHelpers";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
const SOURCE = "fmkorea" as const;
const REFRESH_BATCH_SIZE = Number(process.env.REFRESH_BATCH_SIZE ?? "20");
const DETAIL_TIMEOUT_MS = Number(
  process.env.FMKOREA_DETAIL_TIMEOUT_MS ?? "45000",
);
const DETAIL_HEADLESS =
  (process.env.FMKOREA_DETAIL_HEADLESS ?? "true") === "true";

type RefreshStats = {
  targets: number;
  detailFailures: number;
  processed: number;
  skipped: number;
  parserFailures: number;
  persistFailures: number;
};

// 역할: 최근 게시글을 크롤링해 메트릭/딜 정보를 갱신한다.
async function main() {
  logger.info(
    { job: "refresh", batchSize: REFRESH_BATCH_SIZE },
    "refreshMetrics job started"
  );

  const recentPosts = await withTx((client) =>
    listRecentPosts(SOURCE, REFRESH_BATCH_SIZE, client),
  );
  if (recentPosts.length === 0) {
    logger.info({ job: "refresh" }, "no posts available for refresh");
    return;
  }

  const postsBySourcePostId = new Map(
    recentPosts.map((post) => [post.sourcePostId, post])
  );

  const detailTargets = recentPosts.map((post) => ({
    sourcePostId: post.sourcePostId,
    postUrl: post.postUrl,
  }));

  const detailResult = await fetchFmkoreaDetailHtmls(detailTargets, {
    headless: DETAIL_HEADLESS,
    timeoutMs: DETAIL_TIMEOUT_MS,
    waitUntil: "domcontentloaded",
  });
  logger.info(
    {
      job: "refresh",
      stage: "detail-crawl",
      targets: detailTargets.length,
      headless: DETAIL_HEADLESS,
      timeoutMs: DETAIL_TIMEOUT_MS,
    },
    "refresh detail crawl config",
  );
  detailResult.failures.forEach((failure) => {
    logger.warn(
      {
        job: "refresh",
        sourcePostId: failure.sourcePostId,
        postUrl: failure.postUrl,
        error: failure.error,
      },
      "detail crawl failed during refresh"
    );
  });

  const stats: RefreshStats = {
    targets: recentPosts.length,
    detailFailures: detailResult.failures.length,
    processed: 0,
    skipped: 0,
    parserFailures: 0,
    persistFailures: 0,
  };

  for (const detail of detailResult.successes) {
    const post = postsBySourcePostId.get(detail.sourcePostId);
    if (!post) {
      stats.skipped += 1;
      continue;
    }

    let parsedDetail: FmHotdealDetail;
    try {
      parsedDetail = parseFmHotdealDetail(detail.html);
    } catch (error) {
      stats.parserFailures += 1;
      logger.error(
        { job: "refresh", error, sourcePostId: detail.sourcePostId },
        "failed to parse detail html during refresh"
      );
      continue;
    }

    try {
      await persistMetrics(post, parsedDetail);
      stats.processed += 1;
    } catch (error) {
      stats.persistFailures += 1;
      logger.error(
        { job: "refresh", error, sourcePostId: detail.sourcePostId },
        "failed to persist refreshed metrics"
      );
    }
  }

  logger.info({ job: "refresh", ...stats }, "refreshMetrics job finished");
}

// 역할: 갱신된 메트릭과 딜 정보를 트랜잭션으로 저장한다.
async function persistMetrics(
  post: { dealId: number; sourcePostId: string },
  detail: FmHotdealDetail
): Promise<void> {
  const normalizedPrice = parsePrice(detail.price ?? null);
  const shippingType = mapShippingType(detail.shipping ?? null, detail.title ?? null);
  const soldOut = detectSoldOut(detail.title);
  const thumbnailUrl = detail.ogImage ?? null;
  const rawShopName = detail.mall ?? null;
  const title = detail.title ? normalizeDealTitle(detail.title) : undefined;

  await withTx(async (client) => {
    const normalizedShopName = rawShopName
      ? await findNormalizedShopName(SOURCE, rawShopName, client)
      : null;

    if (rawShopName && !normalizedShopName) {
      logger.info(
        {
          job: "refresh",
          stage: "shop",
          sourcePostId: post.sourcePostId,
          dealId: post.dealId,
          rawShopName,
        },
        "shop name mapping missing; storing null in deals",
      );
    }

    await updateDeal(
      post.dealId,
      {
        title,
        shopName: normalizedShopName,
        price: normalizedPrice,
        shippingType,
        soldOut,
        thumbnailUrl,
      },
      client
    );

    await insertSnapshot(
      {
        dealId: post.dealId,
        source: SOURCE,
        views: detail.viewCount ?? null,
        votes: detail.upvoteCount ?? null,
        comments: detail.commentCount ?? null,
      },
      client
    );

    if (!detail.documentSrl) {
      logger.warn(
        {
          job: "refresh",
          stage: "raw",
          sourcePostId: post.sourcePostId,
          dealId: post.dealId,
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
          sourcePostId: post.sourcePostId,
          payload: {
            detail,
            refreshedAt: new Date().toISOString(),
          },
        },
        client
      );
    }
  });
}

main().catch((error) => {
  logger.error({ job: "refresh", error }, "refreshMetrics job failed unexpectedly");
  process.exitCode = 1;
});
