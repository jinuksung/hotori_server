// 역할: 딜 발송 적합성 판정과 메시지 렌더링을 제공한다.

import { query, type DbClient } from "../db/client";
import { upsertPublishQueue } from "../db/repos/dealPublishQueue.repo";
import {
  getPublishCategoryTag,
  hasNonProductKeyword,
  isAllowedPublishCategory,
  TELEGRAM_HOTDEAL_CHANNEL,
} from "../utils/publishPolicy";

export type PublishDecision = {
  status: "ready" | "approved" | "blocked" | "hold";
  score: number;
  reason: string;
  payloadJson?: Record<string, unknown> | null;
};

export async function autoApproveExistingCheapFood(client?: DbClient): Promise<number[]> {
  const result = await query<{ dealId: number }>(
    `select d.id as "dealId"
     from public.deals d
     join public.categories c on c.id = d.category_id
     join public.deal_food_unit_metrics m on m.deal_id = d.id
     join public.food_group_price_benchmarks b
       on b.food_group = m.food_group and b.unit_basis = m.unit_basis
     where c.name = 'FOOD'
       and d.created_at >= now() - interval '12 hours'
       and m.unit_price < b.p25
       and b.sample_size >= 8
       and m.confidence >= 0.8
       and d.title !~ '(3종|골라담기|외\s*\d+종|혼합|세트|구성)'`
    , [], client);

  const approved: number[] = [];
  for (const row of result.rows) {
    const decision = await evaluateAndUpsertPublishQueue(row.dealId, client);
    if (decision.status === "approved") approved.push(row.dealId);
  }
  return approved;
}

export async function evaluateAndUpsertPublishQueue(
  dealId: number,
  client?: DbClient,
): Promise<PublishDecision> {
  const row = await getDealPublishCandidate(dealId, client);
  if (!row) {
    throw new Error(`deal not found for publish evaluation: ${dealId}`);
  }

  const decision = decidePublish(row);
  await upsertPublishQueue(
    {
      dealId,
      channel: TELEGRAM_HOTDEAL_CHANNEL,
      status: decision.status,
      score: decision.score,
      reason: decision.reason,
      payloadJson: decision.payloadJson ?? null,
    },
    client,
  );

  return decision;
}

export function renderTelegramHotdealMessage(input: {
  title: string;
  price: string | null;
  shopName: string | null;
  purchaseUrl: string;
  categoryName: string | null;
}): string {
  const lines: string[] = [];
  lines.push(input.title);

  const metaParts = [input.price ? `${input.price}원` : null, input.shopName]
    .filter(Boolean)
    .join(" / ");
  if (metaParts) {
    lines.push(metaParts);
    lines.push("");
  }

  lines.push(`구매: ${input.purchaseUrl}`);

  const tag = getPublishCategoryTag(input.categoryName);
  if (tag) {
    lines.push("");
    lines.push(tag);
  }

  return lines.join("\n");
}

type DealPublishCandidate = {
  dealId: number;
  title: string;
  price: number | null;
  soldOut: boolean;
  shopName: string | null;
  thumbnailUrl: string | null;
  categoryName: string | null;
  purchaseUrl: string | null;
  resolvedUrl: string | null;
  hasAffiliateLink: boolean;
  foodGroup: string | null;
  unitBasis: string | null;
  unitPrice: number | null;
  confidence: number | null;
  benchmarkSampleSize: number | null;
  benchmarkP25: number | null;
};

