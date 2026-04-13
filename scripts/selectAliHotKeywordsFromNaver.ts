import "dotenv/config";
import { query, pool } from "../src/db/client";
import { pickTopKeywordsPerCategory, TARGET_NAVER_CATEGORY_CIDS } from "../src/utils/shoppingKeywordSelection";

type Row = {
  category_name: string;
  category_cid: string;
  keyword: string;
  rank: number;
};

async function main() {
  const { rows } = await query<Row>(
    `with latest as (
       select max(collected_at) as collected_at
       from public.shopping_keyword_rank
       where category_cid = any($1::text[])
     )
     select category_name, category_cid, keyword, rank
     from public.shopping_keyword_rank
     where collected_at = (select collected_at from latest)
       and category_cid = any($1::text[])
     order by category_cid, rank asc`,
    [[...TARGET_NAVER_CATEGORY_CIDS]],
  );

  const picked = pickTopKeywordsPerCategory(rows, 3);
  const result = [...picked.entries()].map(([categoryCid, items]) => ({
    categoryCid,
    categoryName: items[0]?.category_name ?? null,
    keywords: items.map((item) => ({ keyword: item.keyword, rank: item.rank })),
  }));

  console.log(JSON.stringify({ categories: result, flatKeywords: result.flatMap((v) => v.keywords.map((k) => k.keyword)) }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
