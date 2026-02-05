// 역할: 크롤링 파이프라인에서 사용하는 공통 변환/판별 유틸.

import type { ShippingType } from "../types";
// 역할: 구매 링크를 제공할 수 있는 최소 형태 타입.
type PurchaseLinkSource = { dealUrl?: string | null };

// 역할: 딜 제목에서 상점 접두/가격/배송 정보를 제거해 정규화한다.
export function normalizeDealTitle(title: string): string {
  const stripped = stripShopPrefix(title);
  return stripTrailingPriceShipping(stripped);
}

// 역할: 가격 문자열에서 숫자를 추출해 number로 변환한다(범위 표기는 최솟값 사용).
export function parsePrice(text?: string | null): number | null {
  if (!text) return null;
  const normalized = text.replace(/,/g, "");
  const rangeMatch = normalized.match(
    /(\d+(?:\.\d+)?)[\s]*(?:~|〜|～|–|—|-)[\s]*(\d+(?:\.\d+)?)/,
  );
  if (rangeMatch) {
    const first = Number(rangeMatch[1]);
    const second = Number(rangeMatch[2]);
    const value = Number.isFinite(first) && Number.isFinite(second)
      ? Math.min(first, second)
      : Number.isFinite(first)
        ? first
        : Number.isFinite(second)
          ? second
          : NaN;
    return Number.isFinite(value) ? value : null;
  }

  const numberMatch = normalized.match(/(\d+(?:\.\d+)?)/);
  if (!numberMatch) return null;
  const value = Number(numberMatch[1]);
  return Number.isFinite(value) ? value : null;
}

// 역할: 배송 문구/제목을 표준 배송 타입으로 매핑한다.
export function mapShippingType(
  text?: string | null,
  title?: string | null,
  price?: number | null,
): ShippingType {
  const fromText = classifyShippingText(text);
  if (fromText) return fromText;
  const fromTitle = classifyShippingFromTitle(title, price);
  return fromTitle ?? "UNKNOWN";
}

// 역할: 제목/본문에서 품절 여부 키워드를 탐지한다.
export function detectSoldOut(
  ...candidates: Array<string | undefined | null>
): boolean {
  return candidates.some((value) => {
    if (!value) return false;
    const normalized = value.toLowerCase();
    return (
      normalized.includes("품절") ||
      normalized.includes("sold out") ||
      normalized.includes("마감") ||
      normalized.includes("종료")
    );
  });
}

// 역할: 상세 파싱 결과에서 대표 구매 링크를 선택한다.
export function selectPurchaseLink(detail: PurchaseLinkSource): string | null {
  if (detail.dealUrl) {
    return detail.dealUrl;
  }
  return null;
}

// 역할: 제목에서 상점 접두/제휴 표시를 제거한다.
export function stripShopPrefix(title: string): string {
  const withoutPrefix = title.replace(/^\s*\[[^\]]+\]\s*/u, "").trim();
  return withoutPrefix.replace(/\s*\[[^\]]*제휴\s*링크[^\]]*\]\s*$/u, "").trim();
}

// 역할: 제목 끝의 가격/배송 정보 괄호를 제거한다.
function stripTrailingPriceShipping(title: string): string {
  let result = title.trim();
  while (true) {
    const match = result.match(/\s*\(([^()]*)\)\s*$/);
    if (!match || match.index === undefined) break;
    const inner = match[1].trim().toLowerCase();
    if (looksLikePrice(inner) || looksLikeShipping(inner)) {
      result = result.slice(0, match.index).trim();
      continue;
    }
    break;
  }
  return result;
}

// 역할: 괄호 내부 텍스트가 가격 표현인지 판단한다.
function looksLikePrice(inner: string): boolean {
  const hasDigit = /\d/.test(inner);
  const hasCurrency =
    inner.includes("원") ||
    inner.includes("윈") ||
    inner.includes("만원") ||
    inner.includes("달러") ||
    inner.includes("usd") ||
    inner.includes("krw") ||
    inner.includes("₩") ||
    inner.includes("$");
  if (hasDigit && hasCurrency) return true;
  return looksLikePriceShippingSlash(inner);
}

