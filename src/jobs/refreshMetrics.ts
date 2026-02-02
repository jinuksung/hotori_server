import pino from "pino";
import { fetchFmkoreaDetailHtmls } from "../crawlers/fmkorea/detail";
import { parseFmHotdealDetail, type FmHotdealDetail } from "../parsers/fmkorea/parseDetail";
import { listRecentPosts } from "../db/repos/dealSources.repo";
import { updateDeal } from "../db/repos/deals.repo";
import { insertSnapshot } from "../db/repos/metrics.repo";
import { appendRaw } from "../db/repos/rawDeals.repo";
import { withTx } from "../db/client";
import {
  detectSoldOut,
  mapShippingType,
  parsePrice,
  stripShopPrefix,
} from "./pipelineHelpers";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
const SOURCE = "fmkorea" as const;
const REFRESH_BATCH_SIZE = Number(process.env.REFRESH_BATCH_SIZE ?? "20");

type RefreshStats = {
  targets: number;
  detailFailures: number;
  processed: number;
  skipped: number;
  parserFailures: number;
  persistFailures: number;
};

async function main() {
  logger.info(
    { job: "refresh", batchSize: REFRESH_BATCH_SIZE },
    "refreshMetrics job started"
  );

  const recentPosts = await listRecentPosts(SOURCE, REFRESH_BATCH_SIZE);
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

  const detailResult = await fetchFmkoreaDetailHtmls(detailTargets);
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

async function persistMetrics(
  post: { dealId: number; sourcePostId: string },
  detail: FmHotdealDetail
): Promise<void> {
  const normalizedPrice = parsePrice(detail.price ?? null);
  const shippingType = mapShippingType(detail.shipping ?? null);
  const soldOut = detectSoldOut(detail.title);
  const thumbnailUrl = detail.ogImage ?? null;
  const shopName = detail.mall ?? null;
  const title = detail.title ? stripShopPrefix(detail.title) : undefined;

  await withTx(async (client) => {
    await updateDeal(
      post.dealId,
      {
        title,
        shopName,
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
  });
}

main().catch((error) => {
  logger.error({ job: "refresh", error }, "refreshMetrics job failed unexpectedly");
  process.exitCode = 1;
});
