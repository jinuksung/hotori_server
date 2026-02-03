// 역할: URL 정규화 및 도메인 추출 유틸리티.

// 역할: 상대/프로토콜리스 URL을 정규화해서 절대 URL로 변환한다.
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

// 역할: URL 문자열에서 hostname(도메인)을 추출한다.
export function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
