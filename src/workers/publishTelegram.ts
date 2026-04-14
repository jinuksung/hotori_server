import "dotenv/config";

import pino from "pino";
import { query, withTx } from "../db/client";
import { TELEGRAM_HOTDEAL_CHANNEL } from "../utils/publishPolicy";
import {
  buildTelegramMessage,
  extractQueueLinkFromPayload,
} from "./publishTelegram.format";

type ClaimedQueueRow = {
  id: number;
  dealId: number;
  payloadJson: Record<string, unknown> | null;
  title: string;
  price: string | null;
  currencyCode: string | null;
  shopName: string | null;
  categoryName: string | null;
  thumbnailUrl: string | null;
  purchaseUrl: string | null;
  foodGroup: string | null;
  unitBasis: string | null;
  unitPrice: string | null;
  benchmarkSampleSize: number | null;
  benchmarkP25: string | null;
};

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_TARGET_CHAT_ID?.trim();
const TOPIC_HOME = process.env.TELEGRAM_TOPIC_HOME?.trim();
const TOPIC_FOOD = process.env.TELEGRAM_TOPIC_FOOD?.trim();
const TOPIC_DIGITAL = process.env.TELEGRAM_TOPIC_DIGITAL?.trim();
const TOPIC_FASHION = process.env.TELEGRAM_TOPIC_FASHION?.trim() ?? "341";
const CLAIM_LIMIT = Number(process.env.PUBLISH_WORKER_BATCH_LIMIT ?? 5);
const LOOP = process.env.PUBLISH_WORKER_LOOP === "true";
const LOOP_INTERVAL_MS = Number(process.env.PUBLISH_WORKER_INTERVAL_MS ?? 30_000);

if (!BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_TARGET_CHAT_ID");
}

if (!TOPIC_HOME || !TOPIC_FOOD || !TOPIC_DIGITAL) {
  throw new Error("Missing TELEGRAM_TOPIC_HOME/FOOD/DIGITAL");
}

async function claimApprovedRows(limit: number): Promise<ClaimedQueueRow[]> {
  return withTx(async (client) => {
    const result = await query<ClaimedQueueRow>(
      `with candidates as (
         select q.id
         from public.deal_publish_queue q
         where q.status = 'approved'
           and q.channel = $1
           and q.sent_at is null
         order by q.created_at asc
         for update skip locked
         limit $2
       ),
       claimed as (
         update public.deal_publish_queue q
         set status = 'sending',
             send_error = null,
             updated_at = now()
         where q.id in (select id from candidates)
         returning q.id,
                   q.deal_id as "dealId",
                   q.payload_json as "payloadJson"
       )
       select c.id,
              c."dealId",
              c."payloadJson",
              coalesce(pref.title, d.title) as title,
              coalesce(pref.price::text, d.price::text) as price,
              coalesce(pref.currency_code, d.currency_code) as "currencyCode",
              coalesce(pref.shop_name, d.shop_name) as "shopName",
              coalesce(pref.thumbnail_url, d.thumbnail_url) as "thumbnailUrl",
              coalesce(pref_cat.name, cat.name) as "categoryName",
              coalesce(pref_link.url, link.url) as "purchaseUrl",
              m.food_group as "foodGroup",
              m.unit_basis as "unitBasis",
              m.unit_price::text as "unitPrice",
              b.sample_size as "benchmarkSampleSize",
              b.p25::text as "benchmarkP25"
       from claimed c
       join public.deals d on d.id = c."dealId"
       left join public.categories cat on cat.id = d.category_id
       left join lateral (
         select d2.*
         from public.deals d2
         join public.deal_sources ds2 on ds2.deal_id = d2.id
         where d.deal_group_key is not null
           and d2.deal_group_key = d.deal_group_key
           and ds2.source in ('aliexpress_hot', 'coupang_goldbox')
         order by case ds2.source when 'aliexpress_hot' then 1 when 'coupang_goldbox' then 2 else 99 end,
                  d2.updated_at desc,
                  d2.id desc
         limit 1
       ) pref on true
       left join public.categories pref_cat on pref_cat.id = pref.category_id
       left join lateral (
         select dl.url
         from public.deal_links dl
         where dl.deal_id = d.id
           and coalesce(dl.domain, '') not in ('ppomppu.co.kr', 'www.ppomppu.co.kr', 'fmkorea.com', 'www.fmkorea.com', 'ruliweb.com', 'www.ruliweb.com')
         order by dl.is_affiliate desc, dl.id asc
         limit 1
       ) link on true
       left join lateral (
         select dl.url
         from public.deal_links dl
         where pref.id is not null
           and dl.deal_id = pref.id
           and coalesce(dl.domain, '') not in ('ppomppu.co.kr', 'www.ppomppu.co.kr', 'fmkorea.com', 'www.fmkorea.com', 'ruliweb.com', 'www.ruliweb.com')
         order by dl.is_affiliate desc, dl.id asc
         limit 1
       ) pref_link on true
       left join public.deal_food_unit_metrics m on m.deal_id = d.id
       left join public.food_group_price_benchmarks b on b.food_group = m.food_group and b.unit_basis = m.unit_basis
       order by c.id asc`,
      [TELEGRAM_HOTDEAL_CHANNEL, limit],
      client,
    );

    return result.rows;
  });
}

