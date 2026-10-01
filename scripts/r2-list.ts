/**
 * Writes r2-upload.json for `wrangler r2 bulk put` (uses your `wrangler login`, no R2 API keys).
 * Object keys match the `source` paths stored in Pinecone, so get_full_document finds them.
 * For large folders prefer `npm run r2:upload`, which stays under Cloudflare's API rate limit.
 *
 *   npm run r2:list -- [--corpus corpora/<name>.jsonc] [<docs-dir>]
 *   npx wrangler r2 bulk put <bucket> --filename r2-upload.json --remote
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadCorpusFromArgs } from "./lib/corpus";
import { listDocuments } from "../src/ingest/files";

const args: string[] = process.argv.slice(2);
const corpus = loadCorpusFromArgs(args);
const bucket = corpus.r2_bucket ?? "<bucket>";

const docsDir = path.resolve(args.find((a) => !a.startsWith("--")) ?? corpus.docs_dir ?? ".");
if (!fs.existsSync(docsDir)) {
  console.error(`❌ Directory not found: ${docsDir}`);
  process.exit(1);
}

const entries = [...listDocuments(docsDir)].map(([key, file]) => ({ key, file }));
const out = path.resolve("r2-upload.json");
fs.writeFileSync(out, JSON.stringify(entries, null, 1));
const bytes = entries.reduce((n, e) => n + fs.statSync(e.file).size, 0);

console.log(`Wrote ${entries.length.toLocaleString("en-US")} entries (${(bytes / 1024 ** 2).toFixed(1)} MB) to ${out}`);
console.log(`Example key: ${entries[0]?.key ?? "(none)"}\n`);
console.log("Upload with:");
console.log(`  npx wrangler r2 bulk put ${bucket} --filename r2-upload.json --remote --content-type "text/plain; charset=utf-8"`);
