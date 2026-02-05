// 역할: 원본 썸네일 URL을 Supabase Storage에 캐시하고 접근 URL(서명/공개)을 반환한다.

import "dotenv/config";
import { createHash } from "crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL?.trim() ?? "";
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
const SUPABASE_STORAGE_BUCKET =
  process.env.SUPABASE_STORAGE_BUCKET?.trim() ?? "";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36";
const SIGNED_URL_EXPIRES_IN = 60 * 60 * 24 * 30; // 30 days

let cachedClient: SupabaseClient | null = null;

export type ThumbnailCacheResult =
  | { ok: true; publicUrl: string; path: string }
  | { ok: false; reason: string; status?: number };

export type ThumbnailCacheInput = {
  source: string;
  sourcePostId: string;
  sourceUrl: string | null;
};

// 역할: Supabase 클라이언트를 반환하거나 설정이 없으면 null을 반환한다.
function getSupabaseClient(): SupabaseClient | null {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_STORAGE_BUCKET) {
    return null;
  }
  if (!cachedClient) {
    cachedClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
  }
  return cachedClient;
}

// 역할: 썸네일 URL을 캐시하고 접근 가능한 URL(서명/공개)을 반환한다.
export async function cacheThumbnail(
  input: ThumbnailCacheInput,
): Promise<ThumbnailCacheResult> {
  if (!input.sourceUrl) {
    return { ok: false, reason: "source_url_missing" };
  }

  const supabase = getSupabaseClient();
  if (!supabase) {
    return { ok: false, reason: "supabase_not_configured" };
  }

  const referer = resolveReferer(input.sourceUrl);
  const response = await fetch(input.sourceUrl, {
    headers: {
      "User-Agent": DEFAULT_USER_AGENT,
      Accept: "image/*,*/*;q=0.8",
      ...(referer ? { Referer: referer } : {}),
    },
  });

  if (!response.ok) {
    return { ok: false, reason: "fetch_failed", status: response.status };
  }

  const contentTypeRaw = response.headers.get("content-type") ?? "";
  const contentType = contentTypeRaw.split(";")[0].trim();
  if (contentType && !contentType.startsWith("image/")) {
    return { ok: false, reason: "not_image" };
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) {
    return { ok: false, reason: "empty_body" };
  }

  const ext =
    extFromContentType(contentType) ??
    extFromUrl(input.sourceUrl) ??
    "jpg";

  const hash = createHash("sha1")
    .update(input.sourceUrl)
    .digest("hex")
    .slice(0, 12);

  const path = [
    "thumbnails",
    sanitizePathSegment(input.source),
    sanitizePathSegment(input.sourcePostId),
    `${hash}.${ext}`,
  ].join("/");

  const { error } = await supabase.storage
    .from(SUPABASE_STORAGE_BUCKET)
    .upload(path, buffer, {
      upsert: true,
      contentType: contentType || "image/jpeg",
    });

  if (error) {
    return { ok: false, reason: `upload_failed:${error.message}` };
  }

  const { data, error: signedError } = await supabase.storage
    .from(SUPABASE_STORAGE_BUCKET)
    .createSignedUrl(path, SIGNED_URL_EXPIRES_IN);

  if (signedError) {
    return { ok: false, reason: `signed_url_failed:${signedError.message}` };
  }

  if (!data?.signedUrl) {
    return { ok: false, reason: "signed_url_missing" };
  }

  return { ok: true, publicUrl: data.signedUrl, path };
}

// 역할: referer 헤더를 결정한다.
function resolveReferer(url: string): string | undefined {
  try {
    const hostname = new URL(url).hostname;
    if (hostname.endsWith("ruliweb.com")) return "https://bbs.ruliweb.com";
    if (hostname.endsWith("fmkorea.com")) return "https://www.fmkorea.com";
    return undefined;
  } catch {
    return undefined;
  }
}

// 역할: 경로 세그먼트를 안전한 문자열로 변환한다.
function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

// 역할: content-type에서 확장자를 추출한다.
function extFromContentType(contentType: string): string | null {
  const type = contentType.toLowerCase();
  if (type === "image/jpeg") return "jpg";
  if (type === "image/jpg") return "jpg";
  if (type === "image/png") return "png";
  if (type === "image/webp") return "webp";
  if (type === "image/gif") return "gif";
  if (type === "image/avif") return "avif";
  if (type === "image/svg+xml") return "svg";
  return null;
}

// 역할: URL에서 확장자를 추출한다.
function extFromUrl(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split(".").pop();
    if (!ext) return null;
    const trimmed = ext.toLowerCase();
    if (trimmed.length < 2 || trimmed.length > 5) return null;
    if (!/^[a-z0-9]+$/.test(trimmed)) return null;
    return trimmed;
  } catch {
    return null;
  }
}
