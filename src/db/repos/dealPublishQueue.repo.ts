// 역할: deal_publish_queue 테이블의 조회/업서트/상태 변경 레포지토리.

import { query, type DbClient } from "../client";
import {
  TELEGRAM_HOTDEAL_CHANNEL,
  TELEGRAM_HOTDEAL_MAX_RETRIES,
} from "../../utils/publishPolicy";

export type PublishStatus =
  | "hold"
  | "ready"
  | "blocked"
  | "sent"
  | "failed";

export type UpsertPublishQueueInput = {
  dealId: number;
  channel?: string;
  status: PublishStatus;
  score?: number;
  reason: string | null;
  payloadJson?: Record<string, unknown> | null;
};

export type ReadyPublishRow = {
  id: number;
  dealId: number;
  channel: string;
  status: PublishStatus;
  score: number;
  reason: string | null;
  payloadJson: Record<string, unknown> | null;
  sendError: string | null;
  retryCount: number;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  title: string;
  shopName: string | null;
  price: string | null;
  thumbnailUrl: string | null;
  categoryName: string | null;
  purchaseUrl: string | null;
  purchaseDomain: string | null;
};

export async function upsertPublishQueue(
  input: UpsertPublishQueueInput,
  client?: DbClient,
): Promise<void> {
  await query(
    `insert into public.deal_publish_queue
      (deal_id, channel, status, score, reason, payload_json)
     values
      ($1, $2, $3, $4, $5, $6)
     on conflict (deal_id, channel) do update
       set status = case
             when public.deal_publish_queue.status = 'sent' and excluded.status <> 'sent'
               then public.deal_publish_queue.status
             else excluded.status
           end,
           score = case
             when public.deal_publish_queue.status = 'sent' and excluded.status <> 'sent'
               then public.deal_publish_queue.score
             else excluded.score
           end,
           reason = case
             when public.deal_publish_queue.status = 'sent' and excluded.status <> 'sent'
               then public.deal_publish_queue.reason
             else excluded.reason
           end,
           payload_json = case
             when public.deal_publish_queue.status = 'sent' and excluded.status <> 'sent'
               then public.deal_publish_queue.payload_json
             else excluded.payload_json
           end,
           updated_at = now(),
           send_error = case
             when public.deal_publish_queue.status = 'sent' and excluded.status <> 'sent'
               then public.deal_publish_queue.send_error
             else null
           end,
           sent_at = case
             when public.deal_publish_queue.status = 'sent' and excluded.status <> 'sent'
               then public.deal_publish_queue.sent_at
             when excluded.status = 'sent'
               then public.deal_publish_queue.sent_at
             else null
           end`,
    [
      input.dealId,
      input.channel ?? TELEGRAM_HOTDEAL_CHANNEL,
      input.status,
      input.score ?? 0,
      input.reason,
      input.payloadJson ?? null,
    ],
    client,
  );
}

export async function listReadyPublishQueue(
  limit: number,
  client?: DbClient,
): Promise<ReadyPublishRow[]> {
  const result = await query<{
    id: number;
    dealId: number;
    channel: string;
    status: PublishStatus;
    score: number;
    reason: string | null;
    payloadJson: Record<string, unknown> | null;
    sendError: string | null;
    retryCount: number;
    createdAt: string;
    updatedAt: string;
    sentAt: string | null;
    title: string;
    shopName: string | null;
    price: string | null;
    thumbnailUrl: string | null;
    categoryName: string | null;
    purchaseUrl: string | null;
    purchaseDomain: string | null;
  }>(
    `select q.id,
            q.deal_id as "dealId",
            q.channel,
            q.status,
            q.score,
            q.reason,
            q.payload_json as "payloadJson",
            q.send_error as "sendError",
            coalesce((q.payload_json->>'retryCount')::int, 0) as "retryCount",
            q.created_at as "createdAt",
            q.updated_at as "updatedAt",
            q.sent_at as "sentAt",
            d.title,
            d.shop_name as "shopName",
            d.price::text as price,
            d.thumbnail_url as "thumbnailUrl",
            c.name as "categoryName",
            link.url as "purchaseUrl",
            link.domain as "purchaseDomain"
     from public.deal_publish_queue q
     join public.deals d on d.id = q.deal_id
     left join public.categories c on c.id = d.category_id
     left join lateral (
       select dl.url, dl.domain
       from public.deal_links dl
       where dl.deal_id = d.id
       order by dl.is_affiliate desc, dl.id asc
       limit 1
     ) link on true
     where q.channel = $1
       and (
         q.status = 'ready'
         or (
           q.status = 'failed'
           and coalesce((q.payload_json->>'retryCount')::int, 0) < $3
         )
       )
       and q.sent_at is null
     order by q.created_at asc
     limit $2`,
    [TELEGRAM_HOTDEAL_CHANNEL, limit, TELEGRAM_HOTDEAL_MAX_RETRIES],
    client,
  );

  return result.rows;
}

export async function markPublishSent(
  id: number,
  client?: DbClient,
): Promise<void> {
  await query(
    `update public.deal_publish_queue
     set status = 'sent',
         sent_at = now(),
         send_error = null,
         updated_at = now()
     where id = $1`,
    [id],
    client,
  );
}

export async function markPublishFailed(
  id: number,
  errorMessage: string,
  client?: DbClient,
): Promise<void> {
  await query(
    `update public.deal_publish_queue
     set status = 'failed',
         send_error = $2,
         payload_json = coalesce(payload_json, '{}'::jsonb)
           || jsonb_build_object(
                'retryCount', coalesce((payload_json->>'retryCount')::int, 0) + 1
              ),
         updated_at = now()
     where id = $1`,
    [id, errorMessage],
    client,
  );
}
