export type TelegramMessageInput = {
  title: string;
  price: string | null;
  shopName: string | null;
  categoryName: string | null;
  link: string | null;
  payloadJson: Record<string, unknown> | null;
};

function isBlockedCommunityUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "ppomppu.co.kr"
      || host.endsWith(".ppomppu.co.kr")
      || host === "fmkorea.com"
      || host.endsWith(".fmkorea.com")
      || host === "ruliweb.com"
      || host.endsWith(".ruliweb.com")
      || host === "youtube.com"
      || host.endsWith(".youtube.com")
      || host === "youtu.be";
  } catch {
    return false;
  }
}

export function extractQueueLinkFromPayload(
  payloadJson: Record<string, unknown> | null,
): string | null {
  if (!payloadJson) return null;

  const candidates = [
    payloadJson.representativeUrl,
    payloadJson.purchaseUrl,
    payloadJson.url,
    payloadJson.link,
  ];

  for (const value of candidates) {
    if (typeof value === "string" && value.trim().length > 0 && !isBlockedCommunityUrl(value.trim())) {
      return value.trim();
    }
  }

  return null;
}

function escapeMarkdown(text: string): string {
  return text.replace(/([_\*\[\]\(\)~`>#+\-=|{}.!\\])/g, "\\$1");
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatUnitPrice(payloadJson: Record<string, unknown> | null): string | null {
  if (!payloadJson) return null;
  const unitPrice = toNumber(payloadJson.unitPrice);
  const unitBasis = typeof payloadJson.unitBasis === "string" ? payloadJson.unitBasis : null;
  if (unitPrice == null || !unitBasis) return null;

  const rounded = Math.round(unitPrice * 100) / 100;
  const priceText = Number.isInteger(rounded)
    ? String(Math.trunc(rounded))
    : rounded.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return `${priceText}원 / ${unitBasis}`;
}

function buildHotdealScore(payloadJson: Record<string, unknown> | null): string | null {
  if (!payloadJson) return null;
  const unitPrice = toNumber(payloadJson.unitPrice);
  const p25 = toNumber(payloadJson.benchmarkP25);
  const sampleSize = toNumber(payloadJson.benchmarkSampleSize);
  if (unitPrice == null || p25 == null || sampleSize == null || sampleSize < 5 || p25 <= 0) return null;

  const ratio = unitPrice / p25;
  let score = 1;
  if (ratio <= 0.55) score = 5;
  else if (ratio <= 0.75) score = 4;
  else if (ratio <= 1.0) score = 3;
  else if (ratio <= 1.25) score = 2;
  else score = 1;

  return "🌰".repeat(score);
}

export function buildTelegramMessage(input: TelegramMessageInput): string {
  const lines: string[] = [];

  lines.push(`*${escapeMarkdown(input.title)}*`);

  if (input.price) {
    lines.push(`가격: ${escapeMarkdown(input.price)}`);
  }

  if (input.shopName) {
    lines.push(`쇼핑몰: ${escapeMarkdown(input.shopName)}`);
  }

  const score = buildHotdealScore(input.payloadJson);
  if (score) {
    lines.push(`핫토리 핫딜지수: ${score}`);
  }

  const unitPriceText = formatUnitPrice(input.payloadJson);
  if (unitPriceText) {
    lines.push(`단위당 가격: ${escapeMarkdown(unitPriceText)}`);
  }

  if (input.link) {
    lines.push(`[구매하러 가기](${input.link})`);
  }

  return lines.join("\n");
}
