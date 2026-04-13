export function mapCoupangGoldboxCategoryToInternal(categoryName: string | null): {
  categoryName: string;
  confidence: number;
} {
  const value = (categoryName ?? "").trim();

  if (["식품", "로켓프레시"].includes(value)) {
    return { categoryName: "FOOD", confidence: 0.98 };
  }
  if (["가전디지털"].includes(value)) {
    return { categoryName: "ELECTRONICS", confidence: 0.95 };
  }
  if (["가구/홈인테리어", "생활용품", "출산/유아"].includes(value)) {
    return { categoryName: "HOME", confidence: 0.92 };
  }
  if (["패션의류", "패션잡화", "뷰티"].includes(value)) {
    return { categoryName: "FASHION", confidence: 0.9 };
  }

  return { categoryName: "MISC", confidence: 0.2 };
}
