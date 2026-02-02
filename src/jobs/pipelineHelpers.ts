import type { ShippingType } from "../types";
import type { FmHotdealDetail } from "../parsers/fmkorea/parseDetail";

export function parsePrice(text?: string | null): number | null {
  if (!text) return null;
  const digits = text.replace(/[^0-9.]/g, "");
  if (!digits) return null;
  const value = Number(digits);
  return Number.isFinite(value) ? value : null;
}

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

export function selectPurchaseLink(detail: FmHotdealDetail): string | null {
  if (detail.dealUrl) {
    return detail.dealUrl;
  }
  return null;
}

export function stripShopPrefix(title: string): string {
  const withoutPrefix = title.replace(/^\s*\[[^\]]+\]\s*/u, "").trim();
  return withoutPrefix.replace(/\s*\[[^\]]*제휴\s*링크[^\]]*\]\s*$/u, "").trim();
}
