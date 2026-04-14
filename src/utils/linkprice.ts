type LinkPriceDeepLinkResponse = {
  result?: string;
  code?: string;
  message?: string;
  shortUrl?: string;
  trackingUrl?: string;
  url?: string;
  data?: {
    shortUrl?: string;
    trackingUrl?: string;
    url?: string;
  };
};

const LINKPRICE_API_BASE = process.env.LINKPRICE_API_BASE?.trim() || "https://api.linkprice.com";

export function isLinkPriceSupportedUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return ["www.gmarket.co.kr", "gmarket.co.kr", "www.auction.co.kr", "auction.co.kr", "www.lotteon.com", "lotteon.com"].includes(hostname);
  } catch {
    return false;
  }
}

export async function createLinkPriceDeepLink(url: string): Promise<string> {
  const aid = process.env.LINKPRICE_AID?.trim();
  const uid = process.env.LINKPRICE_UID?.trim();

  if (!aid) {
    throw new Error("LINKPRICE_AID is required");
  }

  const endpoint = new URL("/deep_link", LINKPRICE_API_BASE);
  endpoint.searchParams.set("aid", aid);
  endpoint.searchParams.set("murl", url);
  if (uid) endpoint.searchParams.set("uid", uid);

  const response = await fetch(endpoint.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json,text/plain,*/*",
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`linkprice http ${response.status}: ${text}`);
  }

  let payload: LinkPriceDeepLinkResponse | null = null;
  try {
    payload = JSON.parse(text) as LinkPriceDeepLinkResponse;
  } catch {
    payload = null;
  }

  const candidate = payload?.trackingUrl || payload?.shortUrl || payload?.url || payload?.data?.trackingUrl || payload?.data?.shortUrl || payload?.data?.url || text.trim();
  if (!candidate) {
    throw new Error(`linkprice empty response: ${text}`);
  }

  return candidate;
}
