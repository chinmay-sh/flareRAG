/**
 * Local ingestion: docs folder → chunks → embeddings (Voyage or Gemini) → Pinecone.
 * Optionally uploads the raw files to R2 so the Worker can serve full documents.
 *
 *   npm run ingest -- [--corpus corpora/<name>.jsonc] [<docs-dir>] [--dry-run] [--upload-r2] [--force] [--no-prune]
 *
 * Settings (Pinecone namespace, embedding model, chunking, R2 bucket, default docs folder) come
 * from the corpus file (or CORPUS in .env) merged with wrangler.jsonc; API keys come from .env.
 * Progress is checkpointed in .ingest-manifest.<name>.json after every batch, so an
 * interrupted run resumes where it stopped and unchanged files are skipped.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { loadCorpusFromArgs } from "./lib/corpus";
import { chunkDocument, extractTitle, sha256Hex, type DocumentChunk } from "../src/ingest/chunker";
import { createEmbedder, embedDocumentGroups, resolveEmbeddingSettings } from "../src/services/embeddings";
import { PineconeClient, type PineconeRecord } from "../src/services/pinecone";
import { listDocuments } from "../src/ingest/files";

const FLUSH_CHUNKS = 256; // embed + upsert once this many chunks are pending
const MAX_UPSERT_BYTES = 1_800_000; // Pinecone request limit is 2 MB
const MAX_UPSERT_RECORDS = 1000;
const PINECONE_FREE_BYTES = 2 * 1024 ** 3;
const LEGACY_MANIFEST_PATH = path.resolve(".ingest-manifest.json");

// ─── CLI ──────────────────────────────────────────────────────────────────────
const args: string[] = process.argv.slice(2);
const CORPUS = loadCorpusFromArgs(args);
const MANIFEST_PATH = CORPUS.manifestPath;
const flags = new Set(args.filter((a) => a.startsWith("--")));
const DOCS_ARG = args.find((a) => !a.startsWith("--")) ?? CORPUS.docs_dir;
const DOCS_DIR = DOCS_ARG ? path.resolve(DOCS_ARG) : "";
const DRY_RUN = flags.has("--dry-run");
const UPLOAD_R2 = flags.has("--upload-r2");
const FORCE = flags.has("--force");
const PRUNE = !flags.has("--no-prune");
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || "2000", 10);
const CHUNK_OVERLAP = parseInt(process.env.CHUNK_OVERLAP || "200", 10);
const CHUNK_MIN_SIZE = parseInt(process.env.CHUNK_MIN_SIZE || "0", 10); // merge sections smaller than this
const CHUNK_OPTS = { maxChunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP, minChunkSize: CHUNK_MIN_SIZE };

// ─── Manifest ─────────────────────────────────────────────────────────────────
interface FileEntry {
  sha: string;
  chunks: number;
  r2?: boolean;
}
interface Manifest {
  version: 1;
  index: IndexSignature;
  roots: Record<string, Record<string, FileEntry>>;
}
interface IndexSignature {
  host: string;
  namespace: string;
  provider: string;
  model: string;
  dimensions: number;
  contextEmbeddingEnabled: boolean;
  chunkSize: number;
  chunkOverlap: number;
  chunkMinSize: number;
}

function loadManifest(sig: IndexSignature): Manifest {
  const fresh: Manifest = { version: 1, index: sig, roots: {} };
  adoptLegacyManifest(sig);
  if (!fs.existsSync(MANIFEST_PATH)) return fresh;
  const m = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf-8")) as Manifest;
  if (m.index) {
    m.index.chunkMinSize ??= 0; // manifests written before small-section merging existed
    m.index.contextEmbeddingEnabled ??= false;
  }
  const changed = (Object.keys(sig) as (keyof IndexSignature)[]).filter((k) =>
    k === "model" ? modelFamily(m.index?.model) !== modelFamily(sig.model) : m.index?.[k] !== sig[k]
  );
  if (changed.length === 0) {
    if (m.index.model !== sig.model) {
      console.log(`(model ${m.index.model} → ${sig.model}: same Voyage 4 embedding space, existing vectors stay valid)`);
    }
    return m;
  }
  if (DRY_RUN) {
    console.log(`(settings changed since last ingest: ${changed.join(", ")}; estimating as a fresh run)`);
    return fresh;
  }
  if (!FORCE) {
    fail(
      `Settings differ from the last ingest (${changed.join(", ")}).\n` +
        `   Vectors from different models/dimensions/chunking can't be mixed in one index.\n` +
        `   Re-run with --force to re-embed everything (use a new Pinecone index if the dimension changed).`
    );
  }
  return fresh;
}

/**
 * Models whose vectors can be mixed in one index. The Voyage 4 series (large, base, lite, nano)
 * shares one embedding space, so switching between them needs no re-embedding.
 */
