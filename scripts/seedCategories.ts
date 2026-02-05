// 역할: public.categories 테이블에 카테고리 이름들을 upsert로 넣어주는 시드 스크립트.
import "dotenv/config";
import { withTx, query, type DbClient } from "../src/db/client";

type CategoryInput = {
  name: string;
};

const CATEGORIES: CategoryInput[] = [
  { name: "ELECTRONICS" },
  { name: "LIFE" },
  { name: "BABY" },
  { name: "FASHION" },
  { name: "MOBILE" },
];

async function upsertCategory(input: CategoryInput, client: DbClient) {
  await query(
    `insert into public.categories (name)
     values ($1)
     on conflict (name) do nothing`,
    [input.name],
    client,
  );
}

async function main() {
  await withTx(async (client) => {
    for (const category of CATEGORIES) {
      await upsertCategory(category, client);
      console.log(`[OK] ensured category: ${category.name}`);
    }
  });
}

main().catch((error) => {
  console.error("[FATAL] failed to seed categories", error);
  process.exit(1);
});
