import "dotenv/config";
import pino from "pino";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { crawlPpomppu } from "./sources/ppomppu";

console.log("[BOOT] crawl-ppomppu.ts loaded", new Date().toISOString());

const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";
const logger = pino({ level: LOG_LEVEL });
const execFileAsync = promisify(execFile);

async function main() {
  logger.info({ job: "crawl:ppomppu" }, "crawl ppomppu job started");
  console.log("[INFO] crawl ppomppu job started");

  const stats = await crawlPpomppu();

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
    logger.warn({ job: "crawl:ppomppu", error }, "post-crawl link resolve failed");
  }

  logger.info({ job: "crawl:ppomppu", ...stats }, "crawl ppomppu job finished");
  console.log("[DONE]", stats);
}

main().catch((error) => {
  logger.error({ job: "crawl:ppomppu", error }, "crawl ppomppu job failed unexpectedly");
  console.log("[FATAL] crawl ppomppu job failed", error);
  process.exitCode = 1;
});
