// 역할: FM코리아 상세 페이지 HTML을 수집하는 크롤러.
// src/crawlers/fmkorea/detail.ts
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
  mobileBaseUrl?: string;
  contentSelector?: string; // 본문 대기 셀렉터
};

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_URL = "https://www.fmkorea.com";
const DEFAULT_MOBILE_BASE_URL = "https://m.fmkorea.com";

// ✅ 상세는 동시성/속도를 낮게 (환경변수로 제어)
const MAX_CONCURRENCY = Number(process.env.FMKOREA_DETAIL_CONCURRENCY ?? "1");
const MIN_TIME_MS = Number(process.env.FMKOREA_DETAIL_MIN_TIME_MS ?? "2500");

// FMKorea 본문 후보 (필요하면 더 좁히기)
const DEFAULT_CONTENT_SELECTOR = "article, .xe_content, .rd_body, #bd_capture";

// 역할: 상세 페이지들을 동시성 제한과 재시도로 수집한다.
export async function fetchFmkoreaDetailHtmls(
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
    process.env.FMKOREA_BASE_URL ??
    DEFAULT_BASE_URL
  ).trim();

  const mobileBaseUrl = (
    options.mobileBaseUrl ??
    process.env.FMKOREA_MOBILE_BASE_URL ??
    DEFAULT_MOBILE_BASE_URL
  ).trim();

  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const headless = options.headless ?? true;
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // ✅ 기본은 domcontentloaded (networkidle 기본 제거)
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

    // ✅ 전역 타임아웃
    context.setDefaultTimeout(Math.min(30_000, timeout));
    context.setDefaultNavigationTimeout(timeout);

    // ✅ 리소스 차단(이미지/폰트/미디어) - 부하/지연 감소
    await context.route("**/*", (route) => {
      const t = route.request().resourceType();
      if (t === "image" || t === "font" || t === "media") return route.abort();
      return route.continue();
    });

    const activeContext = context;

    const tasks = targets.map((target) =>
      limiter.schedule(async () => {
        const urlVariants = buildDetailUrlVariants(
          target.postUrl,
          baseUrl,
          mobileBaseUrl,
        );

        let lastError = "detail fetch failed";

        for (const variant of urlVariants) {
          const result = await runWithRetries(maxRetries, () =>
            loadDetailHtml(activeContext, variant, {
              timeout,
              waitUntil,
              contentSelector,
              // debugKey: target.sourcePostId,
            }),
          );

          if (result.ok) {
            return {
              kind: "success" as const,
              data: { ...target, postUrl: variant, html: result.data },
            };
          }
          lastError = result.error.message;
        }

        return {
          kind: "failure" as const,
          error: {
            ...target,
            postUrl: urlVariants[0] ?? target.postUrl,
            error: lastError,
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

// 역할: 단일 상세 페이지의 HTML을 로드하고 필요 시 디버그 덤프를 남긴다.
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

    return await page.content();
  } finally {
    await page.close();
  }
}

// 역할: 작업을 재시도해 Result 형태로 반환한다.
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
      if (attempt === maxAttempts) break;

      // ✅ 재시도 간 짧게 숨 고르기
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  return { ok: false, error: { message: formatError(lastError) } };
}

// 역할: 에러를 문자열로 정규화한다.
function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown crawler error";
}

// 역할: 상세 URL 후보군(PC/모바일/쿼리)을 구성한다.
function buildDetailUrlVariants(
  postUrl: string,
  baseUrl: string,
  mobileBaseUrl: string,
): string[] {
  const variants: string[] = [];

  const normalized = normalizeUrl(postUrl, baseUrl);
  if (normalized) variants.push(normalized);

  const docId =
    extractDocumentId(normalized ?? postUrl) ??
    extractDocumentId(postUrl) ??
    null;

  if (docId) {
    variants.push(makeDocumentUrl(docId, baseUrl));
    variants.push(makeIndexUrl(docId, baseUrl));
    variants.push(makeDocumentUrl(docId, mobileBaseUrl));
  }

  // dedupe
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const v of variants) {
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    deduped.push(v);
  }

  if (deduped.length === 0) {
    try {
      return [new URL(postUrl, baseUrl).toString()];
    } catch {
      return [postUrl];
    }
  }
  return deduped;
}

// 역할: 상세 URL에서 문서 ID(document_srl)를 추출한다.
function extractDocumentId(url: string): string | null {
  const match = url.match(/\/(\d+)(?:$|\?)/);
  if (match) return match[1];

  try {
    const parsed = new URL(url);
    const fromQuery = parsed.searchParams.get("document_srl");
    if (fromQuery && /^\d+$/.test(fromQuery)) return fromQuery;
  } catch {
    /* ignore */
  }
  return null;
}

// 역할: 문서 ID로 상세 URL을 만든다.
function makeDocumentUrl(docId: string, baseUrl: string): string {
  try {
    return new URL(`/${docId}`, baseUrl).toString();
  } catch {
    return `${baseUrl.replace(/\/+$/, "")}/${docId}`;
  }
}

// 역할: index.php 기반 상세 URL을 만든다.
function makeIndexUrl(docId: string, baseUrl: string): string {
  try {
    const url = new URL("/index.php", baseUrl);
    if (!url.searchParams.has("mid")) url.searchParams.set("mid", "hotdeal");
    url.searchParams.set("document_srl", docId);
    return url.toString();
  } catch {
    return `${baseUrl.replace(/\/+$/, "")}/index.php?mid=hotdeal&document_srl=${docId}`;
  }
}
