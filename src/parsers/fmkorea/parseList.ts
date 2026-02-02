import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";

const BASE_URL = "https://www.fmkorea.com";

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string; issues?: string[] } };

export type FmkoreaListItem = {
  source: "fmkorea";
  sourcePostId: string;
  postUrl: string;
  title: string;
  thumbUrl: string | null;
  sourceCategoryKey: string | null;
  sourceCategoryName: string | null;
  shopText: string | null;
  priceText: string | null;
  shippingText: string | null;
  commentCount: number | null;
};

export type FmkoreaListResult = {
  items: FmkoreaListItem[];
};

function toAbsoluteUrl(href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed, BASE_URL).toString();
  } catch {
    return null;
  }
}

function extractPostIdFromHref(href: string): string | null {
  const numericPathMatch = href.match(/\/(\d{3,})/);
  if (numericPathMatch) return numericPathMatch[1];
  const url = toAbsoluteUrl(href);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const docSrl = parsed.searchParams.get("document_srl");
    return docSrl && /^\d+$/.test(docSrl) ? docSrl : null;
  } catch {
    return null;
  }
}

function parseCategoryInfo($item: cheerio.Cheerio<AnyNode>) {
  const primary = $item
    .find('.category a[data-category_srl], .category a[href*="category="]')
    .first();
  const fallback =
    primary.length > 0
      ? primary
      : $item
          .find('a[data-category_srl], a[href*="category="]')
          .first();
  const categoryLink = fallback;
  // console.log("categoryLink", categoryLink);
  const href = categoryLink.attr("href");
  const dataCategory = categoryLink.attr("data-category_srl");
  let sourceCategoryKey: string | null = dataCategory?.trim() || null;
  if (!sourceCategoryKey && href) {
    const absolute = toAbsoluteUrl(href);
    if (absolute) {
      try {
        const parsed = new URL(absolute);
        sourceCategoryKey =
          parsed.searchParams.get("category") ??
          parsed.searchParams.get("category_srl");
        console.log("sourceCategoryKey", sourceCategoryKey);
      } catch {
        sourceCategoryKey = null;
      }
    }
  }
  const sourceCategoryName = categoryLink.text().trim() || null;
  return { sourceCategoryKey, sourceCategoryName };
}

function parseCommentCount($item: cheerio.Cheerio<AnyNode>): number | null {
  const text = $item.find("span.comment_count").first().text();
  const match = text.match(/\[(\d+)\]/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function parseHotdealInfo($item: cheerio.Cheerio<AnyNode>) {
  const info = $item.find(".hotdeal_info a.strong");
  const shopText = info.eq(0).text().trim() || null;
  const priceText = info.eq(1).text().trim() || null;
  const shippingText = info.eq(2).text().trim() || null;
  return {
    shopText: shopText || null,
    priceText: priceText || null,
    shippingText: shippingText || null,
  };
}

export function parseFmHotdealList(html: string): Result<FmkoreaListResult> {
  try {
    const $ = cheerio.load(html);
    const items: FmkoreaListItem[] = [];

    const listItems = $("div.fm_best_widget._bd_pc > ul > li").toArray();
    for (const li of listItems) {
      const $item = $(li);
      const link = $item.find('h3.title a[href^="/"]').first();
      const href = link.attr("href");
      if (!href) continue;

      const postUrl = toAbsoluteUrl(href);
      if (!postUrl) continue;

      const sourcePostId = extractPostIdFromHref(href);
      if (!sourcePostId) continue;

      const title =
        link.find(".ellipsis-target").first().text().trim() ||
        link.text().trim();
      if (!title) continue;

      const thumbRaw = $item.find("img.thumb").attr("data-original") || null;
      const thumbUrl = thumbRaw ? toAbsoluteUrl(thumbRaw) : null;

      const { sourceCategoryKey, sourceCategoryName } =
        parseCategoryInfo($item);
      const { shopText, priceText, shippingText } = parseHotdealInfo($item);
      const commentCount = parseCommentCount($item);

      items.push({
        source: "fmkorea",
        sourcePostId,
        postUrl,
        title,
        thumbUrl,
        sourceCategoryKey,
        sourceCategoryName,
        shopText,
        priceText,
        shippingText,
        commentCount,
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
