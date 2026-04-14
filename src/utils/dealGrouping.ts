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
      const itemNoFromPath = path.match(/\/(?:item|products)\/(\d+)/i)?.[1] ?? null;
      const itemId = itemNo ?? itemNoFromPath;
      return itemId ? `${host}${path}|itemNo=${itemId}` : `${host}${path}`;
    }

    if (host.endsWith("11st.co.kr")) {
      const productId = pick("prdNo") ?? pick("productNo") ?? pick("trTypeCd") ?? null;
      const productIdFromPath = path.match(/\/products\/(\d+)/i)?.[1] ?? null;
      const itemId = productIdFromPath ?? productId;
      return itemId ? `${host}${path}|prdNo=${itemId}` : `${host}${path}`;
    }

    if (host.endsWith("ssg.com")) {
      const itemId = pick("itemId") ?? pick("siteNo") ?? null;
      const itemIdFromPath = path.match(/\/item\/itemView\.sm\/(\d+)/i)?.[1] ?? null;
      const resolved = itemIdFromPath ?? itemId;
      return resolved ? `${host}${path}|itemId=${resolved}` : `${host}${path}`;
    }

    if (host.endsWith("gsshop.com")) {
      const goodsCode = pick("goodsCode") ?? pick("prdid") ?? pick("goods_no");
      const goodsCodeFromPath = path.match(/\/(?:prd|goods)\/(\d+)/i)?.[1] ?? null;
      const itemId = goodsCodeFromPath ?? goodsCode;
      return itemId ? `${host}${path}|goodsCode=${itemId}` : `${host}${path}`;
    }

    if (host.endsWith("e-himart.co.kr")) {
      const goodsNo = pick("goodsNo") ?? pick("prodNo");
      const goodsNoFromPath = path.match(/\/app\/goods\/goodsDetail\?goodsNo=(\d+)/i)?.[1] ?? null;
      const itemId = goodsNo ?? goodsNoFromPath;
      return itemId ? `${host}${path}|goodsNo=${itemId}` : `${host}${path}`;
    }

    if (host.endsWith("todaypick1.com") || host.endsWith("futureterior.com")) {
      const productId = pick("product_no") ?? pick("goodsNo") ?? null;
      const productIdFromPath = path.match(/\/product\/.+\/(\d+)\/?$/i)?.[1] ?? null;
      const itemId = productIdFromPath ?? productId;
      return itemId ? `${host}${path}|productId=${itemId}` : `${host}${path}`;
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
