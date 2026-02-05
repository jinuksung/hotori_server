// 역할: 루리웹 핫딜 리스트 HTML을 구조화 데이터로 파싱한다.

import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";

const BASE_URL = "https://bbs.ruliweb.com";

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string; issues?: string[] } };

export type RuliwebListItem = {
  source: "ruliweb";
  sourcePostId: string;
  postUrl: string;
  title: string;
  thumbUrl: string | null;
  sourceCategoryKey: string | null;
  sourceCategoryName: string | null;
};

export type RuliwebListResult = {
  items: RuliwebListItem[];
};

// 역할: 상대 URL을 절대 URL로 변환한다.
function toAbsoluteUrl(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed, BASE_URL).toString();
  } catch {
    return null;
  }
}

// 역할: 게시글 링크에서 문서 ID를 추출한다.
function extractPostIdFromHref(href: string): string | null {
  const match = href.match(/\/read\/(\d+)/);
  if (match) return match[1];
  const absolute = toAbsoluteUrl(href);
  if (!absolute) return null;
  try {
    const parsed = new URL(absolute);
    const matchPath = parsed.pathname.match(/\/read\/(\d+)/);
    return matchPath ? matchPath[1] : null;
  } catch {
    return null;
  }
}

// 역할: 카테고리 링크에서 원본 카테고리 키를 추출한다.
function extractCategoryKey(href?: string | null): string | null {
  if (!href) return null;
  const absolute = toAbsoluteUrl(href);
  if (!absolute) return null;
  try {
    const parsed = new URL(absolute);
    const key = parsed.searchParams.get("cate");
    return key ? key.trim() : null;
  } catch {
    return null;
  }
}

// 역할: 공백을 정리해 텍스트를 정규화한다.
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// 역할: 카테고리 텍스트에서 대괄호를 제거하고 정리한다.
function normalizeCategoryName(text: string): string {
  return normalizeText(text).replace(/[\[\]]/g, "").trim();
}

// 역할: 리스트 아이템에서 카테고리 정보를 추출한다.
function parseCategoryInfo($item: cheerio.Cheerio<AnyNode>) {
  const categoryCell = $item.find("td.divsn").first();
  const categoryLink = categoryCell.find("a").first();
  const sourceCategoryName = normalizeCategoryName(categoryCell.text()) || null;
  const sourceCategoryKey = extractCategoryKey(categoryLink.attr("href"));
  return { sourceCategoryKey, sourceCategoryName };
}

// 역할: 리스트 HTML 전체를 순회하며 핫딜 항목들을 추출한다.
export function parseRuliwebHotdealList(html: string): Result<RuliwebListResult> {
  try {
    const $ = cheerio.load(html);
    const items: RuliwebListItem[] = [];

    const rows = $("tr.table_body").toArray();
    for (const row of rows) {
      const $row = $(row);
      const link = $row.find("td.subject a.subject_link").first();
      const href = link.attr("href");
      if (!href) continue;

      const postUrl = toAbsoluteUrl(href);
      if (!postUrl) continue;

      const sourcePostId = extractPostIdFromHref(href);
      if (!sourcePostId) continue;

      const title = normalizeText(link.text());
      if (!title) continue;

      const { sourceCategoryKey, sourceCategoryName } = parseCategoryInfo($row);

      items.push({
        source: "ruliweb",
        sourcePostId,
        postUrl,
        title,
        thumbUrl: null,
        sourceCategoryKey,
        sourceCategoryName,
      });
    }

    return { ok: true, data: { items } };
  } catch (error) {
    return {
      ok: false,
      error: {
        message:
          error instanceof Error ? error.message : "parseList unexpected error",
      },
    };
  }
}
