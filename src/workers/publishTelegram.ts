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
  shopName: string | null;
  categoryName: string | null;
};

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_TARGET_CHAT_ID?.trim();
const TOPIC_HOME = process.env.TELEGRAM_TOPIC_HOME?.trim();
const TOPIC_FOOD = process.env.TELEGRAM_TOPIC_FOOD?.trim();
const TOPIC_DIGITAL = process.env.TELEGRAM_TOPIC_DIGITAL?.trim();
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
              d.title,
              d.price::text as price,
              d.shop_name as "shopName",
              cat.name as "categoryName"
       from claimed c
       join public.deals d on d.id = c."dealId"
       left join public.categories cat on cat.id = d.category_id
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

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

async function sendTelegramMessage(text: string, topicId: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      chat_id: TELEGRAM_CHAT_ID,
      message_thread_id: topicId,
      text,
    }),
  });

  const payload = (await response.json()) as { ok?: boolean; description?: string };
  if (!response.ok || payload.ok !== true) {
    throw new Error(
      `telegram sendMessage failed: http=${response.status}, body=${JSON.stringify(payload)}`,
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
    const link = extractQueueLinkFromPayload(row.payloadJson);
    const text = buildTelegramMessage({
      title: row.title,
      price: row.price,
      shopName: row.shopName,
      categoryName: row.categoryName,
      link,
    });

    const category = (row.categoryName ?? "").toUpperCase();
    const topicId =
      category === "HOME"
        ? TOPIC_HOME
        : category === "FOOD"
          ? TOPIC_FOOD
          : category === "DIGITAL" || category === "ELECTRONICS"
            ? TOPIC_DIGITAL
            : undefined;

    if (!topicId) {
      const message = `unknown category or topic mapping: ${row.categoryName ?? ""}`;
      await markQueueSendFailed(row.id, message);
      failed += 1;
      logger.error({ queueId: row.id, dealId: row.dealId, error: message }, "telegram send failed");
      continue;
    }

    try {
      await sendTelegramMessage(text, topicId);
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
