import "dotenv/config";
import { pool, query } from "../src/db/client";

const BATCH_SIZE = Number(process.env.STRUCTURED_LINK_RESOLVE_BATCH_SIZE ?? "100");

type Row = {
  source_url: string;
  source_type: string | null;
};

function resolveStructuredUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    if (host === "link.coupang.com") {
      const pageKey = parsed.searchParams.get("pageKey");
      const itemId = parsed.searchParams.get("itemId");
      const vendorItemId = parsed.searchParams.get("vendorItemId");
      if (pageKey && itemId && vendorItemId) {
        return `https://www.coupang.com/vp/products/${pageKey}?itemId=${itemId}&vendorItemId=${vendorItemId}`;
      }
      return null;
    }

    if (host === "click.linkprice.com") {
      const target = parsed.searchParams.get("tu") ?? parsed.searchParams.get("url");
      return target ? decodeURIComponent(target) : null;
    }

    if (host === "s.ppomppu.co.kr") {
      const target = parsed.searchParams.get("target") ?? parsed.searchParams.get("url") ?? parsed.searchParams.get("u");
      if (!target) return null;
      try {
        return Buffer.from(target, "base64").toString("utf8");
      } catch {
        return decodeURIComponent(target);
      }
    }

    if (host === "link.gmarket.co.kr") {
      const target = parsed.searchParams.get("url") ?? parsed.searchParams.get("target");
      return target ? decodeURIComponent(target) : null;
    }

    return null;
  } catch {
    return null;
  }
}

async function main() {
  const { rows } = await query<Row>(
    `select source_url, source_type
     from public.link_resolutions
     where status = 'pending'
       and source_type in ('ppomppu_short', 'gmarket_redirect', 'linkprice', 'coupang_affiliate')
     order by updated_at asc
     limit $1`,
    [BATCH_SIZE],
  );

  let scanned = 0;
  let resolved = 0;
  let invalid = 0;

  for (const row of rows) {
    scanned += 1;
    const resolvedUrl = resolveStructuredUrl(row.source_url);
    if (resolvedUrl) {
      await query(
        `update public.link_resolutions
         set status = 'resolved',
             resolved_url = $2,
             resolved_by = 'structured',
             updated_at = now()
         where source_url = $1`,
        [row.source_url, resolvedUrl],
      );
      resolved += 1;
    } else {
      await query(
        `update public.link_resolutions
         set status = 'invalid',
             updated_at = now()
         where source_url = $1`,
        [row.source_url],
      );
      invalid += 1;
    }
  }

  console.log(JSON.stringify({ scanned, resolved, invalid }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});
