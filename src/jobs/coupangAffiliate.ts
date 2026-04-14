import pino from "pino";
import { withTx } from "../db/client";
import {
  insertLink,
  listPendingNonAffiliateLinksByDomain,
} from "../db/repos/links.repo";
import {
  findResolvedUrlBySourceUrl,
  upsertPendingLinkResolution,
} from "../db/repos/linkResolutions.repo";
import { extractDomain, normalizeUrl } from "../utils/url";
import {
  createCoupangDeepLinks,
  isCoupangUrl,
} from "../utils/coupangPartners";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
const BATCH_SIZE = Number(process.env.COUPANG_AFFILIATE_BATCH_SIZE ?? "20");

type Stats = {
  candidates: number;
  coupangCandidates: number;
  converted: number;
  skipped: number;
  failed: number;
};

function normalizeCoupangCandidateUrl(rawUrl: string): string {
  const htmlDecoded = rawUrl.replace(/&amp;/g, "&").trim();
  try {
    return decodeURIComponent(htmlDecoded);
  } catch {
    return htmlDecoded;
  }
}

async function main() {
  logger.info({ job: "coupang-affiliate", batchSize: BATCH_SIZE }, "job started");

  const candidates = await withTx((client) =>
    listPendingNonAffiliateLinksByDomain(["%www.coupang.com%"], BATCH_SIZE, client),
  );

  const coupangCandidates = candidates.filter((item) => isCoupangUrl(item.url));
  const stats: Stats = {
    candidates: candidates.length,
    coupangCandidates: coupangCandidates.length,
    converted: 0,
    skipped: candidates.length - coupangCandidates.length,
    failed: 0,
  };

  for (const candidate of coupangCandidates) {
    let resolvedUrl: string | null = null;
    try {
      resolvedUrl = await withTx((client) =>
        findResolvedUrlBySourceUrl(candidate.url, client),
      );
      const inputUrlRaw = resolvedUrl ?? candidate.url;
      const inputUrl = normalizeCoupangCandidateUrl(inputUrlRaw);
      if (!isCoupangUrl(inputUrl)) {
        stats.skipped += 1;
        logger.warn(
          {
            job: "coupang-affiliate",
            dealId: candidate.dealId,
            originalUrl: candidate.url,
            resolvedUrl,
            normalizedInputUrl: inputUrl,
          },
          "skipping non-coupang url after normalization",
        );
        continue;
      }

      if (inputUrl.includes("/vp/products/1?")) {
        await withTx((client) =>
          upsertPendingLinkResolution(
            {
              sourceUrl: inputUrl,
              sourceName: "coupang_affiliate",
              dealId: candidate.dealId,
              sourceType: "coupang_redirect",
              note: "manual review: productId=1 redirect",
            },
            client,
          ),
        );
        stats.skipped += 1;
        continue;
      }

      const subId = `deal-${candidate.dealId}`;
      const results = await createCoupangDeepLinks([inputUrl], subId);
      const first = results[0];
      const affiliateUrl = normalizeUrl(first?.landingUrl ?? first?.shortenUrl ?? "");
      if (!affiliateUrl) {
        stats.failed += 1;
        logger.warn(
          { job: "coupang-affiliate", dealId: candidate.dealId, url: candidate.url },
          "deeplink response missing landing/shorten url",
        );
        continue;
      }

      const domain = extractDomain(affiliateUrl);
      if (!domain) {
        stats.failed += 1;
        logger.warn(
          { job: "coupang-affiliate", dealId: candidate.dealId, affiliateUrl },
          "unable to extract affiliate domain",
        );
        continue;
      }

      await withTx((client) =>
        insertLink(
          {
            dealId: candidate.dealId,
            url: affiliateUrl,
            domain,
            isAffiliate: true,
          },
          client,
        ),
      );
      stats.converted += 1;
    } catch (error) {
      stats.failed += 1;
      const errPayload =
        error instanceof Error
          ? { message: error.message, stack: error.stack }
          : { error };
      logger.error(
        {
          job: "coupang-affiliate",
          ...errPayload,
          dealId: candidate.dealId,
          url: candidate.url,
          normalizedUrl: normalizeCoupangCandidateUrl(resolvedUrl ?? candidate.url),
          resolvedUrl,
        },
        "failed to create coupang affiliate link",
      );
    }
  }

  logger.info({ job: "coupang-affiliate", ...stats }, "job finished");
  console.log(`[쿠팡 제휴링크 배치] 후보 ${stats.candidates}건, 변환 ${stats.converted}건, 실패 ${stats.failed}건, 스킵 ${stats.skipped}건`);
}

main().catch((error) => {
  logger.error({ job: "coupang-affiliate", error }, "job failed unexpectedly");
  console.log("[FATAL] coupang-affiliate job failed", error);
  process.exitCode = 1;
});
