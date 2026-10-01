/**
 * Verifies a corpus's settings before ingesting: Pinecone reachable + dimension matches,
 * embedding and rerank keys work.
 *   npm run check [-- --corpus corpora/<name>.jsonc]
 */
import { loadCorpusFromArgs } from "./lib/corpus";
import { createEmbedder, createReranker } from "../src/services/embeddings";
import { PineconeClient } from "../src/services/pinecone";

const corpus = loadCorpusFromArgs(process.argv.slice(2));

const env = process.env;
const dims = parseInt(env.EMBED_DIMENSIONS || "1024", 10);
const namespace = env.PINECONE_NAMESPACE!;
let ok = true;

async function step(name: string, fn: () => Promise<string>) {
  try {
    console.log(`✅ ${name}: ${await fn()}`);
  } catch (err) {
    ok = false;
    console.log(`❌ ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

console.log(`Corpus "${corpus.corpus}" (worker ${corpus.worker}, R2 bucket ${corpus.r2_bucket ?? "none"})\n`);

await step("Pinecone", async () => {
  const pc = new PineconeClient(env.PINECONE_INDEX_HOST ?? "", env.PINECONE_API_KEY ?? "", namespace);
  const s = await pc.describeStats();
  if (s.dimension && s.dimension !== dims) throw new Error(`index dimension ${s.dimension} ≠ EMBED_DIMENSIONS ${dims}`);
  const inNamespace = s.namespaces?.[namespace]?.vectorCount ?? 0;
  return `dimension ${s.dimension}, namespace "${namespace}": ${inNamespace} vectors (index total ${s.totalVectorCount ?? 0})`;
});

await step("Embeddings", async () => {
  const embedder = createEmbedder(env);
  const v = await embedder.embedQuery("setup check");
  if (v.length !== dims) throw new Error(`got ${v.length} dims, expected ${dims}`);
  return `${embedder.provider} / ${embedder.model} → ${v.length} dims`;
});

await step("Rerank", async () => {
  const reranker = createReranker(env);
  if (!reranker) return "disabled (RERANK_MODEL=none)";
  const hits = await reranker.rerank("setup check", ["setup check", "unrelated"], 1);
  return `${reranker.model} ok (top score ${hits[0]?.score.toFixed(3)})`;
});

process.exit(ok ? 0 : 1);
