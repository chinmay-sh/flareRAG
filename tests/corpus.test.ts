import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readCorpus } from "../scripts/lib/corpus";
import { createEmbedder } from "../src/services/embeddings";
import { VoyageContextualizedEmbedder, VoyageEmbedder } from "../src/services/voyage";

console.log("Running corpus config tests...");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flarerag-corpus-test-"));
const file = path.join(dir, "test.jsonc");
const base = {
  worker: "test-worker",
  vars: { PINECONE_INDEX_HOST: "test.svc.pinecone.io", PINECONE_NAMESPACE: "test" },
};
function writeConfig(extra: Record<string, unknown> = {}) {
  fs.writeFileSync(file, JSON.stringify({ ...base, ...extra }));
}

try {
  writeConfig();
  const omitted = readCorpus(file);
  assert.equal(omitted.context_embedding_enabled, false);
  assert.equal(omitted.mergedVars.CONTEXT_EMBEDDING_ENABLED, "false");
  assert.ok(createEmbedder({ ...omitted.mergedVars, VOYAGE_API_KEY: "test-key" }) instanceof VoyageEmbedder);

  writeConfig({ context_embedding_enabled: false });
  assert.equal(readCorpus(file).mergedVars.CONTEXT_EMBEDDING_ENABLED, "false");
  writeConfig({ context_embedding_enabled: true });
  const enabled = readCorpus(file);
  assert.equal(enabled.mergedVars.CONTEXT_EMBEDDING_ENABLED, "true");
  assert.ok(createEmbedder({ ...enabled.mergedVars, VOYAGE_API_KEY: "test-key" }) instanceof VoyageContextualizedEmbedder);

  writeConfig({ context_embedding_enabled: true, vars: { ...base.vars, EMBED_MODEL: "voyage-context-3" } });
  assert.equal(readCorpus(file).mergedVars.EMBED_MODEL, "voyage-context-3");

  for (const value of ["true", 1, null]) {
    writeConfig({ context_embedding_enabled: value });
    assert.throws(() => readCorpus(file), /must be a boolean/);
  }
  writeConfig({ context_embedding_enabled: true, vars: { ...base.vars, EMBED_PROVIDER: "gemini" } });
  assert.throws(() => readCorpus(file), /only supported.*voyage/);
  writeConfig({ context_embedding_enabled: true, vars: { ...base.vars, EMBED_MODEL: "voyage-4-large" } });
  assert.throws(() => readCorpus(file), /require EMBED_MODEL/);

  // The top-level boolean is authoritative for BOTH the generated Worker vars and scripts.
  writeConfig({ vars: { ...base.vars, CONTEXT_EMBEDDING_ENABLED: "true" } });
  assert.equal(readCorpus(file).mergedVars.CONTEXT_EMBEDDING_ENABLED, "false");
} finally {
  // Remove only the known files and empty directory created by this test.
  fs.rmSync(file, { force: true });
  fs.rmdirSync(dir);
}
console.log("✅ All corpus config tests passed!");
