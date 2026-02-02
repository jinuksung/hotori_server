import "dotenv/config";
import { fetchFmkoreaDetailHtmls } from "../src/crawlers/fmkorea/detail";
import { parseFmHotdealDetail } from "../src/parsers/fmkorea/parseDetail";

const DEFAULT_IDS = [
  "9431626122",
  "9431391527",
  "9431393025",
  "9431367144",
  "9431261519",
  "9431248579",
  "9431229927",
  "9431163269",
  "9431026149",
  "9431012465",
  "9430975849",
  "9430973884",
  "9430966976",
  "9430957158",
  "9430957516",
  "9430863171",
  "9430816520",
  "9430753306",
  "9430746221",
  "9430733900",
];

const argUrls = process.argv.slice(2);
const targets = argUrls.length
  ? argUrls
  : DEFAULT_IDS.map((id) => `https://www.fmkorea.com/${id}`);

async function main() {
  const total = targets.length;

  for (const [index, targetUrl] of targets.entries()) {
    const sourcePostId = extractPostId(targetUrl);
    if (!sourcePostId) {
      console.error(`✖ Could not extract document_srl from ${targetUrl}`);
      continue;
    }

    console.log(`\n▶ [${index + 1}/${total}] Fetching FMKorea detail: ${targetUrl}`);

    const result = await fetchFmkoreaDetailHtmls([
      { sourcePostId, postUrl: targetUrl },
    ]);

    if (result.failures.length) {
      console.error("✖ Crawl failed:", result.failures[0]);
      continue;
    }

    const html = result.successes[0]?.html;
    if (!html) {
      console.error("✖ No HTML returned");
      continue;
    }

    const parsed = parseFmHotdealDetail(html);
    console.log("✅ Parsed detail summary:", {
      sourcePostId,
      title: parsed.title,
      price: parsed.price,
      shipping: parsed.shipping,
      viewCount: parsed.viewCount,
      upvoteCount: parsed.upvoteCount,
      commentCount: parsed.commentCount,
    });
  }
}

function extractPostId(url: string): string | null {
  const match = url.match(/\/(\d+)(?:$|\?)/);
  return match ? match[1] : null;
}

main().catch((error) => {
  console.error("✖ Unexpected failure:", error);
  process.exit(1);
});