// 역할: 괄호 내부 텍스트가 배송 표현인지 판단한다.
function looksLikeShipping(inner: string): boolean {
  return (
    inner.includes("무료") ||
    inner.includes("무배") ||
    inner.includes("유료") ||
    inner.includes("배송") ||
    inner.includes("착불") ||
    inner.includes("직배") ||
    inner.includes("shipping")
  );
}

// 역할: "가격/배송비" 형태인지 판단한다.
function looksLikePriceShippingSlash(inner: string): boolean {
  const match = inner.match(
    /(\d[\d,]*(?:\.\d+)?)(?:\s*(?:원|윈|달러|usd|krw|₩|\$))?\s*[/／]\s*(\d[\d,]*(?:\.\d+)?|무료|무배|free|0)(?:\s*원)?/i,
  );
  if (!match) return false;
  const priceToken = match[1];
  const priceDigits = priceToken.replace(/[^0-9]/g, "");
  if (!priceDigits) return false;
  if (!priceToken.includes(",") && priceDigits.length < 3) return false;
  return true;
}

// 역할: 배송 문구에서 배송 타입을 추정한다.
function classifyShippingText(text?: string | null): ShippingType | null {
  if (!text) return null;
  const normalized = text.toLowerCase().trim();
  if (!normalized) return null;

  if (isConditionalFree(normalized)) {
    return "UNKNOWN";
  }

  if (containsFree(normalized)) return "FREE";
  if (containsPaid(normalized)) return "PAID";
  const amount = parseWonAmount(normalized);
  if (amount !== null) {
    return amount === 0 ? "FREE" : "PAID";
  }
  return null;
}

// 역할: 제목 끝 괄호에서 배송 타입을 추정한다.
function classifyShippingFromTitle(
  title?: string | null,
  price?: number | null,
): ShippingType | null {
  if (!title) return null;
  const groups = extractTrailingParenGroups(title);
  if (groups.length === 0) return null;
  const normalizedPrice =
    typeof price === "number" && Number.isFinite(price) ? price : null;

  for (const raw of groups) {
    const normalized = raw.toLowerCase().trim();
    if (!normalized) continue;

    if (isConditionalFree(normalized)) return "UNKNOWN";
    if (containsFree(normalized)) return "FREE";
    if (containsPaid(normalized)) return "PAID";

    const amount = parseWonAmount(normalized);
    if (amount !== null) {
      if (normalizedPrice !== null && amount === normalizedPrice) {
        continue;
      }
      return amount === 0 ? "FREE" : "PAID";
    }
  }

  return null;
}

// 역할: 제목 끝의 괄호 그룹을 뒤에서부터 추출한다.
function extractTrailingParenGroups(title: string): string[] {
  let rest = title.trim();
  const groups: string[] = [];
  while (true) {
    const match = rest.match(/\s*\(([^()]*)\)\s*$/);
    if (!match || match.index === undefined) break;
    groups.push(match[1]);
    rest = rest.slice(0, match.index).trim();
  }
  return groups;
}

// 역할: 조건부 무료 패턴을 감지한다.
function isConditionalFree(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  return (
    compact.includes("네멤무료") ||
    compact.includes("멤버십무료") ||
    compact.includes("회원무료") ||
    compact.includes("회원전용무료") ||
    compact.includes("조건부") ||
    /\d+(만|천)?원이상무료/.test(compact)
  );
}

// 역할: 무료 배송 표현을 감지한다.
function containsFree(text: string): boolean {
  return (
    text.includes("무료") ||
    text.includes("무배") ||
    text.includes("free") ||
    text.includes("0원")
  );
}

// 역할: 유료 배송 표현을 감지한다.
function containsPaid(text: string): boolean {
  return (
    text.includes("유료") ||
    text.includes("paid") ||
    text.includes("착불")
  );
}

// 역할: "(3,000원)" 같은 금액 표현을 원 단위 숫자로 파싱한다.
function parseWonAmount(text: string): number | null {
  if (!text.includes("원")) return null;
  const digits = text.replace(/[^0-9]/g, "");
  if (!digits) return null;
  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
}
