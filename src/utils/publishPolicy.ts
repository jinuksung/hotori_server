// 역할: 1단계 핫딜 발송 정책 상수/판별 유틸을 제공한다.

const ALLOWED_CATEGORY_NAMES = new Set([
  "ELECTRONICS",
  "DIGITAL",
  "FOOD",
  "HOME",
  "FASHION",
]);

const NON_PRODUCT_KEYWORDS = [
  "적립",
  "응모",
  "출석",
  "체험단",
  "이벤트",
];

export const TELEGRAM_HOTDEAL_CHANNEL = "telegram_hotdeal";
export const TELEGRAM_HOTDEAL_BATCH_LIMIT = 5;
export const TELEGRAM_HOTDEAL_MAX_RETRIES = 3;

export function isAllowedPublishCategory(categoryName: string | null | undefined): boolean {
  if (!categoryName) return false;
  return ALLOWED_CATEGORY_NAMES.has(categoryName.trim().toUpperCase());
}

export function hasNonProductKeyword(title: string | null | undefined): boolean {
  const normalized = (title ?? "").trim();
  if (!normalized) return false;
  return NON_PRODUCT_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

export function getPublishCategoryTag(categoryName: string | null | undefined): string | null {
  const normalized = (categoryName ?? "").trim().toUpperCase();
  switch (normalized) {
    case "ELECTRONICS":
    case "DIGITAL":
      return "#전자";
    case "FOOD":
      return "#식품";
    case "HOME":
      return "#홈";
    case "FASHION":
      return "#패션";
    default:
      return null;
  }
}
