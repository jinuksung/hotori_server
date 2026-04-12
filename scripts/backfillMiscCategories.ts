import "dotenv/config";
import { query } from "../src/db/client";
import { inferCategoryByKeywords } from "../src/jobs/pipelineHelpers";

const TARGET_CATEGORY_ID = 9; // MISC

async function main() {
  const categoryRows = await query<{ id: number; name: string }>(
    "select id, name from public.categories",
  );
  const categoryMap = new Map(categoryRows.rows.map((row) => [row.name, row.id]));

  const foodId = categoryMap.get("FOOD") ?? null;
  const homeId = categoryMap.get("HOME") ?? null;
  const digitalId = categoryMap.get("DIGITAL") ?? null;
  const fashionId = categoryMap.get("FASHION") ?? null;
  const electronicsId = categoryMap.get("ELECTRONICS") ?? null;

  const deals = await query<{ id: number; title: string }>(
    "select id, title from public.deals where category_id = $1",
    [TARGET_CATEGORY_ID],
  );

  let updated = 0;
  let skipped = 0;

  for (const row of deals.rows) {
    const inferred = inferCategoryByKeywords(row.title, null);
    let nextCategoryId: number | null = null;
    if (inferred === "FOOD") nextCategoryId = foodId;
    if (inferred === "HOME") nextCategoryId = homeId;
    if (inferred === "DIGITAL") nextCategoryId = digitalId;
    if (inferred === "FASHION") nextCategoryId = fashionId;
    if (inferred === "ELECTRONICS") nextCategoryId = electronicsId;

    if (!nextCategoryId) {
      skipped += 1;
      continue;
    }

    await query("update public.deals set category_id = $1, updated_at = now() where id = $2", [
      nextCategoryId,
      row.id,
    ]);
    updated += 1;
  }

  console.log("[DONE]", { total: deals.rows.length, updated, skipped });
}

main().catch((error) => {
  console.error("[FATAL] backfillMiscCategories failed", error);
  process.exitCode = 1;
});
