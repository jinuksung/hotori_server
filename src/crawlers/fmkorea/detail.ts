// src/crawlers/fmkorea/detail.ts
import "dotenv/config";
import Bottleneck from "bottleneck";
import { chromium, type BrowserContext } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import type { Result } from "../../types";
import { normalizeUrl } from "../../utils/url";
import crypto from "node:crypto";

const DEBUG_DIR = path.resolve(process.cwd(), ".debug", "fmkorea_detail");

function safeName(input: string) {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

async function dumpDebugArtifacts(params: {
  tag: string;
  url: string;
  html?: string;
  screenshotPng?: Buffer;
  extra?: Record<string, unknown>;
}) {
  const { tag, url, html, screenshotPng, extra } = params;

  await fs.mkdir(DEBUG_DIR, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const hash = crypto.createHash("md5").update(url).digest("hex").slice(0, 8);
  const base = `${ts}_${safeName(tag)}_${hash}`;

  const writes: string[] = [];

  if (html) {
    const p = path.join(DEBUG_DIR, `${base}.html`);
    await fs.writeFile(p, html, "utf8");
    writes.push(p);
  }
  if (screenshotPng) {
    const p = path.join(DEBUG_DIR, `${base}.png`);
    await fs.writeFile(p, screenshotPng);
    writes.push(p);
  }
  if (extra) {
    const p = path.join(DEBUG_DIR, `${base}.json`);
    await fs.writeFile(p, JSON.stringify({ url, ...extra }, null, 2), "utf8");
    writes.push(p);
  }

  console.log("[DEBUG] artifacts saved:", writes.length ? writes : "(nothing)");
  console.log("[DEBUG] DEBUG_DIR =", DEBUG_DIR);
}

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

async function loadDetailHtml(
  context: BrowserContext,
  url: string,
  options: { timeout: number; waitUntil: LoadState; contentSelector: string },
): Promise<string> {
  const page = await context.newPage();

  // 🔥 dump가 호출되는지 1차 확인용
  console.log("[DEBUG] loadDetailHtml start:", url);
  console.log("[DEBUG] DEBUG_DIR =", DEBUG_DIR);

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

    // ✅ 성공 케이스도 덤프 (최초 1~2번만 보고 싶으면 조건 걸어도 됨)
    const png = await page
      .screenshot({ type: "png", fullPage: true })
      .catch(() => undefined);

    await dumpDebugArtifacts({
      tag: "OK",
      url,
      html,
      screenshotPng: png,
      extra: {
        title: await page.title().catch(() => ""),
        finalUrl: page.url(),
      },
    });

    return html;
  } catch (err) {
    // ✅ 실패 케이스 덤프
    const png = await page
      .screenshot({ type: "png", fullPage: true })
      .catch(() => undefined);
    const html = await page.content().catch(() => undefined);

    await dumpDebugArtifacts({
      tag: "FAIL",
      url,
      html,
      screenshotPng: png,
      extra: {
        error: err instanceof Error ? err.message : String(err),
        title: await page.title().catch(() => ""),
        finalUrl: page.url(),
      },
    });

    throw err;
  } finally {
    await page.close();
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
      if (attempt === maxAttempts) break;

      // ✅ 재시도 간 짧게 숨 고르기
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  return { ok: false, error: { message: formatError(lastError) } };
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Unknown crawler error";
}

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

function makeDocumentUrl(docId: string, baseUrl: string): string {
  try {
    return new URL(`/${docId}`, baseUrl).toString();
  } catch {
    return `${baseUrl.replace(/\/+$/, "")}/${docId}`;
  }
}

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
