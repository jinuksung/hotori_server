// 역할: 루리웹 상세 페이지 HTML을 수집하는 크롤러.

import "dotenv/config";
import Bottleneck from "bottleneck";
import { chromium, type BrowserContext } from "playwright";
import type { Result } from "../../types";
import { normalizeUrl } from "../../utils/url";

type LoadState = "load" | "domcontentloaded" | "networkidle" | "commit";

export type DetailTarget = {
  sourcePostId: string;
  postUrl: string;
};

export type DetailSuccess = DetailTarget & { html: string };
export type DetailFailure = DetailTarget & { error: string };

export type DetailCrawlResult = {
  successes: DetailSuccess[];
  failures: DetailFailure[];
};

type DetailCrawlerOptions = {
  headless?: boolean;
  timeoutMs?: number;
  waitUntil?: LoadState;
  maxRetries?: number;
  baseUrl?: string;
  contentSelector?: string;
};

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_URL = "https://bbs.ruliweb.com";

// ✅ 상세는 동시성/속도를 낮게 (환경변수로 제어)
const MAX_CONCURRENCY = Number(process.env.RULIWEB_DETAIL_CONCURRENCY ?? "2");
const MIN_TIME_MS = Number(process.env.RULIWEB_DETAIL_MIN_TIME_MS ?? "500");

const DEFAULT_CONTENT_SELECTOR =
  "[itemprop=\"articleBody\"], .view_content, .view_content.autolink";

// 역할: 상세 페이지들을 동시성 제한과 재시도로 수집한다.
export async function fetchRuliwebDetailHtmls(
  targets: DetailTarget[],
  options: DetailCrawlerOptions = {},
): Promise<DetailCrawlResult> {
  if (targets.length === 0) return { successes: [], failures: [] };

  const limiter = new Bottleneck({
    maxConcurrent: MAX_CONCURRENCY,
    minTime: MIN_TIME_MS,
  });

  const baseUrl = (
    options.baseUrl ??
    process.env.RULIWEB_BASE_URL ??
    DEFAULT_BASE_URL
  ).trim();

  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const headless = options.headless ?? true;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const waitUntil: LoadState = options.waitUntil ?? "domcontentloaded";
  const contentSelector = options.contentSelector ?? DEFAULT_CONTENT_SELECTOR;

  const browser = await chromium.launch({ headless });
  let context: BrowserContext | null = null;

  try {
    context = await browser.newContext({
      userAgent: USER_AGENT,
      locale: "ko-KR",
      viewport: DEFAULT_VIEWPORT,
    });

    context.setDefaultTimeout(Math.min(30_000, timeout));
    context.setDefaultNavigationTimeout(timeout);

    await context.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "font" || t === "media") return route.abort();
      return route.continue();
    });

    const activeContext = context;

    const tasks = targets.map((target) =>
      limiter.schedule(async () => {
        const normalized = normalizeUrl(target.postUrl, baseUrl) ?? target.postUrl;

        const result = await runWithRetries(maxRetries, () =>
          loadDetailHtml(activeContext, normalized, {
            timeout,
            waitUntil,
            contentSelector,
          }),
        );

        if (result.ok) {
          return {
            kind: "success" as const,
            data: { ...target, postUrl: normalized, html: result.data },
          };
        }

        return {
          kind: "failure" as const,
          error: {
            ...target,
            postUrl: normalized,
            error: result.error.message,
          },
        };
      }),
    );

    const settled = await Promise.all(tasks);

    const successes = settled
      .filter(
        (item): item is { kind: "success"; data: DetailSuccess } =>
          item.kind === "success",
      )
      .map((item) => item.data);

    const failures = settled
      .filter(
        (item): item is { kind: "failure"; error: DetailFailure } =>
          item.kind === "failure",
      )
      .map((item) => item.error);

    return { successes, failures };
  } finally {
    await limiter.stop();
    if (context) await context.close();
    await browser.close();
  }
}

// 역할: 단일 상세 페이지의 HTML을 로드하고 로그를 남긴다.
async function loadDetailHtml(
  context: BrowserContext,
  url: string,
  options: { timeout: number; waitUntil: LoadState; contentSelector: string },
): Promise<string> {
  const page = await context.newPage();

  try {
    await page.goto(url, {
      waitUntil: options.waitUntil,
      timeout: options.timeout,
    });

    await page
      .waitForSelector(options.contentSelector, {
        timeout: Math.min(15_000, options.timeout),
      })
      .catch(() => {});

    const html = await page.content();
    console.log("[DETAIL] fetched", { url, finalUrl: page.url() });
    return html;
  } catch (err) {
    console.log("[DETAIL] fetch failed", {
      url,
      finalUrl: page.url(),
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    await page.close();
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
