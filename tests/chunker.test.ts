import { chunkDocument, extractTitle } from "../src/ingest/chunker";

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

console.log("Running chunker tests...");

// 1. Markdown header splitting + heading paths
const markdownSample = `
# Title

Introduction paragraph with some text.

## Section 1: Edge Routing

Routing details here. We route requests quickly across points of presence.

### Subsection 1.1

Fine-grained routing details.

## Section 2: Storage

Storage details here.

\`\`\`bash
# not a heading inside a code fence
echo hi
\`\`\`
`;

const chunks = await chunkDocument("docs/doc-1.md", markdownSample, {
  maxChunkSize: 200,
  chunkOverlap: 20,
  title: "Test Architecture Document",
});

console.log(`Produced ${chunks.length} chunks.`);
assert(chunks.length >= 4, `Expected at least 4 chunks, got ${chunks.length}`);
assert(chunks[0].metadata.title === "Test Architecture Document", "Title match failed");
assert(chunks.every((c) => c.metadata.totalChunks === chunks.length), "totalChunks mismatch");
assert(
  chunks.some((c) => c.metadata.section === "Title > Section 1: Edge Routing > Subsection 1.1"),
  "Nested heading path missing"
);
assert(
  chunks.some((c) => c.metadata.section === "Title > Section 2: Storage" && c.metadata.text.includes("not a heading")),
  "Code-fence comment was treated as a heading"
);
assert(
  chunks.every((c) => c.embedText.startsWith("Test Architecture Document") && c.embedText.endsWith(c.metadata.text)),
  "embedText should be title/section prefix + chunk text"
);
assert(chunks.every((c) => !c.metadata.text.startsWith("Test Architecture Document >")), "metadata.text must be raw text");

// 2. Size limit respected for long unbroken text
const longPara = "word ".repeat(3000);
const longChunks = await chunkDocument("long.txt", longPara, { maxChunkSize: 500, chunkOverlap: 50 });
assert(longChunks.length > 5, "Long paragraph should be split");
assert(longChunks.every((c) => c.metadata.text.length <= 500), "Chunk exceeded maxChunkSize");

// 3. IDs: stable, unique across long similar paths, and short
const base = "a/very/long/folder/structure/that/goes/on/and/on/for/more/than/sixty/four/characters";
const a = await chunkDocument(`${base}/file-one.md`, "hello world");
const b = await chunkDocument(`${base}/file-two.md`, "hello world");
const a2 = await chunkDocument(`${base}/file-one.md`, "different content");
assert(a[0].id !== b[0].id, "IDs collided for different long paths");
assert(a[0].id === a2[0].id, "IDs must depend on the path only (stable across content changes)");
assert(a[0].id.length <= 64, "ID too long");

// 4. Small-section merging (verse + commentary headings every few lines)
const verses = Array.from(
  { length: 12 },
  (_, i) => `## Chapter 1\n\n### verse ${i + 1}\n\nśloka text number ${i + 1} ..${i + 1}..\n\n### vyākhyā\n\ncommentary on verse ${i + 1}.`
).join("\n\n");
const unmerged = await chunkDocument("verses.md", verses, { maxChunkSize: 400 });
const merged = await chunkDocument("verses.md", verses, { maxChunkSize: 400, minChunkSize: 250 });
assert(merged.length < unmerged.length / 2, `merging should cut chunk count (${unmerged.length} → ${merged.length})`);
assert(merged.every((c) => c.metadata.text.length <= 400), "merged chunk exceeded maxChunkSize");
assert(merged.slice(0, -1).every((c) => c.metadata.text.length >= 250), "non-final merged chunks should reach minChunkSize");
assert(merged.every((c) => c.metadata.section === "Chapter 1"), `merged sections should share the common heading, got ${merged[0].metadata.section}`);
assert(merged.map((c) => c.metadata.text).join(" ").includes("commentary on verse 12"), "no text may be lost when merging");

// 5. Title extraction
assert(extractTitle("intro\n# Real Title\ntext", "fallback") === "Real Title", "H1 title extraction failed");
assert(extractTitle("no headings", "fallback") === "fallback", "Title fallback failed");

console.log("✅ All chunker tests passed!");
