import pino from "pino";
import { listDealsForSubcategory, updateDeal } from "../db/repos/deals.repo";
import { withTx } from "../db/client";
import { inferSubcategory } from "../parsers/common/inferSubcategory";
import { stripShopPrefix } from "./pipelineHelpers";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
const BATCH_SIZE = Number(process.env.REFRESH_SUBCATEGORY_BATCH_SIZE ?? "200");

type RefreshStats = {
  scanned: number;
  updated: number;
};

async function main() {
  logger.info(
    { job: "refresh:subcategory", batchSize: BATCH_SIZE },
    "refreshSubcategory job started"
  );

  let lastId = 0;
  const stats: RefreshStats = { scanned: 0, updated: 0 };

  while (true) {
    const rows = await withTx((client) =>
      listDealsForSubcategory(lastId, BATCH_SIZE, client),
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      const baseTitle = row.sourceTitle ?? row.title;
      const title = stripShopPrefix(baseTitle);
      const nextSubcategory = inferSubcategory(
        row.categoryId,
        title,
        null,
        row.linkDomains
      );

      stats.scanned += 1;
      if ((row.subcategory ?? null) === (nextSubcategory ?? null)) {
        lastId = row.id;
        continue;
      }

      await withTx(async (client) => {
        await updateDeal(
          row.id,
          {
            subcategory: nextSubcategory ?? null,
          },
          client
        );
      });

      stats.updated += 1;
      lastId = row.id;
    }
  }

  logger.info({ job: "refresh:subcategory", ...stats }, "refreshSubcategory job finished");
}

main().catch((error) => {
  logger.error({ job: "refresh:subcategory", error }, "refreshSubcategory job failed unexpectedly");
  process.exitCode = 1;
});
