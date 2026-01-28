import * as cheerio from "cheerio";
import { z } from "zod";
import type { ParseDetailResult, Result, ShippingType } from "../../types";
import { extractDomain, normalizeUrl } from "../../utils/url";

const BASE_URL = "https://www.fmkorea.com";

const parseDetailSchema = z.object({
  price: z.number().nullable(),
  shippingType: z.union([z.literal("FREE"), z.literal("PAID"), z.literal("UNKNOWN")]),
  soldOut: z.boolean(),
  outboundLinks: z.array(z.string().url()),
});

function parsePrice(text: string): number | null {
  const cleaned = text.replace(/,/g, " ");
  const match = cleaned.match(/(\d{1,3}(?:\s?\d{3})*(?:\.\d{1,2})?)/);
  if (!match) return null;
  const num = Number(match[1].replace(/\s+/g, ""));
  return Number.isFinite(num) ? num : null;
}

function detectShippingType(text: string): ShippingType {
  if (text.includes("무료배송") || text.includes("배송비무료")) return "FREE";
  if (text.includes("배송비") || text.includes("유료배송")) return "PAID";
  return "UNKNOWN";
}

function detectSoldOut(text: string, $: cheerio.CheerioAPI): boolean {
  if (text.includes("품절") || text.includes("SOLD OUT")) return true;
  if ($(".soldout, .sold-out, .btn_soldout, .sold_out").length > 0) return true;
  return false;
}

function extractOutboundLinks($: cheerio.CheerioAPI): string[] {
  const urls = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const normalized = normalizeUrl(href, BASE_URL);
    if (!normalized) return;
    const domain = extractDomain(normalized);
    if (!domain) return;
    if (domain.endsWith("fmkorea.com")) return;
    urls.add(normalized);
  });
  return Array.from(urls);
}

export function parseDetail(html: string): Result<ParseDetailResult> {
  try {
    const $ = cheerio.load(html);
    const bodyText = $("body").text();

    const priceTextCandidates = [
      $(".price, .deal_price, .sum, .contents .price").first().text(),
      $("body").text(),
    ].filter(Boolean);
    let price: number | null = null;
    for (const text of priceTextCandidates) {
      price = parsePrice(text);
      if (price !== null) break;
    }

    const shippingText =
      $(".shipping, .delivery, .price, .deal_price").first().text() || bodyText;
    const shippingType = detectShippingType(shippingText);
    const soldOut = detectSoldOut(bodyText, $);

    const outboundLinks = extractOutboundLinks($);

    const parsed = parseDetailSchema.safeParse({
      price,
      shippingType,
      soldOut,
      outboundLinks,
    });
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          message: "parseDetail validation failed",
          issues: parsed.error.issues.map((e) => e.message),
        },
      };
    }
    return { ok: true, data: parsed.data };
  } catch (error) {
    return {
      ok: false,
      error: {
        message:
          error instanceof Error ? error.message : "parseDetail unexpected error",
      },
    };
  }
}
