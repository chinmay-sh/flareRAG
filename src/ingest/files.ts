import * as fs from "node:fs";
import * as path from "node:path";

// Node-only helpers shared by the ingest and R2-list scripts (not imported by the Worker).

export const EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".txt"]);
const SKIP_DIRS = new Set(["node_modules", ".git", ".wrangler"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/**
 * Maps each document's `source` (path relative to the docs root, forward slashes)
 * to its absolute file path. `source` is what Pinecone metadata stores and what
 * the R2 object key must be.
 */
export function listDocuments(root: string): Map<string, string> {
  return new Map(
    walk(root)
      .sort()
      .map((f) => [path.relative(root, f).split(path.sep).join("/"), f])
  );
}