function modelFamily(model: string | undefined): string | undefined {
  return model && /^voyage-4(-large|-lite|-nano)?$/.test(model) ? "voyage-4-series" : model;
}

/**
 * Before per-corpus manifests there was a single .ingest-manifest.json. If it belongs to
 * this corpus (same Pinecone host + namespace), rename it so its progress is kept.
 */
function adoptLegacyManifest(sig: IndexSignature) {
  if (fs.existsSync(MANIFEST_PATH) || !fs.existsSync(LEGACY_MANIFEST_PATH)) return;
  const legacy = JSON.parse(fs.readFileSync(LEGACY_MANIFEST_PATH, "utf-8")) as Manifest;
  if (legacy.index?.host === sig.host && legacy.index?.namespace === sig.namespace) {
    fs.renameSync(LEGACY_MANIFEST_PATH, MANIFEST_PATH);
    console.log(`(moved .ingest-manifest.json → ${path.basename(MANIFEST_PATH)})`);
  }
}

function saveManifest(m: Manifest) {
  const tmp = MANIFEST_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(m, null, 1));
  fs.renameSync(tmp, MANIFEST_PATH);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function readDoc(file: string): string {
  return fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, "");
}

function fail(msg: string): never {
  console.error(`❌ ${msg}`);
  process.exit(1);
  throw new Error(msg); // unreachable; keeps the `never` type honest
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) fail(`${name} is not set (see .env.example).`);
  return v;
}

const fmtBytes = (n: number) => (n > 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const fmtNum = (n: number) => n.toLocaleString("en-US");
const fmtDuration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
};

function chunkIds(prefix: string, from: number, to: number): string[] {
  const ids: string[] = [];
  for (let i = from; i < to; i++) ids.push(`${prefix}:${i}`);
  return ids;
}

async function idPrefix(source: string) {
  return (await sha256Hex(source)).slice(0, 32);
}

/** Splits records into upsert requests under Pinecone's size/count limits. */
function* upsertBatches(records: PineconeRecord[]): Generator<PineconeRecord[]> {
  let batch: PineconeRecord[] = [];
  let bytes = 0;
  for (const r of records) {
    const size = JSON.stringify(r).length;
    if (batch.length && (bytes + size > MAX_UPSERT_BYTES || batch.length >= MAX_UPSERT_RECORDS)) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(r);
    bytes += size;
  }
  if (batch.length) yield batch;
}

