import * as cheerio from "cheerio";

const BASE_URL = "https://www.fmkorea.com";

export type FmHotdealDetail = {
  site: "fmkorea";
  board: "hotdeal";
  documentSrl: number;
  url: string;
  canonicalUrl?: string;

  title?: string;
  category?: string;
  sourceCategoryKey?: string;
  sourceCategoryName?: string;
  mall?: string;
  productName?: string;
  price?: string;
  shipping?: string;
  dealUrl?: string;

  author?: string;
  createdAtText?: string; // "2026.01.28 19:38"
  createdAtRegdate?: string; // "20260128193844" (raw)
  viewCount?: number;
  upvoteCount?: number;
  commentCount?: number;

  summaryText?: string;
  ogImage?: string;
  contentImages?: string[];

  relevantDeals?: Array<{
    url: string;
    title: string;
    price?: string;
    regdate?: string; // "2026-01-28"
  }>;
};

function normalizeText(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

function pickNumber(s: string) {
  const n = Number(s.replace(/[^0-9]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

export function parseFmHotdealDetail(html: string): FmHotdealDetail {
  const $ = cheerio.load(html);

  // document_srl: canonical 먼저 시도, 실패 시 window 변수에서 추출
  const canonical = $('link[rel="canonical"]').attr("href")?.trim();
  const docFromCanonical = canonical?.match(/\/(\d+)(?:$|\?)/)?.[1];
  const docFromScript =
    html.match(/window\.current_document_srl\s*=\s*parseInt\('(\d+)'\)/)?.[1] ??
    html.match(/current_document_srl\s*=\s*parseInt\('(\d+)'\)/)?.[1];

  const documentSrl = Number(docFromCanonical ?? docFromScript ?? 0);

  const title = normalizeText($(".rd_hd h1 .np_18px_span").first().text());

  const categoryLink = $(".pop_more a.category").first();
  const category = normalizeText(categoryLink.text());
  const sourceCategoryKey = extractCategoryKey(
    categoryLink.attr("data-category_srl"),
    categoryLink.attr("href"),
  );
  const sourceCategoryName = category || undefined;

  const createdAtText = normalizeText($(".top_area .date").first().text());

  const createdAtRegdate = html.match(
    /window\.document_regdate\s*=\s*(\d+)/,
  )?.[1];

  const author = normalizeText($(".btm_area .member_plate").first().text());

  // 조회/추천/댓글
  const stats = $(".btm_area .side.fr span b")
    .toArray()
    .map((el) => normalizeText($(el).text()));
  const viewCount = stats[0] ? pickNumber(stats[0]) : undefined;
  const upvoteCount = stats[1] ? pickNumber(stats[1]) : undefined;
  const commentCount = stats[2] ? pickNumber(stats[2]) : undefined;

  // hotdeal_table 라벨 기반 추출
  const table = $("table.hotdeal_table").first();

  // FM코리아 핫딜 쇼핑몰 링크 원본 url 로 변환
  function unwrapFmkoreaRedirectUrl(input?: string): string | undefined {
    if (!input) return undefined;

    const raw = input.trim();
    try {
      const u = new URL(raw);

      // FMKorea redirect wrapper
      if (u.hostname === "link.fmkorea.org" && u.pathname === "/link.php") {
        const wrapped = u.searchParams.get("url");
        if (wrapped) return decodeURIComponent(wrapped);
      }

      return raw;
    } catch {
      // URL 파싱이 실패하면 원본 그대로
      return raw;
    }
  }

  function getTdByThLabel(label: string) {
    const tr = table
      .find("tr")
      .filter((_, el) => normalizeText($(el).find("th").text()).includes(label))
      .first();
    return tr.length ? tr.find("td").first() : null;
  }

  const dealUrlEl = getTdByThLabel("링크")?.find("a.hotdeal_url").first();
  const dealUrlRaw = dealUrlEl?.attr("href")?.trim() || undefined;
  const dealUrl = unwrapFmkoreaRedirectUrl(dealUrlRaw);

  const mall = getTdByThLabel("쇼핑몰")?.text()
    ? normalizeText(getTdByThLabel("쇼핑몰")!.text())
    : undefined;

  const productName = getTdByThLabel("상품명")?.text()
    ? normalizeText(getTdByThLabel("상품명")!.text())
    : undefined;

  const price = getTdByThLabel("가격")?.text()
    ? normalizeText(getTdByThLabel("가격")!.text())
    : undefined;

  const shipping = getTdByThLabel("배송")?.text()
    ? normalizeText(getTdByThLabel("배송")!.text())
    : undefined;

  // 요약/이미지
  const ogImage = $('meta[property="og:image"]').attr("content")?.trim();

  const contentImages = $(".rd_body article .xe_content img")
    .toArray()
    .map((img) => {
      const src = $(img).attr("src")?.trim();
      if (!src) return null;
      // //image... 형태면 https 붙이기
      return src.startsWith("//") ? `https:${src}` : src;
    })
    .filter((v): v is string => !!v);

  const summaryText = normalizeText(
    $(".rd_body article .xe_content p").first().text(),
  );

  // 유사 핫딜
  const relevantDeals = $("ul.relevant_hotdeals li.list")
    .toArray()
    .map((li) => {
      const a = $(li).find("a").first();
      const url = a.attr("href")?.trim() ?? "";
      const title = normalizeText(a.text());
      const price = normalizeText($(li).find(".price span").text());
      const regdate = normalizeText($(li).find(".regdate span").text());

      return {
        url: url.startsWith("http") ? url : `https://www.fmkorea.com${url}`,
        title,
        price: price || undefined,
        regdate: regdate || undefined,
      };
    });

  const url =
    canonical || (documentSrl ? `https://www.fmkorea.com/${documentSrl}` : "");

  return {
    site: "fmkorea",
    board: "hotdeal",
    documentSrl,
    url,
    canonicalUrl: canonical,
    title: title || undefined,
    category: category || undefined,
    sourceCategoryKey: sourceCategoryKey || undefined,
    sourceCategoryName,
    mall,
    productName,
    price,
    shipping,
    dealUrl,
    author: author || undefined,
    createdAtText: createdAtText || undefined,
    createdAtRegdate,
    viewCount,
    upvoteCount,
    commentCount,
    summaryText: summaryText || undefined,
    ogImage,
    contentImages: contentImages.length ? contentImages : undefined,
    relevantDeals: relevantDeals.length ? relevantDeals : undefined,
  };
}

function extractCategoryKey(
  dataCategory?: string | null,
  href?: string | null,
): string | undefined {
  const trimmed = dataCategory?.trim();
  if (trimmed) return trimmed;
  if (!href) return undefined;
  try {
    const parsed = new URL(href, BASE_URL);
    return (
      parsed.searchParams.get("category") ??
      parsed.searchParams.get("category_srl") ??
      undefined
    );
  } catch {
    return undefined;
  }
}
