import "dotenv/config";
import { pool, withTx } from "../src/db/client";
import { listPendingNonAffiliateLinksByDomain, upsertAffiliateLink } from "../src/db/repos/links.repo";
import { createLinkPriceDeepLink } from "../src/utils/linkprice";
import { extractDomain } from "../src/utils/url";

const BATCH_SIZE = Number(process.env.LINKPRICE_BATCH_SIZE ?? "20");

async function main() {
  const candidates = await listPendingNonAffiliateLinksByDomain(
    ["%gmarket%", "%auction%", "%lotteon%"],
    BATCH_SIZE,
  );

  let scanned = 0;
  let updated = 0;
  let failed = 0;

  for (const candidate of candidates) {
    scanned += 1;
    try {
      const affiliateUrl = await createLinkPriceDeepLink(candidate.url);
      const domain = extractDomain(affiliateUrl);
      if (!domain) {
        throw new Error(`invalid affiliate url: ${affiliateUrl}`);
      }

      await withTx(async (client) => {
        await upsertAffiliateLink(
          {
            dealId: candidate.dealId,
            url: affiliateUrl,
            domain,
          },
          client,
        );
      });
      updated += 1;
    } catch (error) {
      failed += 1;
      console.error({ dealId: candidate.dealId, url: candidate.url, error });
    }
  }

  console.log(JSON.stringify({ scanned, updated, failed }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