function isBlockedCommunityUrl(value: string | null | undefined): boolean {
  if (!value) return false;
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

function decidePublish(row: DealPublishCandidate): PublishDecision {
  if (!isAllowedPublishCategory(row.categoryName)) {
    return { status: "hold", score: 0, reason: "category_not_allowed" };
  }

  if (row.price === null) {
    return { status: "blocked", score: 0, reason: "missing_price" };
  }

  if (row.soldOut) {
    return { status: "blocked", score: 0, reason: "sold_out" };
  }

  if (hasNonProductKeyword(row.title)) {
    return { status: "blocked", score: 0, reason: "non_product_keyword" };
  }

  const representativeUrl = [row.resolvedUrl, row.purchaseUrl].find(
    (value) => value && !isBlockedCommunityUrl(value),
  ) ?? null;
  if (!representativeUrl) {
    return { status: "blocked", score: 0, reason: "missing_purchase_url" };
  }

  const autoApproveFoodCheap = process.env.AUTO_APPROVE_FOOD_CHEAP === "true";
  const isCheapFoodCandidate =
    autoApproveFoodCheap
    && (row.categoryName ?? "").trim().toUpperCase() === "FOOD"
    && row.unitPrice !== null
    && row.benchmarkP25 !== null
    && row.unitPrice < row.benchmarkP25
    && (row.benchmarkSampleSize ?? 0) >= 8
    && (row.confidence ?? 0) >= 0.8
    && !/(3종|골라담기|외\s*\d+종|혼합|세트|구성)/i.test(row.title);

  return {
    status: autoApproveFoodCheap && isCheapFoodCandidate ? "approved" : "ready",
    score: isCheapFoodCandidate ? 2 : 1,
    reason: isCheapFoodCandidate
      ? "auto_approved_food_cheap"
      : (row.resolvedUrl ? "ready_resolved_url" : "ready_purchase_url"),
    payloadJson: {
      representativeUrl,
      retryCount: 0,
      autoApproved: isCheapFoodCandidate,
      foodGroup: row.foodGroup,
      unitBasis: row.unitBasis,
      unitPrice: row.unitPrice,
      benchmarkSampleSize: row.benchmarkSampleSize,
      benchmarkP25: row.benchmarkP25,
    },
  };
}

async function getDealPublishCandidate(
  dealId: number,
  client?: DbClient,
): Promise<DealPublishCandidate | null> {
  const result = await query<DealPublishCandidate>(
    `select d.id as "dealId",
            d.title,
            d.price,
            d.sold_out as "soldOut",
            d.shop_name as "shopName",
            d.thumbnail_url as "thumbnailUrl",
            c.name as "categoryName",
            purchase.url as "purchaseUrl",
            resolved.url as "resolvedUrl",
            exists (
              select 1
              from public.deal_links dl_aff
              where dl_aff.deal_id = d.id and dl_aff.is_affiliate = true
            ) as "hasAffiliateLink",
            m.food_group as "foodGroup",
            m.unit_basis as "unitBasis",
            m.unit_price as "unitPrice",
            m.confidence,
            b.sample_size as "benchmarkSampleSize",
            b.p25 as "benchmarkP25"
     from public.deals d
     left join public.categories c on c.id = d.category_id
     left join lateral (
       select dl.url
       from public.deal_links dl
       where dl.deal_id = d.id
         and coalesce(dl.domain, '') not in ('ppomppu.co.kr', 'www.ppomppu.co.kr', 'fmkorea.com', 'www.fmkorea.com', 'ruliweb.com', 'www.ruliweb.com', 'youtube.com', 'www.youtube.com', 'youtu.be')
       order by dl.is_affiliate desc, dl.id asc
       limit 1
     ) purchase on true
     left join lateral (
       select dl.url
       from public.deal_links dl
       where dl.deal_id = d.id
         and dl.is_affiliate = true
         and coalesce(dl.domain, '') not in ('ppomppu.co.kr', 'www.ppomppu.co.kr', 'fmkorea.com', 'www.fmkorea.com', 'ruliweb.com', 'www.ruliweb.com', 'youtube.com', 'www.youtube.com', 'youtu.be')
       order by dl.id asc
       limit 1
     ) resolved on true
     left join public.deal_food_unit_metrics m on m.deal_id = d.id
     left join public.food_group_price_benchmarks b
       on b.food_group = m.food_group and b.unit_basis = m.unit_basis
     where d.id = $1
       and d.created_at >= now() - interval '12 hours'`,
    [dealId],
    client,
  );

  return result.rows[0] ?? null;
}
