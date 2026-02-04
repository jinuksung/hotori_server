// 역할: 루리웹 상세 HTML을 구조화된 딜 데이터로 파싱한다.

import * as cheerio from "cheerio";
import { normalizeUrl } from "../../utils/url";

const BASE_URL = "https://bbs.ruliweb.com";

export type RuliwebDetail = {
  site: "ruliweb";
  board: "hotdeal";
  documentSrl: number;
  url: string;
  canonicalUrl?: string;

  title?: string;
  category?: string;
  sourceCategoryKey?: string;
  sourceCategoryName?: string;
  mall?: string;
  price?: string;
  shipping?: string;
  dealUrl?: string;

  viewCount?: number;
  upvoteCount?: number;
  commentCount?: number;

  ogImage?: string;
  outboundLinks?: string[];
};

// 역할: 공백을 정리해 텍스트를 정규화한다.
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

// 역할: 숫자 문자열을 안전하게 number로 변환한다.
function pickNumber(text?: string | null): number | undefined {
  if (!text) return undefined;
  const value = Number(text.replace(/[^0-9]/g, ""));
  return Number.isFinite(value) ? value : undefined;
}

// 역할: 대괄호로 둘러싸인 텍스트를 추출한다.
function extractBracketText(text: string): string[] {
  return Array.from(text.matchAll(/\[([^\]]+)\]/g)).map((match) => match[1]);
}

// 역할: 제목에서 가격/배송 힌트를 추출한다.
function extractParenTexts(text: string): string[] {
  return Array.from(text.matchAll(/\(([^()]*)\)/g)).map((match) => match[1]);
}

// 역할: 가격으로 보이는 괄호 텍스트를 찾아낸다.
function extractPriceTextFromTitle(title: string): string | undefined {
  for (const chunk of extractParenTexts(title)) {
    const normalized = chunk.trim();
    if (!normalized) continue;
    if (/(원|달러|usd|krw|₩|\$)/i.test(normalized)) return normalized;
  }
  return undefined;
}

// 역할: 배송으로 보이는 괄호 텍스트를 찾아낸다.
function extractShippingTextFromTitle(title: string): string | undefined {
  for (const chunk of extractParenTexts(title)) {
    const normalized = chunk.trim();
    if (!normalized) continue;
    if (/(배송|무료|무배|유료|착불|shipping)/i.test(normalized)) return normalized;
  }
  return undefined;
}

// 역할: 루리웹 리다이렉트 링크를 원본 링크로 복원한다.
function unwrapRuliwebRedirectUrl(input?: string | null): string | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const normalized = normalizeUrl(trimmed, BASE_URL) ?? trimmed;

  try {
    const url = new URL(normalized);
    if (url.hostname === "web.ruliweb.com" && url.pathname === "/link.php") {
      const wrapped = url.searchParams.get("ol");
      if (wrapped) return decodeURIComponent(wrapped);
    }
    return normalized;
  } catch {
    return normalized;
  }
}

// 역할: 상세 HTML에서 외부 링크 목록을 추출한다.
function extractOutboundLinks($: cheerio.CheerioAPI): string[] {
  const content = $("[itemprop=\"articleBody\"]").first();
  if (!content.length) return [];

  const links = content
    .find("a[href]")
    .toArray()
    .map((el) => $(el).attr("href"))
    .filter((href): href is string => !!href)
    .map((href) => unwrapRuliwebRedirectUrl(href))
    .filter((href): href is string => !!href);

  return Array.from(new Set(links));
}

// 역할: 상세 HTML에서 카테고리 키를 추출한다.
function extractCategoryKey(html: string): string | undefined {
  const match = html.match(/\?cate=(\d+)/);
  return match ? match[1] : undefined;
}

// 역할: 상세 페이지 HTML에서 핵심 필드들을 추출한다.
export function parseRuliwebDetail(html: string): RuliwebDetail {
  const $ = cheerio.load(html);

  const canonical = $("link[rel=\"canonical\"]").attr("href")?.trim();
  const ogUrl = $("meta[property=\"og:url\"]").attr("content")?.trim();
  const fallbackUrlMatch = html.match(/\/read\/(\d+)/);
  const effectiveUrl = canonical || ogUrl || "";
  const documentSrlMatch =
    effectiveUrl.match(/\/read\/(\d+)/) ?? fallbackUrlMatch;
  const documentSrl = Number(documentSrlMatch?.[1] ?? 0);

  const subject = $("h4.subject");
  const subjectInner = normalizeText(
    subject.find(".subject_inner_text").first().text(),
  );
  const ogTitle = $("meta[property=\"og:title\"]").attr("content")?.trim();
  const categoryTextRaw = normalizeText(subject.find(".category_text").first().text());
  const category = categoryTextRaw.replace(/[\[\]]/g, "").trim() || undefined;
  const replyCount = pickNumber(subject.find(".reply_count").first().text());

  const title = subjectInner || ogTitle || undefined;
  const price = title ? extractPriceTextFromTitle(title) : undefined;
  const shipping = title ? extractShippingTextFromTitle(title) : undefined;

  const bracketTexts = subjectInner ? extractBracketText(subjectInner) : [];
  const mall = bracketTexts.length > 0 ? bracketTexts[0] : undefined;

  const outboundLinks = extractOutboundLinks($);
  const dealUrl = outboundLinks[0];

  const ogImage = $("meta[property=\"og:image\"]").attr("content")?.trim();

  const metricMatch = html.match(
    /추천\s*([0-9,]+)\s*\|\s*조회\s*([0-9,]+)\s*\|\s*비추력\s*([0-9,]+)/,
  );
  const upvoteCount = pickNumber(metricMatch?.[1]);
  const viewCount = pickNumber(metricMatch?.[2]);

  const sourceCategoryKey = extractCategoryKey(html);

  return {
    site: "ruliweb",
    board: "hotdeal",
    documentSrl,
    url: effectiveUrl,
    canonicalUrl: canonical || undefined,
    title,
    category,
    sourceCategoryKey,
    sourceCategoryName: category,
    mall,
    price,
    shipping,
    dealUrl,
    viewCount,
    upvoteCount,
    commentCount: replyCount,
    ogImage,
    outboundLinks,
  };
}
