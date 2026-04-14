import "dotenv/config";
import { createLinkPriceDeepLink, isLinkPriceSupportedUrl } from "../src/utils/linkprice";

async function main() {
  const url = process.argv[2];
  if (!url) {
    throw new Error("usage: npx tsx scripts/testLinkPriceDeepLink.ts <url>");
  }

  if (!isLinkPriceSupportedUrl(url)) {
    throw new Error(`unsupported merchant url: ${url}`);
  }

  const deepLink = await createLinkPriceDeepLink(url);
  console.log(JSON.stringify({ input: url, deepLink }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
