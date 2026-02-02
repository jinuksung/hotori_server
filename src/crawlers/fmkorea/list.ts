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

export async function fetchFmkoreaHotdealListHtml(
  options: FetchListOptions = {},
): Promise<Result<string>> {
  const listUrl = buildListUrl(options.baseUrl);
  const retries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

  return runWithRetries(retries, async () => {
    const context = await createContext(options.headless);
    try {
      const page = await context.newPage();
      await page.goto(listUrl, {
        waitUntil: options.waitUntil ?? "domcontentloaded",
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      const html = await page.content();
      return html;
    } finally {
      await closeContext(context);
    }
  });
}

async function createContext(headless?: boolean): Promise<BrowserContext> {
  const browser = await chromium.launch({ headless: headless ?? true });
  return browser.newContext({
    userAgent: USER_AGENT,
    locale: "ko-KR",
    viewport: DEFAULT_VIEWPORT,
  });
}

async function closeContext(context: BrowserContext) {
  const browser = context.browser();
  await context.close();
  if (browser) {
    await browser.close();
  }
}

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

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown crawler error";
}
