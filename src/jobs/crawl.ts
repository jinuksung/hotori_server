// src/jobs/crawl.ts
import "dotenv/config";
import pino from "pino";

import { crawlFmkorea } from "./sources/fmkorea";

console.log("[BOOT] crawl.ts loaded", new Date().toISOString());

const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";
const logger = pino({ level: LOG_LEVEL });

async function main() {
  logger.info({ job: "crawl:all" }, "crawl all job started");
  console.log("[INFO] crawl all job started");

  const stats = await crawlFmkorea();

  logger.info({ job: "crawl:all", source: "fmkorea", ...stats }, "crawl all job finished");
  console.log("[DONE]", { source: "fmkorea", ...stats });
}

main().catch((error) => {
  logger.error({ job: "crawl:all", error }, "crawl all job failed unexpectedly");
  console.log("[FATAL] crawl all job failed", error);
  process.exitCode = 1;
});
