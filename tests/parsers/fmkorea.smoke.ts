import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseList } from "../../src/parsers/fmkorea/parseList";
import { parseDetail } from "../../src/parsers/fmkorea/parseDetail";

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

const fixturesDir = join(__dirname, "..", "fixtures");
const listHtml = readFileSync(join(fixturesDir, "fmkorea-list.html"), "utf-8");
const detailHtml = readFileSync(join(fixturesDir, "fmkorea-detail.html"), "utf-8");

const listResult = parseList(listHtml);
assert(listResult.ok, "parseList should succeed");
assert(listResult.ok && listResult.data.items.length === 2, "list items length");
assert(listResult.ok && listResult.data.items[0].source === "fmkorea", "source");

const detailResult = parseDetail(detailHtml);
assert(detailResult.ok, "parseDetail should succeed");
assert(detailResult.ok && detailResult.data.price === 19900, "price parsed");
assert(detailResult.ok && detailResult.data.shippingType === "FREE", "shipping type");
assert(detailResult.ok && detailResult.data.outboundLinks.length === 1, "outbound links");

console.log("fmkorea parser smoke tests passed");
