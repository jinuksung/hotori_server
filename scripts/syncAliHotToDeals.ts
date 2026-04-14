import "dotenv/config";
import { withTx, query, pool } from "../src/db/client";
import { createDeal, updateDeal } from "../src/db/repos/deals.repo";
import { findBySourcePost, upsertSource } from "../src/db/repos/dealSources.repo";
import { insertLink } from "../src/db/repos/links.repo";
import { evaluateAndUpsertPublishQueue } from "../src/jobs/publishHelpers";
import { buildDealGroupKey } from "../src/utils/dealGrouping";
import { extractDomain } from "../src/utils/url";
import type { ShippingType } from "../src/types";

type AliRow = {
  product_id: string;
  product_title: string;
  product_url: string | null;
  affiliate_url: string | null;
  image_url: string | null;
  price: string | null;
  sale_price: string | null;
  mapped_category_id: string | null;
  shop_name: string | null;
};

const SOURCE = "aliexpress_hot";
const MIN_SALE_PRICE = Number(process.env.ALIEXPRESS_HOT_MIN_SALE_PRICE ?? "10000");

function pickRepresentativeUrl(row: AliRow): string | null {
  return row.affiliate_url;
}

function pickPrice(row: AliRow): number | null {
  const sale = row.sale_price ? Number(row.sale_price) : null;
  const price = row.price ? Number(row.price) : null;
  if (sale !== null && Number.isFinite(sale)) return sale;
  if (price !== null && Number.isFinite(price)) return price;
  return null;
}

function inferShippingType(url: string | null): ShippingType {
  if (!url) return "UNKNOWN";
  return /aliexpress\.com/i.test(url) ? "FREE" : "UNKNOWN";
}

async function main() {
  const { rows } = await query<AliRow>(
    `select product_id,
            product_title,
            product_url,
            affiliate_url,
            image_url,
            price::text,
            sale_price::text,
            mapped_category_id,
            shop_name
     from public.ali_hot_current
     where is_active = true
       and coalesce(sale_price, price) >= $1
       and mapped_category_id is not null
       and affiliate_url is not null
     order by last_seen_at desc`,
    [MIN_SALE_PRICE],
  );

  let inserted = 0;
  let updated = 0;
  let blocked = 0;

  for (const row of rows) {
    await withTx(async (client) => {
      const existingSource = await findBySourcePost(SOURCE, row.product_id, client);
      const representativeUrl = pickRepresentativeUrl(row);
      const price = pickPrice(row);
      const categoryId = Number(row.mapped_category_id);
      const dealGroupKey = buildDealGroupKey({
        categoryName: null,
        title: row.product_title,
        representativeUrl,
      });
      const shippingType = inferShippingType(representativeUrl);

      let dealId = existingSource?.dealId ?? null;
      if (!dealId) {
        const created = await createDeal(
          {
            categoryId,
            title: row.product_title,
            shopName: "알리익스프레스",
            subcategory: null,
            price,
            shippingType,
            soldOut: false,
            thumbnailUrl: row.image_url,
            dealGroupKey,
          },
          client,
        );
        dealId = created.id;
        inserted += 1;
      } else {
        await updateDeal(
          dealId,
          {
            categoryId,
            title: row.product_title,
            shopName: "알리익스프레스",
            subcategory: null,
            price,
            shippingType,
            soldOut: false,
            thumbnailUrl: row.image_url ?? existingSource.dealThumbnailUrl ?? null,
            dealGroupKey,
          },
          client,
        );
        updated += 1;
      }

      await upsertSource(
        {
          dealId,
          source: SOURCE,
          sourcePostId: row.product_id,
          postUrl: row.product_url ?? representativeUrl!,
          sourceCategoryId: null,
          title: row.product_title,
          thumbUrl: row.image_url,
          shopNameRaw: "AliExpress",
        },
        client,
      );

      if (representativeUrl) {
        const domain = extractDomain(representativeUrl);
        if (domain) {
          await insertLink(
            {
              dealId,
              url: representativeUrl,
              domain,
              isAffiliate: representativeUrl === row.affiliate_url,
            },
            client,
          );
        }
      }

      const decision = await evaluateAndUpsertPublishQueue(dealId, client);
      if (decision.status === "blocked") blocked += 1;
    });
  }

  console.log(JSON.stringify({ scanned: rows.length, inserted, updated, blocked, minSalePrice: MIN_SALE_PRICE }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
