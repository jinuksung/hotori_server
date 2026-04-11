import pino from "pino";
import { withTx } from "../db/client";
import {
  listPendingNonAffiliateLinksByDomain,
  upsertAffiliateLink,
} from "../db/repos/links.repo";
import { findResolvedUrlBySourceUrl } from "../db/repos/linkResolutions.repo";
import { extractDomain, normalizeUrl } from "../utils/url";
import {
  createAliExpressAffiliateLink,
  isAliExpressAffiliateUrl,
  isAliExpressUrl,
} from "../utils/aliexpressAffiliate";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
const BATCH_SIZE = Number(process.env.ALIEXPRESS_AFFILIATE_BATCH_SIZE ?? "20");

type Stats = {
  candidates: number;
  aliCandidates: number;
  converted: number;
  skipped: number;
  failed: number;
};

async function main() {
  logger.info({ job: "aliexpress-affiliate", batchSize: BATCH_SIZE }, "job started");

  const candidates = await withTx((client) =>
    listPendingNonAffiliateLinksByDomain(
      ["%aliexpress.com%", "%s.click.aliexpress.com%"],
      BATCH_SIZE,
      client,
    ),
  );

  const aliCandidates = candidates.filter((item) => isAliExpressUrl(item.url));
  const stats: Stats = {
    candidates: candidates.length,
    aliCandidates: aliCandidates.length,
    converted: 0,
    skipped: candidates.length - aliCandidates.length,
    failed: 0,
  };

  for (const candidate of aliCandidates) {
    try {
      const resolvedUrl = await withTx((client) =>
        findResolvedUrlBySourceUrl(candidate.url, client),
      );
      const inputUrl = resolvedUrl ?? candidate.url;
      if (!isAliExpressUrl(inputUrl)) {
        stats.skipped += 1;
        continue;
      }

      const affiliateUrlRaw = isAliExpressAffiliateUrl(inputUrl)
        ? inputUrl
        : await createAliExpressAffiliateLink(inputUrl, `deal-${candidate.dealId}`);

      const affiliateUrl = normalizeUrl(affiliateUrlRaw);
      if (!affiliateUrl) {
        stats.failed += 1;
        continue;
      }

      const domain = extractDomain(affiliateUrl);
      if (!domain) {
        stats.failed += 1;
        continue;
      }

      await withTx((client) =>
        upsertAffiliateLink(
          {
            dealId: candidate.dealId,
            url: affiliateUrl,
            domain,
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
        { job: "aliexpress-affiliate", ...errPayload, dealId: candidate.dealId, url: candidate.url },
        "failed to create aliexpress affiliate link",
      );
    }
  }

  logger.info({ job: "aliexpress-affiliate", ...stats }, "job finished");
  console.log("[DONE]", stats);
}

main().catch((error) => {
  logger.error({ job: "aliexpress-affiliate", error }, "job failed unexpectedly");
  console.log("[FATAL] aliexpress-affiliate job failed", error);
  process.exitCode = 1;
});
