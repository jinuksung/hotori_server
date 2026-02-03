import pino from "pino";
import {
  insertLink,
  listNonAffiliateLinksMissingAffiliatePair,
} from "../db/repos/links.repo";
import { extractDomain, normalizeUrl } from "../utils/url";
import { withTx } from "../db/client";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
const BATCH_SIZE = Number(process.env.AFFILIATE_BATCH_SIZE ?? "50");
const AFFILIATE_BASE = process.env.AFFILIATE_REDIRECT_BASE;
const TRACKING_ID = process.env.AFFILIATE_TRACKING_ID;

type AffiliateStats = {
  candidates: number;
  converted: number;
  skipped: number;
  failed: number;
};

async function main() {
  if (!AFFILIATE_BASE) {
    logger.error(
      { job: "affiliate" },
      "AFFILIATE_REDIRECT_BASE env is required to run affiliate job"
    );
    process.exitCode = 1;
    return;
  }

  logger.info({ job: "affiliate", batchSize: BATCH_SIZE }, "affiliate job started");

  const candidates = await withTx((client) =>
    listNonAffiliateLinksMissingAffiliatePair(BATCH_SIZE, client),
  );
  const stats: AffiliateStats = {
    candidates: candidates.length,
    converted: 0,
    skipped: 0,
    failed: 0,
  };

  for (const candidate of candidates) {
    const affiliateUrl = buildAffiliateUrl(candidate.url);
    if (!affiliateUrl) {
      stats.skipped += 1;
      logger.warn(
        { job: "affiliate", dealId: candidate.dealId, url: candidate.url },
        "skipping candidate due to invalid affiliate url"
      );
      continue;
    }

    const normalized = normalizeUrl(affiliateUrl) ?? affiliateUrl;
    const domain = extractDomain(normalized);
    if (!domain) {
      stats.skipped += 1;
      logger.warn(
        { job: "affiliate", dealId: candidate.dealId, url: normalized },
        "unable to determine affiliate domain"
      );
      continue;
    }

    try {
      await withTx((client) =>
        insertLink(
          {
            dealId: candidate.dealId,
            url: normalized,
            domain,
            isAffiliate: true,
          },
          client,
        ),
      );
      stats.converted += 1;
    } catch (error) {
      stats.failed += 1;
      logger.error(
        { job: "affiliate", error, dealId: candidate.dealId, url: normalized },
        "failed to insert affiliate link"
      );
    }
  }

  logger.info({ job: "affiliate", ...stats }, "affiliate job finished");
}

function buildAffiliateUrl(originalUrl: string): string | null {
  if (!AFFILIATE_BASE) return null;
  try {
    const base = new URL(AFFILIATE_BASE);
    base.searchParams.set("redirect", originalUrl);
    if (TRACKING_ID) {
      base.searchParams.set("tracking_id", TRACKING_ID);
    }
    return base.toString();
  } catch {
    return null;
  }
}

main().catch((error) => {
  logger.error({ job: "affiliate", error }, "affiliate job failed unexpectedly");
  process.exitCode = 1;
});
