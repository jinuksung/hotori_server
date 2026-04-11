import crypto from "crypto";

type AliExpressAffiliateApiResponse = {
  affiliateUrl?: string;
  trackingUrl?: string;
  promotionUrl?: string;
  data?: {
    affiliateUrl?: string;
    trackingUrl?: string;
    promotionUrl?: string;
    promotion_link?: string;
  };
  result?: {
    affiliateUrl?: string;
    trackingUrl?: string;
    promotionUrl?: string;
    promotion_link?: string;
  };
};

const SIGNATURE_MODE = "business" as const;
const API_PATH = "aliexpress.affiliate.link.generate";
const API_ENDPOINT = "https://api-sg.aliexpress.com/sync";
const SYSTEM_PARAMS: Record<string, string> = {
  method: "aliexpress.affiliate.link.generate",
  format: "json",
  v: "2.0",
  sign_method: "sha256",
};

type SignatureMode = typeof SIGNATURE_MODE;

function formatTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function buildSignature(params: Record<string, string>, appSecret: string, mode: SignatureMode) {
  const sortedKeys = Object.keys(params)
    .filter((key) => key !== "sign")
    .sort();

  let base = "";
  if (mode === "system") {
    // not used in current setup
  }

  for (const key of sortedKeys) {
    const value = params[key];
    if (key && value !== undefined && value !== null && value !== "") {
      base += key + value;
    }
  }

  const digest = crypto
    .createHmac("sha256", appSecret)
    .update(base, "utf8")
    .digest("hex")
    .toUpperCase();

  return digest;
}

function signParams(params: Record<string, string>): Record<string, string> {
  const appKey = process.env.ALIEXPRESS_APP_KEY?.trim();
  const appSecret = process.env.ALIEXPRESS_APP_SECRET?.trim();

  if (!appKey || !appSecret) {
    throw new Error("ALIEXPRESS_APP_KEY and ALIEXPRESS_APP_SECRET are required");
  }

  const systemParams: Record<string, string> = {
    ...SYSTEM_PARAMS,
    timestamp: formatTimestamp(),
  };

  const merged: Record<string, string> = {
    app_key: appKey,
    sign_method: "sha256",
    ...systemParams,
    ...params,
  };

  if (SIGNATURE_MODE === "business") {
    merged.api_path = API_PATH;
  }

  const signature = buildSignature(merged, appSecret, SIGNATURE_MODE);
  return { ...merged, sign: signature };
}

export function isAliExpressUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "www.aliexpress.com" || hostname === "s.click.aliexpress.com";
  } catch {
    return false;
  }
}

export function isAliExpressAffiliateUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const hostname = u.hostname.toLowerCase();
    if (hostname === "s.click.aliexpress.com") return true;
    return ["aff_fcid", "aff_fsk", "aff_platform", "dp", "sub"].some((k) =>
      u.searchParams.has(k),
    );
  } catch {
    return false;
  }
}

export async function createAliExpressAffiliateLink(
  originalUrl: string,
  subId?: string,
): Promise<string> {
  if (isAliExpressAffiliateUrl(originalUrl)) {
    return originalUrl;
  }

  const payloadParams: Record<string, string> = {
    source_values: originalUrl,
    tracking_id: "default",
    promotion_link_type: "0",
  };

  if (subId) {
    payloadParams.sub_id = subId;
  }

  const signedParams = signParams(payloadParams);

  const url = new URL(API_ENDPOINT);
  url.searchParams.set("method", API_PATH);
  for (const [key, value] of Object.entries(signedParams)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      accept: "application/json",
    },
  });

  const payload = (await response.json()) as AliExpressAffiliateApiResponse;
  if (!response.ok) {
    throw new Error(
      `AliExpress affiliate api http ${response.status}: ${JSON.stringify(payload)}`,
    );
  }

  if ((payload as any)?.error_response) {
    throw new Error(`AliExpress affiliate api error: ${JSON.stringify(payload)}`);
  }

  const affiliateUrl =
    payload.affiliateUrl ??
    payload.trackingUrl ??
    payload.promotionUrl ??
    payload.data?.affiliateUrl ??
    payload.data?.trackingUrl ??
    payload.data?.promotionUrl ??
    payload.data?.promotion_link ??
    payload.result?.affiliateUrl ??
    payload.result?.trackingUrl ??
    payload.result?.promotionUrl ??
    payload.result?.promotion_link ??
    (payload as any)?.aliexpress_affiliate_link_generate_response?.resp_result?.result?.promotion_links?.promotion_link?.[0]?.promotion_link ??
    (payload as any)?.aliexpress_affiliate_link_generate_response?.resp_result?.result?.promotion_links?.promotion_link?.[0]?.promotionLink;

  if (!affiliateUrl) {
    throw new Error(
      `AliExpress affiliate api response missing affiliate url: ${JSON.stringify(payload)}`,
    );
  }

  return affiliateUrl;
}
