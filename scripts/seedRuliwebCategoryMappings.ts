import "dotenv/config";
import { withTx, query, type DbClient } from "../src/db/client";

const SOURCE = "ruliweb";

type MappingInput = {
  sourceCategoryName: string;
  categoryName: string;
  sourceCategoryKey?: string;
};

const MAPPINGS: MappingInput[] = [
  { sourceCategoryName: "공지", categoryName: "ETC" },
  { sourceCategoryName: "상품권", categoryName: "GIFT" },
  { sourceCategoryName: "게임S/W", categoryName: "GAME" },
  { sourceCategoryName: "게임H/W", categoryName: "GAME" },
  { sourceCategoryName: "PC/가전", categoryName: "ELECTRONICS" },
  { sourceCategoryName: "PC/가전.", categoryName: "ELECTRONICS" },
  { sourceCategoryName: "A/V", categoryName: "ELECTRONICS" },
  { sourceCategoryName: "VR", categoryName: "ELECTRONICS" },
  { sourceCategoryName: "음식", categoryName: "FOOD" },
  { sourceCategoryName: "의류", categoryName: "FASHION" },
  { sourceCategoryName: "취미용품", categoryName: "LIFE" },
  { sourceCategoryName: "인테리어", categoryName: "HOME" },
  { sourceCategoryName: "생활용품", categoryName: "HOME" },
  { sourceCategoryName: "육아용품", categoryName: "BABY" },
  { sourceCategoryName: "레저용품", categoryName: "LIFE" },
  { sourceCategoryName: "휴대폰", categoryName: "MOBILE" },
  { sourceCategoryName: "도서", categoryName: "LIFE" },
  { sourceCategoryName: "화장품", categoryName: "BEAUTY" },
];

async function findSourceCategoryId(
  input: MappingInput,
  client: DbClient,
): Promise<{ id: number; sourceKey: string } | null> {
  if (input.sourceCategoryKey) {
    const result = await query<{ id: number; source_key: string }>(
      `select id, source_key
       from public.source_categories
       where source = $1 and source_key = $2
       limit 1`,
      [SOURCE, input.sourceCategoryKey],
      client,
    );
    return result.rows[0] ?? null;
  }

  const result = await query<{ id: number; source_key: string }>(
    `select id, source_key
     from public.source_categories
     where source = $1 and name = $2
     order by id desc`,
    [SOURCE, input.sourceCategoryName],
    client,
  );

  if (result.rows.length > 1) {
    console.warn(
      `[WARN] multiple source categories found for name=${input.sourceCategoryName}; using latest.`,
      result.rows.map((row) => row.source_key),
    );
  }

  return result.rows[0] ?? null;
}

async function findCategoryIdByName(
  name: string,
  client: DbClient,
): Promise<number | null> {
  const result = await query<{ id: number }>(
    `select id
     from public.categories
     where name = $1
     limit 1`,
    [name],
    client,
  );
  return result.rows[0]?.id ?? null;
}

async function upsertCategoryMapping(
  sourceCategoryId: number,
  categoryId: number,
  client: DbClient,
) {
  await query(
    `insert into public.category_mappings (source_category_id, category_id)
     values ($1, $2)
     on conflict (source_category_id) do update
       set category_id = excluded.category_id`,
    [sourceCategoryId, categoryId],
    client,
  );
}

async function main() {
  await withTx(async (client) => {
    for (const mapping of MAPPINGS) {
      const sourceCategory = await findSourceCategoryId(mapping, client);
      if (!sourceCategory) {
        console.warn(
          `[SKIP] source category not found: ${mapping.sourceCategoryName}`,
        );
        continue;
      }

      const categoryId = await findCategoryIdByName(
        mapping.categoryName,
        client,
      );
      if (!categoryId) {
        console.warn(`[SKIP] category not found: ${mapping.categoryName}`);
        continue;
      }

      await upsertCategoryMapping(sourceCategory.id, categoryId, client);
      console.log(
        `[OK] mapped ${mapping.sourceCategoryName} (${sourceCategory.sourceKey}) -> ${mapping.categoryName}`,
      );
    }
  });
}

main().catch((error) => {
  console.error("[FATAL] failed to seed ruliweb category mappings", error);
  process.exit(1);
});
