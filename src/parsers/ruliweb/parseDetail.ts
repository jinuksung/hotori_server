// 역할: 루리웹 상세 HTML을 구조화된 딜 데이터로 파싱한다.

import * as cheerio from "cheerio";
import { normalizeUrl } from "../../utils/url";

const BASE_URL = "https://bbs.ruliweb.com";
const RULIWEB_HOST_SUFFIX = "ruliweb.com";
const SOURCE_LABEL = "출처";

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

const PRICE_CURRENCY_RE = /(원|윈|달러|usd|krw|₩|\$)/i;

// 역할: 제목에서 가격/배송 정보를 추출한다(괄호/슬래시 패턴 포함).
function extractPriceShippingFromTitle(title: string): {
  priceText?: string;
  shippingText?: string;
} {
  let priceText: string | undefined;
  let shippingText: string | undefined;

  for (const chunk of extractParenTexts(title)) {
    const parsed = parsePriceShippingChunk(chunk);
    if (!priceText && parsed.priceText) priceText = parsed.priceText;
    if (!shippingText && parsed.shippingText) shippingText = parsed.shippingText;
  }

  if (!priceText || !shippingText) {
    const slashParsed = extractSlashPriceShipping(title);
    if (slashParsed) {
      if (!priceText && slashParsed.priceText) priceText = slashParsed.priceText;
      if (!shippingText && slashParsed.shippingText)
        shippingText = slashParsed.shippingText;
    }
  }

  if (!priceText) {
    const inlinePrice = findLastPriceToken(title);
    if (inlinePrice) priceText = inlinePrice;
  }

  return { priceText, shippingText };
}

// 역할: 괄호 텍스트에서 가격/배송을 판별한다.
function parsePriceShippingChunk(chunk: string): {
  priceText?: string;
  shippingText?: string;
} {
  const normalized = chunk.trim();
  if (!normalized) return {};

  const slashParsed = extractSlashPriceShipping(normalized);
  if (slashParsed) return slashParsed;

  if (looksLikePriceToken(normalized)) {
    return { priceText: normalized };
  }

  if (looksLikeShippingToken(normalized)) {
    return { shippingText: normalized };
  }

  return {};
}

// 역할: "가격/배송비" 형태를 파싱한다(슬래시 주변 공백 포함).
function extractSlashPriceShipping(text: string): {
  priceText?: string;
  shippingText?: string;
} | null {
  const match = text.match(
    /(\d[\d,]*(?:\.\d+)?)(?:\s*(?:원|윈|달러|usd|krw|₩|\$))?\s*[/／]\s*(\d[\d,]*(?:\.\d+)?|무료|무배|free|0)(?:\s*원)?/i,
  );
  if (!match) return null;

  const priceToken = match[1].trim();
  const priceDigits = priceToken.replace(/[^0-9]/g, "");
  if (!priceDigits) return null;
  if (!priceToken.includes(",") && priceDigits.length < 3) return null;

  const shippingToken = match[2].trim();
  const shippingText = normalizeShippingToken(shippingToken);

  return {
    priceText: priceToken,
    shippingText: shippingText ?? undefined,
  };
}

// 역할: 가격으로 보이는 토큰인지 판별한다.
function looksLikePriceToken(token: string): boolean {
  return /\d/.test(token) && PRICE_CURRENCY_RE.test(token);
}

// 역할: 배송으로 보이는 토큰인지 판별한다.
function looksLikeShippingToken(token: string): boolean {
  return /(배송|무료|무배|유료|착불|shipping)/i.test(token);
}

// 역할: 배송 토큰을 표준 텍스트로 정리한다.
function normalizeShippingToken(token: string): string | null {
  const normalized = token.trim();
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  if (lower === "0" || lower.includes("무료") || lower.includes("무배") || lower.includes("free")) {
    return "무료";
  }
  const digits = normalized.replace(/[^0-9]/g, "");
  if (digits) return `${digits}원`;
  return normalized;
}

// 역할: 제목 전체에서 마지막 가격 토큰을 찾는다.
function findLastPriceToken(title: string): string | undefined {
  const pattern =
    /(?:원|윈|달러|usd|krw|₩|\$)\s*\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*(?:원|윈|달러|usd|krw|₩|\$)/gi;
  let last: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(title))) {
    last = match[0].trim();
  }
  return last;
}

// 역할: 루리웹 리다이렉트 링크를 원본 링크로 복원한다.
function unwrapRuliwebRedirectUrl(input?: string | null): string | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  if (trimmed === "#" || trimmed.startsWith("#")) return undefined;
  if (trimmed.toLowerCase().startsWith("javascript:")) return undefined;
  if (trimmed.toLowerCase().startsWith("mailto:")) return undefined;
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

// 역할: 외부 링크인지 판단한다.
function isExternalUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return !hostname.endsWith(RULIWEB_HOST_SUFFIX);
  } catch {
    return false;
  }
}

// 역할: 후보 URL을 정규화하고 유효한 경우만 반환한다.
function normalizeCandidateUrl(href?: string | null): string | undefined {
  if (!href) return undefined;
  return unwrapRuliwebRedirectUrl(href);
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
    .map((href) => normalizeCandidateUrl(href))
    .filter((href): href is string => !!href);

  const unique = Array.from(new Set(links));
  const external = unique.filter((href) => isExternalUrl(href));
  return external.length > 0 ? external : unique;
}

// 역할: "출처" 영역에서 링크를 추출한다.
function extractSourceLink($: cheerio.CheerioAPI): string | undefined {
  const candidates: string[] = [];

  const sourceSelectors = [
    ".source",
    ".source_area",
    ".source_info",
    ".source_box",
    ".source_url",
    ".source_link",
    ".article_source",
    ".source_wrap",
  ];

  for (const selector of sourceSelectors) {
    $(selector)
      .find("a[href]")
      .each((_, el) => {
        const href = $(el).attr("href");
        const normalized = normalizeCandidateUrl(href);
        if (normalized) candidates.push(normalized);
      });
  }

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const parentText = normalizeText($(el).parent().text());
    const containerText = normalizeText(
      $(el).closest("div, p, li, dd, dt, span").text(),
    );
    if (parentText.includes(SOURCE_LABEL) || containerText.includes(SOURCE_LABEL)) {
      const normalized = normalizeCandidateUrl(href);
      if (normalized) candidates.push(normalized);
    }
  });

  const unique = Array.from(new Set(candidates));
  const external = unique.find((href) => isExternalUrl(href));
  return external ?? unique[0];
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
  const parsedPriceShipping = title
    ? extractPriceShippingFromTitle(title)
    : { priceText: undefined, shippingText: undefined };
  const price = parsedPriceShipping.priceText;
  const shipping = parsedPriceShipping.shippingText;

  const bracketTexts = subjectInner ? extractBracketText(subjectInner) : [];
  const mall = bracketTexts.length > 0 ? bracketTexts[0] : undefined;

  const outboundLinks = extractOutboundLinks($);
  const sourceLink = extractSourceLink($);
  const dealUrl = sourceLink ?? outboundLinks[0];

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
