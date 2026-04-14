import "dotenv/config";

import pino from "pino";
import { query } from "../src/db/client";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const CHAT_ID = process.env.TELEGRAM_TARGET_CHAT_ID?.trim();
const TOPIC_HOME = process.env.TELEGRAM_TOPIC_HOME?.trim();
const TOPIC_FOOD = process.env.TELEGRAM_TOPIC_FOOD?.trim();
const TOPIC_DIGITAL = process.env.TELEGRAM_TOPIC_DIGITAL?.trim();

if (!BOT_TOKEN || !CHAT_ID || !TOPIC_HOME || !TOPIC_FOOD || !TOPIC_DIGITAL) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN / TELEGRAM_TARGET_CHAT_ID / TELEGRAM_TOPIC_* envs");
}

const TOPIC_BY_CATEGORY: Record<string, string> = {
  HOME: TOPIC_HOME,
  FOOD: TOPIC_FOOD,
  ELECTRONICS: TOPIC_DIGITAL,
  DIGITAL: TOPIC_DIGITAL,
};

async function sendPhoto(payload: {
  photo: string;
  caption: string;
  topicId: string;
}) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`;
  const body = new URLSearchParams({
    chat_id: CHAT_ID,
    message_thread_id: payload.topicId,
    photo: payload.photo,
    caption: payload.caption,
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(`telegram sendPhoto failed: ${JSON.stringify(data)}`);
  }
}

function pickDisplayShopName(shopName: string | null, affiliateUrl: string): string | null {
  try {
    const host = new URL(affiliateUrl).hostname.toLowerCase();
    if (host === "s.click.aliexpress.com" || host.endsWith(".aliexpress.com") || host === "aliexpress.com") {
      return "알리익스프레스";
    }
  } catch {
    // noop
  }
  return shopName;
}

function formatCaption(input: {
  categoryName: string;
  title: string;
  price: string | null;
  shippingType: string;
  shopName: string | null;
  affiliateUrl: string;
}) {
  const lines: string[] = [];
  const displayShopName = pickDisplayShopName(input.shopName, input.affiliateUrl);
  lines.push(`[${input.categoryName}] 딜 발송`);
  lines.push(`- 제목: ${input.title}`);
  if (input.price) lines.push(`- 가격: ${input.price}원`);
  lines.push(`- 배송: ${input.shippingType}`);
  if (displayShopName) lines.push(`- 스토어: ${displayShopName}`);
  lines.push(`- 링크: ${input.affiliateUrl}`);
  return lines.join("\n");
}

async function main() {
  logger.info({ job: "publish:telegram-approved" }, "job started");

  const rows = await query<{
    queueId: number;
    dealId: number;
    title: string;
    price: string | null;
    shippingType: string;
    shopName: string | null;
    thumbnailUrl: string | null;
    categoryName: string | null;
    affiliateUrl: string | null;
  }>(
    `select q.id as "queueId",
            q.deal_id as "dealId",
            d.title,
            d.price::text as price,
            d.shipping_type as "shippingType",
            d.shop_name as "shopName",
            d.thumbnail_url as "thumbnailUrl",
            c.name as "categoryName",
            aff.url as "affiliateUrl"
     from public.deal_publish_queue q
     join public.deals d on d.id = q.deal_id
     left join public.categories c on c.id = d.category_id
     left join lateral (
       select dl.url
       from public.deal_links dl
       where dl.deal_id = d.id
         and dl.is_affiliate = true
       order by dl.id asc
       limit 1
     ) aff on true
     where q.status = 'approved'
       and q.sent_at is null
     order by q.created_at asc
     limit 1`,
  );

  if (rows.rows.length === 0) {
    console.log("[DONE]", { sent: 0 });
    return;
  }

  const row = rows.rows[0];
  const categoryName = (row.categoryName ?? "").toUpperCase();
  const topicId = TOPIC_BY_CATEGORY[categoryName];

  if (!topicId) {
    await query(
      "update public.deal_publish_queue set status = 'failed', send_error = $2, updated_at = now() where id = $1",
      [row.queueId, `unknown category: ${row.categoryName}`],
    );
    console.log("[DONE]", { sent: 0, failed: 1, reason: "unknown_category" });
    return;
  }

  if (!row.affiliateUrl || !row.thumbnailUrl) {
    await query(
      "update public.deal_publish_queue set status = 'failed', send_error = $2, updated_at = now() where id = $1",
      [row.queueId, "missing affiliate url or thumbnail"],
    );
    console.log("[DONE]", { sent: 0, failed: 1, reason: "missing_fields" });
    return;
  }

  const caption = formatCaption({
    categoryName: categoryName,
    title: row.title,
    price: row.price,
    shippingType: row.shippingType,
    shopName: row.shopName,
    affiliateUrl: row.affiliateUrl,
  });

  await sendPhoto({
    photo: row.thumbnailUrl,
    caption,
    topicId,
  });

  await query(
    "update public.deal_publish_queue set status = 'sent', sent_at = now(), send_error = null, updated_at = now() where id = $1",
    [row.queueId],
  );

  console.log("[DONE]", { sent: 1, dealId: row.dealId });
}

main().catch((error) => {
  logger.error({ job: "publish:telegram-approved", error }, "job failed");
  console.log("[FATAL] publish:telegram-approved failed", error);
  process.exitCode = 1;
});
