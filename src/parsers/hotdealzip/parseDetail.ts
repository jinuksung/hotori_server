import * as cheerio from "cheerio";
import { normalizeUrl } from "../../utils/url";

export type HotdealzipDetail = {
  buyUrl: string | null;
  originalPostUrl: string | null;
  imageUrl: string | null;
};

export function parseHotdealzipDetail(html: string): HotdealzipDetail {
  const $ = cheerio.load(html);

  const buyUrl = normalizeUrl(
    $("a.buy-button").first().attr("href")?.trim() ?? "",
  );

  const originalPostUrl = normalizeUrl(
    $("a.original-post-link-small")
      .toArray()
      .map((el) => $(el).attr("href")?.trim() ?? "")
      .find((href) => href.startsWith("http")) ?? "",
  );

  const metaImage = normalizeUrl(
    $("meta[property='og:image']").attr("content")?.trim() ??
      $("meta[name='twitter:image']").attr("content")?.trim() ??
      "",
  );

  const bodyImage = normalizeUrl(
    $(".deal-image img, .deal-thumb img, .post-content img, article img")
      .first()
      .attr("src")
      ?.trim() ?? "",
  );

  return {
    buyUrl: buyUrl ?? null,
    originalPostUrl: originalPostUrl ?? null,
    imageUrl: metaImage ?? bodyImage ?? null,
  };
}