async function markQueueSent(id: number): Promise<void> {
  await query(
    `update public.deal_publish_queue
     set status = 'sent',
         sent_at = now(),
         send_error = null,
         updated_at = now()
     where id = $1
       and status = 'sending'`,
    [id],
  );
}

async function markQueueSendFailed(id: number, errorMessage: string): Promise<void> {
  await query(
    `update public.deal_publish_queue
     set status = 'approved',
         sent_at = null,
         send_error = $2,
         updated_at = now()
     where id = $1
       and status = 'sending'`,
    [id, errorMessage],
  );
}

async function markQueueBlocked(id: number, reason: string): Promise<void> {
  await query(
    `update public.deal_publish_queue
     set status = 'blocked',
         sent_at = null,
         send_error = null,
         reason = $2,
         updated_at = now()
     where id = $1
       and status = 'sending'`,
    [id, reason],
  );
}

async function hasAlreadySentDuplicate(dealId: number): Promise<{ duplicateDealId: number | null; dealGroupKey: string | null }> {
  const result = await query<{ duplicateDealId: number | null; dealGroupKey: string | null }>(
    `select d2.id as "duplicateDealId",
            d.deal_group_key as "dealGroupKey"
     from public.deals d
     join public.deals d2 on d2.deal_group_key = d.deal_group_key and d2.id <> d.id
     join public.deal_publish_queue q2 on q2.deal_id = d2.id
     where d.id = $1
       and d.deal_group_key is not null
       and q2.channel = $2
       and q2.status = 'sent'
       and q2.sent_at >= now() - interval '72 hours'
     order by q2.sent_at desc
     limit 1`,
    [dealId, TELEGRAM_HOTDEAL_CHANNEL],
  );

  return result.rows[0] ?? { duplicateDealId: null, dealGroupKey: null };
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function formatPrice(input: string | null, currencyCode: string | null): string | null {
  if (!input) return null;
  const normalized = input.replace(/,/g, "");
  const value = Number(normalized);
  if (!Number.isFinite(value)) return input;

  const currency = (currencyCode ?? "KRW").toUpperCase();
  if (currency === "USD") {
    return `$${value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}`;
  }
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}

async function sendTelegramMessage(text: string, topicId: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      chat_id: TELEGRAM_CHAT_ID ?? "",
      message_thread_id: topicId,
      text,
      parse_mode: "MarkdownV2",
      disable_web_page_preview: "true",
    }),
  });

  const payload = (await response.json()) as { ok?: boolean; description?: string };
  if (!response.ok || payload.ok !== true) {
    throw new Error(
      `telegram sendMessage failed: http=${response.status}, body=${JSON.stringify(payload)}`,
    );
  }
}

async function sendTelegramPhoto(payload: {
  photo: string;
  caption: string;
  topicId: string;
}): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      chat_id: TELEGRAM_CHAT_ID ?? "",
      message_thread_id: payload.topicId,
      photo: payload.photo,
      caption: payload.caption,
      parse_mode: "MarkdownV2",
    }),
  });

  const data = (await response.json()) as { ok?: boolean; description?: string };
  if (!response.ok || data.ok !== true) {
    throw new Error(
      `telegram sendPhoto failed: http=${response.status}, body=${JSON.stringify(data)}`,
    );
  }
}

