import { dedupe } from "../src/services/dedupe";

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

console.log("Running dedupe tests...");

const memo =
  "The remote viewing session begins with the monitor providing coordinates to the viewer. " +
  "The viewer records initial impressions, sketches major gestalts, and the monitor notes the time " +
  "of each phase. Sessions last between thirty and ninety minutes depending on the target.";

const items = [
  { id: "a", text: memo },
  // Same memo, different OCR noise and case
  { id: "b", text: memo.toUpperCase().replace("thirty", "thlrty").replace("  ", " ") },
  // Same memo, shifted chunk boundary (starts mid-paragraph, extra trailing text)
  { id: "c", text: memo.slice(memo.indexOf("The viewer")) + " Results are forwarded to the project office." },
  // Unrelated passage
  { id: "d", text: "Funding levels for the three-year program: FY 1981 $418.5K, FY 1982 $518K, FY 1983 pending approval." },
  // Short heading-only chunks: identical ones merge, different ones don't
  { id: "e", text: "(4) REMOTE VIEWING SESSION" },
  { id: "f", text: "(4) remote viewing session" },
  { id: "g", text: "(5) ANALYSIS" },
];

const groups = dedupe(items, (i) => i.text);
const byId = Object.fromEntries(groups.map((g) => [g.item.id, g.duplicates.map((d) => d.id)]));

assert(groups.length === 4, `expected 4 groups, got ${groups.length}: ${JSON.stringify(byId)}`);
assert(JSON.stringify(byId.a) === JSON.stringify(["b", "c"]), `a should absorb b and c, got ${byId.a}`);
assert(byId.d?.length === 0, "unrelated passage must stay separate");
assert(JSON.stringify(byId.e) === JSON.stringify(["f"]), "identical short chunks should merge");
assert(byId.g?.length === 0, "different short chunks must not merge");
assert(groups[0].item.id === "a", "order (best first) must be preserved");

console.log("✅ All dedupe tests passed!");
