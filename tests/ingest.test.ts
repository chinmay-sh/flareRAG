import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { chunkDocument } from "../src/ingest/chunker";

console.log("Running ingest integration tests...");
const dir = fs.mkdtempSync(path.join(path.resolve("tests"), ".tmp-ingest-"));
const docs = path.join(dir, "docs");
const configPath = path.join(dir, "test.jsonc");
const manifestPath = path.join(dir, ".ingest-manifest.test.json");
const logPath = path.join(dir, "requests.jsonl");
const mockPath = path.join(dir, "mock.mjs");
const contents = ["# Alpha\n\n## First\n\nAlpha first passage.\n\n## Second\n\nAlpha second passage.",
  "# Beta\n\n## First\n\nBeta first passage.\n\n## Second\n\nBeta second passage."];
const vars = {
  PINECONE_INDEX_HOST: "test.svc.pinecone.io", PINECONE_NAMESPACE: "test",
  EMBED_PROVIDER: "voyage", EMBED_DIMENSIONS: "256",
  CHUNK_SIZE: "100", CHUNK_OVERLAP: "0", CHUNK_MIN_SIZE: "0",
};

function config(context?: boolean) {
  fs.writeFileSync(configPath, JSON.stringify({
    worker: "test-worker", docs_dir: docs,
    ...(context === undefined ? {} : { context_embedding_enabled: context }),
    vars: { ...vars, EMBED_MODEL: context ? "voyage-context-4" : "voyage-4" },
  }));
}
function ingest(...args: string[]) {
  const result = spawnSync(process.execPath, [
    "--import", pathToFileURL(mockPath).href, "--import", import.meta.resolve("tsx"),
    path.resolve("scripts/ingest.ts"), "--corpus", configPath, ...args,
  ], {
    cwd: dir, encoding: "utf-8", timeout: 15_000,
    env: { ...process.env, ...vars, EMBED_MODEL: "voyage-4", VOYAGE_API_KEY: "test-key", PINECONE_API_KEY: "test-key" },
  });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}
function requests(): { path: string; body: any }[] {
  return fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

try {
  fs.mkdirSync(docs);
  fs.writeFileSync(path.join(dir, "wrangler.jsonc"), JSON.stringify({ vars: {} }));
  for (const [i, text] of contents.entries()) fs.writeFileSync(path.join(docs, `${i}.md`), text);
  fs.writeFileSync(mockPath, `
    import * as fs from 'node:fs';
    const log = new URL('./requests.jsonl', import.meta.url);
    globalThis.fetch = async (url, init) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(init.body);
      fs.appendFileSync(log, JSON.stringify({ path, body }) + '\\n');
      if (path === '/describe_index_stats') return Response.json({ dimension: 256 });
      if (path === '/vectors/upsert') return Response.json({ upsertedCount: body.vectors.length });
      if (path === '/v1/contextualizedembeddings') return Response.json({
        data: body.inputs.map((texts, index) => ({ index,
          data: texts.map((text, index) => ({ index, embedding: Array(256).fill(text.length) })).reverse(),
        })).reverse(), usage: { total_tokens: 10 },
      });
      if (path === '/v1/embeddings') return Response.json({
        data: body.input.map((text, index) => ({ index, embedding: Array(256).fill(text.length) })),
        usage: { total_tokens: 10 },
      });
      return new Response('Unexpected mocked endpoint: ' + path, { status: 400 });
    };
  `);

  // Existing manifests have no contextual flag. They must still resume with the default.
  config();
  fs.writeFileSync(manifestPath, JSON.stringify({ version: 1, roots: {}, index: {
    host: vars.PINECONE_INDEX_HOST, namespace: "test", provider: "voyage", model: "voyage-4",
    dimensions: 256, chunkSize: 100, chunkOverlap: 0, chunkMinSize: 0,
  } }));
  const legacy = ingest("--dry-run");
  assert.equal(legacy.status, 0, legacy.output);
  assert.doesNotMatch(legacy.output, /settings changed/i);
  assert.match(legacy.output, /contextual:\s+disabled/);
  assert.equal(requests().length, 0, "dry-run must not call APIs");

  config(true);
  const changed = ingest();
  assert.equal(changed.status, 1);
  assert.match(changed.output, /Settings differ.*contextEmbeddingEnabled/);
  assert.match(changed.output, /--force/);
  assert.equal(requests().length, 0, "mode mismatch must fail before API calls");

  const run = ingest("--force");
  assert.equal(run.status, 0, run.output);
  const expected = await Promise.all(contents.map((text, i) => chunkDocument(`${i}.md`, text,
    { title: i ? "Beta" : "Alpha", maxChunkSize: 100, chunkOverlap: 0 })));
  const embeddingRequests = requests().filter((r) => r.path === "/v1/contextualizedembeddings");
  assert.equal(embeddingRequests.length, 1);
  assert.deepEqual(embeddingRequests[0].body.inputs, expected.map((chunks) => chunks.map((c) => c.embedText)));
  const vectors = requests().filter((r) => r.path === "/vectors/upsert").flatMap((r) => r.body.vectors);
  assert.deepEqual(vectors, expected.flat().map((c) => ({ id: c.id, metadata: c.metadata, values: Array(256).fill(c.embedText.length) })));
  assert.equal(JSON.parse(fs.readFileSync(manifestPath, "utf-8")).index.contextEmbeddingEnabled, true);

  fs.writeFileSync(logPath, "");
  const resumed = ingest();
  assert.equal(resumed.status, 0, resumed.output);
  assert.match(resumed.output, /2 unchanged \(skipped\), 0 to embed/);
  assert.ok(requests().every((r) => r.path === "/describe_index_stats"));

  config(false);
  assert.match(ingest().output, /Settings differ.*contextEmbeddingEnabled/);
  fs.writeFileSync(logPath, "");
  const standard = ingest("--force");
  assert.equal(standard.status, 0, standard.output);
  assert.deepEqual(requests().find((r) => r.path === "/v1/embeddings")!.body.input, expected.flat().map((c) => c.embedText));
} finally {
  // Remove the exact files and directories created by this fixture; no recursive deletion.
  for (let i = 0; i < contents.length; i++) fs.rmSync(path.join(docs, `${i}.md`), { force: true });
  fs.rmdirSync(docs);
  for (const name of ["test.jsonc", "wrangler.jsonc", ".ingest-manifest.test.json", ".ingest-manifest.test.json.tmp", "requests.jsonl", "mock.mjs"]) {
    fs.rmSync(path.join(dir, name), { force: true });
  }
  fs.rmdirSync(dir);
}
console.log("✅ All ingest integration tests passed!");
