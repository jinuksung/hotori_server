import "dotenv/config";
import { pool, query } from "../src/db/client";

const BATCH_SIZE = Number(process.env.REDIRECT_LINK_RESOLVE_BATCH_SIZE ?? "100");
const USER_AGENT = "Mozilla/5.0";

type Row = {
  source_url: string;
  source_type: string | null;
};

async function followRedirect(url: string): Promise<string | null> {
  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent": USER_AGENT,
    },
  });
  return response.url || null;
}

async function main() {
  const { rows } = await query<Row>(
    `select source_url, source_type
     from public.link_resolutions
     where status = 'pending'
       and source_type in ('gmarket_redirect', 'linkprice')
     order by updated_at asc
     limit $1`,
    [BATCH_SIZE],
  );

  let scanned = 0;
  let resolved = 0;
  let failed = 0;

  for (const row of rows) {
    scanned += 1;
    try {
      const resolvedUrl = await followRedirect(row.source_url);
      if (!resolvedUrl || resolvedUrl === row.source_url) {
        throw new Error("redirect_not_resolved");
      }

      await query(
        `update public.link_resolutions
         set status = 'resolved',
             resolved_url = $2,
             resolved_by = 'redirect-follow',
             updated_at = now()
         where source_url = $1`,
        [row.source_url, resolvedUrl],
      );
      resolved += 1;
    } catch (error) {
      failed += 1;
      console.error({ sourceUrl: row.source_url, sourceType: row.source_type, error });
    }
  }

  console.log(JSON.stringify({ scanned, resolved, failed }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
