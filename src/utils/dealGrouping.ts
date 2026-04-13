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
    parsed.search = "";
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${host}${path}`;
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
