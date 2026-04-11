import crypto from "crypto";

const API_BASE = "https://api-gateway.coupang.com";
const DEEPLINK_PATH = "/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink";

export type CoupangDeepLinkResult = {
  originalUrl: string;
  shortenUrl?: string;
  landingUrl?: string;
};

type DeepLinkResponse = {
  rCode: string;
  message: string;
  data?: CoupangDeepLinkResult[];
};

export function isCoupangUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === "www.coupang.com";
  } catch {
    return false;
  }
}

export async function createCoupangDeepLinks(
  coupangUrls: string[],
  subId?: string,
): Promise<CoupangDeepLinkResult[]> {
  const accessKey = process.env.COUPANG_ACCESS_KEY?.trim();
  const secretKey = process.env.COUPANG_SECRET_KEY?.trim();

  if (!accessKey || !secretKey) {
    throw new Error("COUPANG_ACCESS_KEY and COUPANG_SECRET_KEY are required");
  }

  const body = {
    coupangUrls,
    ...(subId ? { subId } : {}),
  };

  const authorization = buildAuthorization({
    accessKey,
    secretKey,
    method: "POST",
    path: DEEPLINK_PATH,
    query: "",
  });

  const response = await fetch(`${API_BASE}${DEEPLINK_PATH}`, {
    method: "POST",
    headers: {
      authorization,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const payload = (await response.json()) as DeepLinkResponse;
  if (!response.ok || payload.rCode !== "0") {
    throw new Error(
      payload.message || `coupang api http ${response.status}: ${JSON.stringify(payload)}`,
    );
  }

  return payload.data ?? [];
}

function buildAuthorization(input: {
  accessKey: string;
  secretKey: string;
  method: string;
  path: string;
  query: string;
}): string {
  const datetime = createSignedDate();
  const message = `${datetime}${input.method}${input.path}${input.query}`;
  const signature = crypto
    .createHmac("sha256", input.secretKey)
    .update(message)
    .digest("hex");

  return `CEA algorithm=HmacSHA256, access-key=${input.accessKey}, signed-date=${datetime}, signature=${signature}`;
}

function createSignedDate(date = new Date()): string {
  const yy = String(date.getUTCFullYear()).slice(2);
  const MM = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const HH = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  return `${yy}${MM}${dd}T${HH}${mm}${ss}Z`;
}
