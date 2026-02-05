// 역할: FM코리아 핫딜 리스트 페이지 HTML을 수집하는 크롤러.

import "dotenv/config";
import { chromium, type BrowserContext } from "playwright";
import type { Result } from "../../types";

type LoadState = "load" | "domcontentloaded" | "networkidle" | "commit";

type FetchListOptions = {
  baseUrl?: string;
  headless?: boolean;
  timeoutMs?: number;
  waitUntil?: LoadState;
  maxRetries?: number;
};

const DEFAULT_BASE_URL = "https://www.fmkorea.com";
const LIST_PATH = "/hotdeal";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_RETRIES = 3;
const BLOCK_HINTS = [
  "captcha",
  "cloudflare",
  "access denied",
  "robot",
  "봇",
  "차단",
  "접근",
  "권한",
];

// 역할: 핫딜 리스트 페이지의 HTML을 가져온다(재시도 포함).
export async function fetchFmkoreaHotdealListHtml(
  options: FetchListOptions = {},
): Promise<Result<string>> {
  const listUrl = buildListUrl(options.baseUrl);
  const retries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  return runWithRetries(retries, async () => {
    const context = await createContext(options.headless);
    try {
      const page = await context.newPage();
      await page.waitForTimeout(1200 + Math.random() * 1800);
      await page.goto(listUrl, {
        waitUntil: options.waitUntil ?? "domcontentloaded",
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      const html = await page.content();
      const title = await page.title().catch(() => "");
      const finalUrl = page.url();
      console.log("[LIST] fetched", {
        url: listUrl,
        finalUrl,
        title,
        htmlLength: html.length,
      });
      if (looksBlocked(html)) {
        console.log("[LIST] possible block detected", { finalUrl, title });
      }
      return html;
    } finally {
      await closeContext(context);
    }
  });
}

// 역할: Playwright 브라우저 컨텍스트를 생성한다.
async function createContext(headless?: boolean): Promise<BrowserContext> {
  const browser = await chromium.launch({ headless: true });
  return browser.newContext({
    userAgent: USER_AGENT,
    locale: "ko-KR",
    viewport: DEFAULT_VIEWPORT,
    timezoneId: "Asia/Seoul",
  });
}

// 역할: 컨텍스트와 브라우저를 안전하게 종료한다.
async function closeContext(context: BrowserContext) {
  const browser = context.browser();
  await context.close();
  if (browser) {
    await browser.close();
  }
}

// 역할: 베이스 URL 기준으로 리스트 페이지 URL을 구성한다.
function buildListUrl(baseUrl?: string) {
  const root = (
    baseUrl ??
    process.env.FMKOREA_BASE_URL ??
    DEFAULT_BASE_URL
  ).trim();
  try {
    return new URL(LIST_PATH, root).toString();
  } catch {
    return new URL(LIST_PATH, DEFAULT_BASE_URL).toString();
  }
}

// 역할: 최대 시도 횟수 내에서 작업을 재시도한다.
async function runWithRetries<T>(
  maxAttempts: number,
  task: () => Promise<T>,
): Promise<Result<T>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const data = await task();
      return { ok: true, data };
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) {
        break;
      }
    }
  }
  return { ok: false, error: { message: formatError(lastError) } };
}

// 역할: 에러를 사용자 친화적인 문자열로 정리한다.
function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown crawler error";
}

// 역할: HTML에서 차단/캡차 징후를 감지한다.
function looksBlocked(html: string): boolean {
  const lowered = html.toLowerCase();
  return BLOCK_HINTS.some((hint) => lowered.includes(hint));
}