function contentType(file: string) {
  const ext = path.extname(file).toLowerCase();
  return ext === ".txt" ? "text/plain; charset=utf-8" : "text/markdown; charset=utf-8";
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(DOCS_DIR) || !fs.statSync(DOCS_DIR).isDirectory()) fail(`Directory not found: ${DOCS_DIR}`);

  const { provider, model, dimensions, contextEmbeddingEnabled } = resolveEmbeddingSettings(process.env);
  const embedder = DRY_RUN ? null : createEmbedder(process.env);
  const namespace = process.env.PINECONE_NAMESPACE || "docs";
  const host = DRY_RUN ? process.env.PINECONE_INDEX_HOST ?? "" : requireEnv("PINECONE_INDEX_HOST");

  const sig: IndexSignature = {
    host,
    namespace,
    provider,
    model,
    dimensions,
    contextEmbeddingEnabled,
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
    chunkMinSize: CHUNK_MIN_SIZE,
  };
  const manifest = loadManifest(sig);
  const rootEntries: Record<string, FileEntry> = (manifest.roots[DOCS_DIR] ??= {});

  console.log("══════════════════════════════════════════════════");
  console.log(` Ingestion · corpus "${CORPUS.corpus}"`);
  console.log(`  docs:       ${DOCS_DIR}`);
  console.log(`  embeddings: ${provider} / ${model} @ ${dimensions}d`);
  console.log(`  contextual: ${contextEmbeddingEnabled ? "enabled" : "disabled"}`);
  console.log(`  pinecone:   ${host || "(not set)"}  namespace=${namespace}`);
  console.log(
    `  chunking:   ${CHUNK_SIZE} chars, ${CHUNK_OVERLAP} overlap` +
      (CHUNK_MIN_SIZE ? `, merge sections under ${CHUNK_MIN_SIZE}` : "")
  );
  console.log(`  mode:       ${DRY_RUN ? "DRY RUN (no API calls)" : "live"}${UPLOAD_R2 ? " + R2 upload" : ""}${FORCE ? " + force" : ""}`);
  console.log("══════════════════════════════════════════════════\n");

  const sources = listDocuments(DOCS_DIR);
  console.log(`Found ${fmtNum(sources.size)} documents.`);

  if (DRY_RUN) return dryRun(sources, rootEntries, dimensions);

  // ── Live run ──
  const pinecone = new PineconeClient(host, requireEnv("PINECONE_API_KEY"), namespace);
  const stats = await pinecone.describeStats();
  if (stats.dimension && stats.dimension !== dimensions) {
    fail(`Pinecone index dimension is ${stats.dimension}, but EMBED_DIMENSIONS is ${dimensions}.`);
  }

  const s3 = UPLOAD_R2
    ? new S3Client({
        region: "auto",
        endpoint: `https://${requireEnv("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: requireEnv("R2_ACCESS_KEY_ID"), secretAccessKey: requireEnv("R2_SECRET_ACCESS_KEY") },
      })
    : null;
  const r2Bucket = UPLOAD_R2 ? process.env.R2_BUCKET || CORPUS.r2_bucket || requireEnv("R2_BUCKET") : "";

  // Prune documents that disappeared from this folder since the last run.
  if (PRUNE) {
    const gone = Object.keys(rootEntries).filter((s) => !sources.has(s));
    if (gone.length) {
      console.log(`Removing ${gone.length} deleted document(s) from Pinecone...`);
      for (const source of gone) {
        await pinecone.deleteIds(chunkIds(await idPrefix(source), 0, rootEntries[source].chunks));
        delete rootEntries[source];
      }
      saveManifest(manifest);
    }
  }

  // Work out what needs embedding.
  const todo: { source: string; file: string; content: string; sha: string }[] = [];
  let skipped = 0;
  let r2Uploaded = 0;
  for (const [source, file] of sources) {
    const content = readDoc(file);
    const sha = await sha256Hex(content);
    const entry = rootEntries[source];
    if (entry && entry.sha === sha && !FORCE) {
      skipped++;
      if (s3 && !entry.r2) {
        await uploadToR2(s3, r2Bucket, source, file, content);
        entry.r2 = true;
        r2Uploaded++;
      }
      continue;
    }
    todo.push({ source, file, content, sha });
  }
  if (r2Uploaded) saveManifest(manifest);
  console.log(`${fmtNum(skipped)} unchanged (skipped), ${fmtNum(todo.length)} to embed.\n`);
  if (todo.length === 0) return summary(embedder!, 0, 0, Date.now());

  const totalBytes = todo.reduce((n, t) => n + t.content.length, 0);
  const startedAt = Date.now();
  let doneBytes = 0;
  let doneFiles = 0;
  let totalChunks = 0;
  let pending: { source: string; file: string; content: string; sha: string; chunks: DocumentChunk[] }[] = [];
  let pendingChunks = 0;

  const flush = async () => {
    if (!pending.length) return;
    const chunks = pending.flatMap((p) => p.chunks);
    const vectors = chunks.length
      ? await embedDocumentGroups(embedder!, pending.map((p) => p.chunks.map((c) => c.embedText)))
      : [];
    const records: PineconeRecord[] = chunks.map((c, i) => ({ id: c.id, values: vectors[i], metadata: c.metadata }));
    for (const batch of upsertBatches(records)) await pinecone.upsert(batch);

    for (const p of pending) {
      const old = rootEntries[p.source];
      if (old && old.chunks > p.chunks.length) {
        await pinecone.deleteIds(chunkIds(await idPrefix(p.source), p.chunks.length, old.chunks));
      }
      let r2 = old?.r2 && old.sha === p.sha;
      if (s3) {
        await uploadToR2(s3, r2Bucket, p.source, p.file, p.content);
        r2 = true;
      }
      rootEntries[p.source] = { sha: p.sha, chunks: p.chunks.length, ...(r2 ? { r2: true } : {}) };
      doneBytes += p.content.length;
      doneFiles++;
    }
    saveManifest(manifest);

    totalChunks += chunks.length;
    const elapsed = Date.now() - startedAt;
    const eta = doneBytes ? (elapsed / doneBytes) * (totalBytes - doneBytes) : 0;
    console.log(
      `  ✔ ${fmtNum(doneFiles)}/${fmtNum(todo.length)} files · ${fmtNum(totalChunks)} chunks · ` +
        `${fmtNum(embedder!.tokensUsed)} tokens · ${fmtDuration(elapsed)} elapsed · ETA ${fmtDuration(eta)}`
    );
    pending = [];
    pendingChunks = 0;
  };

  for (const t of todo) {
    const title = extractTitle(t.content, path.basename(t.file, path.extname(t.file)));
    const chunks = await chunkDocument(t.source, t.content, { title, ...CHUNK_OPTS });
    pending.push({ ...t, chunks });
    pendingChunks += chunks.length;
    if (pendingChunks >= FLUSH_CHUNKS) await flush();
  }
  await flush();

  summary(embedder!, doneFiles, totalChunks, startedAt);
}

async function uploadToR2(s3: S3Client, bucket: string, key: string, file: string, content: string) {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: content, ContentType: contentType(file) }));
}

async function dryRun(sources: Map<string, string>, rootEntries: Record<string, FileEntry>, dimensions: number) {
  let chunks = 0;
  let embedChars = 0;
  let metadataBytes = 0;
  let unchanged = 0;
  let largest = { source: "", chunks: 0 };

  for (const [source, file] of sources) {
    const content = readDoc(file);
    const entry = rootEntries[source];
    if (entry && entry.sha === (await sha256Hex(content)) && !FORCE) unchanged++;
    const title = extractTitle(content, path.basename(file, path.extname(file)));
    const docChunks = await chunkDocument(source, content, { title, ...CHUNK_OPTS });
    chunks += docChunks.length;
    for (const c of docChunks) {
      embedChars += c.embedText.length;
      metadataBytes += Buffer.byteLength(JSON.stringify(c.metadata));
    }
    if (docChunks.length > largest.chunks) largest = { source, chunks: docChunks.length };
  }

  // ~4 chars/token for English; transliterated or non-Latin text is denser (IAST measured ~2.2).
  const lowTokens = Math.ceil(embedChars / 4);
  const highTokens = Math.ceil(embedChars / 2.2);
  const storage = chunks * dimensions * 4 + metadataBytes + chunks * 100;
  console.log(`\nDry-run estimate:`);
  console.log(`  documents:        ${fmtNum(sources.size)} (${fmtNum(unchanged)} unchanged since last run)`);
  console.log(`  chunks:           ${fmtNum(chunks)}   (largest doc: ${largest.source}, ${largest.chunks} chunks)`);
  console.log(`  embedding tokens: ~${fmtNum(lowTokens)}–${fmtNum(highTokens)}   (English ↔ other scripts; Voyage free allowance: 200,000,000)`);
  console.log(`  Pinecone storage: ~${fmtBytes(storage)} of ${fmtBytes(PINECONE_FREE_BYTES)} free`);
  console.log(`  Pinecone writes:  ~${fmtNum(Math.ceil((chunks * dimensions * 4 + metadataBytes) / 1024))} WU (rough; 2M WU/month free)`);
  if (storage > PINECONE_FREE_BYTES * 0.9) {
    console.log(`\n⚠  This would exceed ~90% of Pinecone's free storage. Consider EMBED_DIMENSIONS=512, a larger CHUNK_SIZE, or CHUNK_MIN_SIZE.`);
  }
}

function summary(embedder: { tokensUsed: number }, files: number, chunks: number, startedAt: number) {
  console.log("\n══════════════════════════════════════════════════");
  console.log(` Done: ${fmtNum(files)} files, ${fmtNum(chunks)} chunks embedded in ${fmtDuration(Date.now() - startedAt)}`);
  console.log(` Embedding tokens used this run: ${fmtNum(embedder.tokensUsed)}`);
  console.log("══════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("\n❌ Ingestion failed:", err instanceof Error ? err.message : err);
  console.error("   Progress up to the last completed batch is saved; re-run to resume.");
  process.exit(1);
});
