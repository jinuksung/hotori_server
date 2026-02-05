import "dotenv/config";
import { withTx, query, type DbClient } from "../src/db/client";

type ShopNameMappingInput = {
  source: string;
  rawName: string;
  normalizedName: string;
};

const SHOP_NAME_MAPPINGS: ShopNameMappingInput[] = [];

async function upsertShopNameMapping(
  input: ShopNameMappingInput,
  client: DbClient,
) {
  await query(
    `insert into public.shop_name_mappings (source, raw_name, normalized_name)
     values ($1, $2, $3)
     on conflict (source, raw_name) do update
       set normalized_name = excluded.normalized_name`,
    [input.source, input.rawName, input.normalizedName],
    client,
  );
}

async function main() {
  if (SHOP_NAME_MAPPINGS.length === 0) {
    console.log("[INFO] no shop name mappings provided; nothing to upload.");
    return;
  }

  await withTx(async (client) => {
    for (const mapping of SHOP_NAME_MAPPINGS) {
      await upsertShopNameMapping(mapping, client);
      console.log(
        `[OK] mapped ${mapping.source}:${mapping.rawName} -> ${mapping.normalizedName}`,
      );
    }
  });
}

main().catch((error) => {
  console.error("[FATAL] failed to seed shop name mappings", error);
  process.exit(1);
});
