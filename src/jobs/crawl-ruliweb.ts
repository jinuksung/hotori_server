// 역할: 루리웹 크롤링 엔트리 실행 파일.

import pino from "pino";
import { crawlRuliweb } from "./sources/ruliweb";

console.log("[BOOT] crawl-ruliweb.ts loaded", new Date().toISOString());

const LOG_LEVEL = process.env.LOG_LEVEL ?? "info";
const logger = pino({ level: LOG_LEVEL });

// 역할: 루리웹 크롤링을 실행하고 결과를 출력한다.
async function main() {
  const stats = await crawlRuliweb();
  console.log("[DONE]", stats);
}

main().catch((error) => {
  logger.error({ job: "crawl:ruliweb", error }, "crawl ruliweb job failed");
  console.log("[FATAL] crawl ruliweb failed", error);
  process.exitCode = 1;
});
