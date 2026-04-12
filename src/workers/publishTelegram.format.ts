export type TelegramMessageInput = {
  title: string;
  price: string | null;
  shopName: string | null;
  categoryName: string | null;
  link: string | null;
};

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
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return null;
}

export function buildTelegramMessage(input: TelegramMessageInput): string {
  const lines: string[] = [];

  lines.push(input.title);

  if (input.price) {
    lines.push(`가격: ${input.price}원`);
  }

  if (input.shopName) {
    lines.push(`쇼핑몰: ${input.shopName}`);
  }

  if (input.categoryName) {
    lines.push(`카테고리: ${input.categoryName}`);
  }

  if (input.link) {
    lines.push(`링크: ${input.link}`);
  }

  return lines.join("\n");
}
