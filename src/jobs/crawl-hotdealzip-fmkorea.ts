import "dotenv/config";
import pino from "pino";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { crawlHotdealzipFmkorea } from "./sources/hotdealzip-fmkorea";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
const execFileAsync = promisify(execFile);

async function main() {
  logger.info({ job: "crawl:hotdealzip_fmkorea" }, "crawl hotdealzip_fmkorea job started");
  const stats = await crawlHotdealzipFmkorea();
  try {
    await execFileAsync("npx", ["tsx", "scripts/resolveStructuredLinks.ts"], {
      cwd: process.cwd(),
      env: process.env,
    });
    await execFileAsync("npx", ["tsx", "scripts/resolveRedirectLinks.ts"], {
      cwd: process.cwd(),
      env: process.env,
    });
  } catch (error) {
    logger.warn({ job: "crawl:hotdealzip_fmkorea", error }, "post-crawl link resolve failed");
  }
  console.log("[DONE]", stats);
}

main().catch((error) => {
  logger.error({ job: "crawl:hotdealzip_fmkorea", error }, "crawl hotdealzip_fmkorea failed unexpectedly");
  console.log("[FATAL] crawl hotdealzip_fmkorea failed", error);
  process.exitCode = 1;
});
