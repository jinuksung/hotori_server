export function normalizeUrl(href: string, baseUrl?: string): string | null {
  const trimmed = href.trim();
  if (!trimmed) return null;
  try {
    if (trimmed.startsWith("//")) {
      return new URL(`https:${trimmed}`).toString();
    }
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      return new URL(trimmed).toString();
    }
    if (baseUrl) {
      return new URL(trimmed, baseUrl).toString();
    }
    return null;
  } catch {
    return null;
  }
}

export function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
