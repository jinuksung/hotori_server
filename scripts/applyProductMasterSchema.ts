import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pool } from "../src/db/client";

async function main() {
  const sqlPath = resolve(process.cwd(), "sql/20260414_product_master_tables.sql");
  const sql = readFileSync(sqlPath, "utf8");
  await pool.query(sql);
  console.log(JSON.stringify({ applied: true, sqlPath }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
}).finally(async () => {
  await pool.end();
});
