import pino from "pino";
import { withTx } from "../db/client";
import {
  insertLink,
  listPendingNonAffiliateLinksByDomain,
} from "../db/repos/links.repo";
import { findResolvedUrlBySourceUrl } from "../db/repos/linkResolutions.repo";
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
    try {
      const resolvedUrl = await withTx((client) =>
        findResolvedUrlBySourceUrl(candidate.url, client),
      );
      const inputUrlRaw = resolvedUrl ?? candidate.url;
      const inputUrl = inputUrlRaw.replace(/&amp;/g, "&");
      if (!isCoupangUrl(inputUrl)) {
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
        { job: "coupang-affiliate", ...errPayload, dealId: candidate.dealId, url: candidate.url },
        "failed to create coupang affiliate link",
      );
    }
  }

  logger.info({ job: "coupang-affiliate", ...stats }, "job finished");
  console.log("[DONE]", stats);
}

main().catch((error) => {
  logger.error({ job: "coupang-affiliate", error }, "job failed unexpectedly");
  console.log("[FATAL] coupang-affiliate job failed", error);
  process.exitCode = 1;
});
