import pino from "pino";
import crypto from "crypto";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

export type AliHotProduct = {
  productId: string;
  productTitle: string;
  productUrl: string | null;
  imageUrl: string | null;
  price: number | null;
  salePrice: number | null;
  discountRate: number | null;
  commissionRate: number | null;
  commissionAmount: number | null;
  ordersCount: number | null;
  rating: number | null;
  sourceCategoryId: string | null;
  shopId: string | null;
  shopName: string | null;
  raw: unknown;
};

type AliHotApiResponse = Record<string, unknown>;

type SignatureMode = "business" | "system";

const SIGNATURE_MODE: SignatureMode = "business";
const API_PATH = "aliexpress.affiliate.hotproduct.query";
const SYSTEM_PARAMS: Record<string, string> = {
  method: "aliexpress.affiliate.hotproduct.query",
  format: "json",
  v: "2.0",
  sign_method: "sha256",
};

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const normalized = trimmed.replace(/,/g, "");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function pickString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function formatTimestamp(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function parseSystemParams(): Record<string, string> {
  const baseParams: Record<string, string> = { ...SYSTEM_PARAMS };

  if (!baseParams.timestamp) {
    baseParams.timestamp = formatTimestamp();
  }

  return baseParams;
}

function buildSignature(params: Record<string, string>, appSecret: string, mode: SignatureMode, apiName?: string) {
  const sortedKeys = Object.keys(params)
    .filter((key) => key !== "sign")
    .sort();

  let base = "";
  if (mode === "system" && apiName) {
    base += apiName;
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

  const systemParams = parseSystemParams();
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

function findProductArray(payload: AliHotApiResponse): unknown[] {
  const candidates = [
    payload?.data,
    payload?.result,
    payload,
  ];

  for (const node of candidates) {
    if (!node || typeof node !== "object") continue;
    const typed = node as Record<string, unknown>;
    const direct = typed.products ?? typed.product ?? typed.items ?? typed.item;
    if (Array.isArray(direct)) return direct;
    if (direct && typeof direct === "object") {
      const nested = (direct as Record<string, unknown>).product ?? (direct as Record<string, unknown>).items;
      if (Array.isArray(nested)) return nested;
    }
  }

  return [];
}

export async function fetchAliHotProducts(params: Record<string, string | number>): Promise<AliHotProduct[]> {
  const endpoint = process.env.ALIEXPRESS_HOT_API_URL?.trim();
  if (!endpoint) {
    throw new Error("ALIEXPRESS_HOT_API_URL is required");
  }

  const method = (process.env.ALIEXPRESS_HOT_API_METHOD ?? "GET").toUpperCase();
  const url = new URL(endpoint);

  const signedParams = signParams(
    Object.fromEntries(
      Object.entries(params)
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([key, value]) => [key, String(value)]),
    ),
  );

  if (method === "GET") {
    for (const [key, value] of Object.entries(signedParams)) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString(), {
    method,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: method === "GET" ? undefined : JSON.stringify(signedParams),
  });

  const payload = (await response.json()) as AliHotApiResponse;
  if (!response.ok) {
    throw new Error(`AliExpress hot api http ${response.status}`);
  }

  const items = findProductArray(payload);
  if (items.length === 0) {
    logger.warn({ job: "aliexpress-hot", params }, "no products found in response");
  }

  return items
    .map((raw) => {
      if (!raw || typeof raw !== "object") return null;
      const item = raw as Record<string, unknown>;

      const productId =
        pickString(item.product_id) ??
        pickString(item.productId) ??
        pickString(item.item_id) ??
        pickString(item.itemId);
      if (!productId) return null;

      const productTitle =
        pickString(item.product_title) ??
        pickString(item.productTitle) ??
        pickString(item.title) ??
        "";

      const productUrl =
        pickString(item.product_detail_url) ??
        pickString(item.product_detail_url_wap) ??
        pickString(item.productUrl) ??
        pickString(item.product_url) ??
        pickString(item.url);

      const imageUrl =
        pickString(item.product_main_image_url) ??
        pickString(item.product_main_image) ??
        pickString(item.image_url) ??
        pickString(item.imageUrl) ??
        pickString(item.image);

      return {
        productId,
        productTitle,
        productUrl,
        imageUrl,
        price: toNumber(item.original_price ?? item.price),
        salePrice: toNumber(item.sale_price ?? item.salePrice),
        discountRate: toNumber(item.discount_rate ?? item.discountRate),
        commissionRate: toNumber(item.commission_rate ?? item.commissionRate),
        commissionAmount: toNumber(item.commission_amount ?? item.commissionAmount),
        ordersCount: toNumber(item.lastest_volume ?? item.last_volume ?? item.orders ?? item.ordersCount),
        rating: toNumber(item.evaluate_rate ?? item.rating),
        sourceCategoryId: pickString(item.category_id ?? item.categoryId),
        shopId: pickString(item.shop_id ?? item.shopId),
        shopName: pickString(item.shop_name ?? item.shopName),
        raw,
      } as AliHotProduct;
    })
    .filter((item): item is AliHotProduct => Boolean(item));
}
