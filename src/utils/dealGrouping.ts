import { normalizeDealTitle } from "../jobs/pipelineHelpers";

function compactText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^a-z0-9가-힣]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrlForGroup(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    parsed.hash = "";
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    const keyParts = [host, path];

    const pick = (name: string) => parsed.searchParams.get(name)?.trim() || null;

    if (host === "link.coupang.com") {
      const pageKey = pick("pageKey");
      const itemId = pick("itemId");
      const vendorItemId = pick("vendorItemId");
      return `link.coupang.com${path}|pageKey=${pageKey ?? ""}|itemId=${itemId ?? ""}|vendorItemId=${vendorItemId ?? ""}`;
    }

    if (host.endsWith("aliexpress.com")) {
      const itemMatch = path.match(/\/item\/(\d+)\.html/i);
      const itemId = itemMatch?.[1] ?? pick("product_id") ?? pick("pageKey");
      return itemId ? `${host}${path}|itemId=${itemId}` : `${host}${path}`;
    }

    if (host.endsWith("gmarket.co.kr")) {
      const goodsCode = pick("goodsCode") ?? pick("goodscode") ?? pick("GoodsCode");
      return goodsCode ? `${host}${path}|goodsCode=${goodsCode}` : `${host}${path}`;
    }

    if (host.endsWith("auction.co.kr")) {
      const itemNo = pick("itemno") ?? pick("ItemNo");
      return itemNo ? `${host}${path}|itemNo=${itemNo}` : `${host}${path}`;
    }

    if (host.endsWith("lotteon.com")) {
      const productId = pick("productId") ?? pick("goodsNo");
      return productId ? `${host}${path}|productId=${productId}` : `${host}${path}`;
    }

    if (host === "store.ohou.se") {
      const goodsMatch = path.match(/\/goods\/(\d+)/i);
      const exhibitionMatch = path.match(/\/exhibitions\/(\d+)/i);
      if (goodsMatch?.[1]) return `${host}/goods/${goodsMatch[1]}`;
      if (exhibitionMatch?.[1]) return `${host}/exhibitions/${exhibitionMatch[1]}`;
    }

    return keyParts.join("");
  } catch {
    return null;
  }
}

export function buildDealGroupKey(input: {
  categoryName?: string | null;
  title: string;
  representativeUrl?: string | null;
}): string {
  const normalizedUrl = input.representativeUrl ? normalizeUrlForGroup(input.representativeUrl) : null;
  if (normalizedUrl) {
    return `url:${normalizedUrl}`;
  }

  const normalizedTitle = compactText(normalizeDealTitle(input.title));
  const category = (input.categoryName ?? "unknown").toLowerCase().trim() || "unknown";
  return `title:${category}|${normalizedTitle}`;
}
