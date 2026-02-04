// 역할: 크롤링 파이프라인에서 사용하는 공통 변환/판별 유틸.

import type { ShippingType } from "../types";
import type { FmHotdealDetail } from "../parsers/fmkorea/parseDetail";

// 역할: 딜 제목에서 상점 접두/가격/배송 정보를 제거해 정규화한다.
export function normalizeDealTitle(title: string): string {
  const stripped = stripShopPrefix(title);
  return stripTrailingPriceShipping(stripped);
}

// 역할: 가격 문자열에서 숫자만 추출해 number로 변환한다.
export function parsePrice(text?: string | null): number | null {
  if (!text) return null;
  const digits = text.replace(/[^0-9.]/g, "");
  if (!digits) return null;
  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
}

// 역할: 배송 문구를 표준 배송 타입으로 매핑한다.
export function mapShippingType(text?: string | null): ShippingType {
  if (!text) return "UNKNOWN";
  const normalized = text.toLowerCase();
  if (normalized.includes("무료") || normalized.includes("free")) return "FREE";
  if (
    normalized.includes("유료") ||
    normalized.includes("paid") ||
    normalized.includes("착불")
  ) {
    return "PAID";
  }
  return "UNKNOWN";
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
export function selectPurchaseLink(detail: FmHotdealDetail): string | null {
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
    inner.includes("만원") ||
    inner.includes("달러") ||
    inner.includes("usd") ||
    inner.includes("krw") ||
    inner.includes("₩") ||
    inner.includes("$");
  return hasDigit && hasCurrency;
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