async function processBatch(): Promise<{ processed: number; sent: number; failed: number }> {
  const rows = await claimApprovedRows(CLAIM_LIMIT);
  if (rows.length === 0) {
    return { processed: 0, sent: 0, failed: 0 };
  }

  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    const mergedPayload = {
      ...(row.payloadJson ?? {}),
      ...(row.foodGroup ? { foodGroup: row.foodGroup } : {}),
      ...(row.unitBasis ? { unitBasis: row.unitBasis } : {}),
      ...(row.unitPrice ? { unitPrice: row.unitPrice } : {}),
      ...(row.benchmarkSampleSize != null ? { benchmarkSampleSize: row.benchmarkSampleSize } : {}),
      ...(row.benchmarkP25 ? { benchmarkP25: row.benchmarkP25 } : {}),
      ...(row.purchaseUrl ? { representativeUrl: row.purchaseUrl } : {}),
    };
    const link = row.purchaseUrl ?? extractQueueLinkFromPayload(mergedPayload);
    const text = buildTelegramMessage({
      title: row.title,
      price: formatPrice(row.price, row.currencyCode),
      shopName: row.shopName,
      categoryName: row.categoryName,
      link,
      payloadJson: mergedPayload,
    });

    const category = (row.categoryName ?? "").toUpperCase();
    const topicId =
      category === "HOME"
        ? TOPIC_HOME
        : category === "FOOD"
          ? TOPIC_FOOD
          : category === "DIGITAL" || category === "ELECTRONICS"
            ? TOPIC_DIGITAL
            : category === "FASHION"
              ? TOPIC_FASHION
              : undefined;

    if (!topicId) {
      const message = `unknown category or topic mapping: ${row.categoryName ?? ""}`;
      await markQueueSendFailed(row.id, message);
      failed += 1;
      logger.error({ queueId: row.id, dealId: row.dealId, error: message }, "telegram send failed");
      continue;
    }

    const duplicate = await hasAlreadySentDuplicate(row.dealId);
    if (duplicate.duplicateDealId) {
      await markQueueBlocked(
        row.id,
        `duplicate_sent_before_publish:${duplicate.duplicateDealId}:${duplicate.dealGroupKey ?? ''}`,
      );
      logger.warn(
        {
          queueId: row.id,
          dealId: row.dealId,
          duplicateDealId: duplicate.duplicateDealId,
          dealGroupKey: duplicate.dealGroupKey,
        },
        "telegram publish blocked duplicate before send",
      );
      continue;
    }

    try {
      if (row.thumbnailUrl) {
        await sendTelegramPhoto({
          photo: row.thumbnailUrl,
          caption: text,
          topicId,
        });
      } else {
        await sendTelegramMessage(text, topicId);
      }
      await markQueueSent(row.id);
      sent += 1;
    } catch (error) {
      const message = formatError(error);
      await markQueueSendFailed(row.id, message);
      failed += 1;
      logger.error({ queueId: row.id, dealId: row.dealId, error: message }, "telegram send failed");
    }
  }

  return { processed: rows.length, sent, failed };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  logger.info(
    {
      job: "publish:worker",
      loop: LOOP,
      batchLimit: CLAIM_LIMIT,
      channel: TELEGRAM_HOTDEAL_CHANNEL,
      chatId: TELEGRAM_CHAT_ID,
      topics: {
        HOME: TOPIC_HOME,
        FOOD: TOPIC_FOOD,
        DIGITAL: TOPIC_DIGITAL,
      },
    },
    "telegram publish worker started",
  );

  do {
    const result = await processBatch();
    logger.info({ job: "publish:worker", ...result }, "telegram publish worker batch done");

    if (!LOOP) return;
    await sleep(LOOP_INTERVAL_MS);
  } while (true);
}

main().catch((error) => {
  logger.error({ job: "publish:worker", error }, "telegram publish worker failed");
  process.exitCode = 1;
});
