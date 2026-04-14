import "dotenv/config";
import { pool, query } from "../src/db/client";
import { buildDealGroupKey } from "../src/utils/dealGrouping";

type Row = {
  id: number;
  title: string;
  category_name: string | null;
  representative_url: string | null;
  deal_group_key: string | null;
};

async function main() {
  const { rows } = await query<Row>(
    `select d.id,
            d.title,
            c.name as category_name,
            coalesce(resolved.url, purchase.url) as representative_url,
            d.deal_group_key
     from public.deals d
     left join public.categories c on c.id = d.category_id
     left join lateral (
       select dl.url
       from public.deal_links dl
       where dl.deal_id = d.id
         and dl.is_affiliate = true
       order by dl.id asc
       limit 1
     ) resolved on true
     left join lateral (
       select dl.url
       from public.deal_links dl
       where dl.deal_id = d.id
       order by dl.is_affiliate desc, dl.id asc
       limit 1
     ) purchase on true
     order by d.id asc`,
  );

  let scanned = 0;
  let updated = 0;

  for (const row of rows) {
    scanned += 1;
    const nextKey = buildDealGroupKey({
      categoryName: row.category_name,
      title: row.title,
      representativeUrl: row.representative_url,
    });

    if (nextKey === row.deal_group_key) {
      continue;
    }

    await query(`update public.deals set deal_group_key = $2, updated_at = now() where id = $1`, [row.id, nextKey]);
    updated += 1;
  }

  console.log(JSON.stringify({ scanned, updated }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
