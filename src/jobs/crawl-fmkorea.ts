// 역할: FM코리아 전용 크롤링 엔트리.
// src/jobs/crawl-fmkorea.ts
import "dotenv/config";
import pino from "pino";

import { crawlFmkorea } from "./sources/fmkorea";

console.log("[BOOT] crawl-fmkorea.ts loaded", new Date().toISOString());

const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";
const logger = pino({ level: LOG_LEVEL });

// 역할: FM코리아 크롤러를 실행하고 결과를 로그로 남긴다.
async function main() {
  logger.info({ job: "crawl:fmkorea" }, "crawl fmkorea job started");
  console.log("[INFO] crawl fmkorea job started");

  const stats = await crawlFmkorea();

  logger.info({ job: "crawl:fmkorea", ...stats }, "crawl fmkorea job finished");
  console.log("[DONE]", stats);
}

main().catch((error) => {
  logger.error({ job: "crawl:fmkorea", error }, "crawl fmkorea job failed unexpectedly");
  console.log("[FATAL] crawl fmkorea job failed", error);
  process.exitCode = 1;
});
