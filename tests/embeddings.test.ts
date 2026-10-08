import assert from "node:assert/strict";
import { createEmbedder, embedDocumentGroups, resolveEmbeddingSettings } from "../src/services/embeddings";
import { VoyageContextualizedEmbedder, VoyageEmbedder } from "../src/services/voyage";

interface RequestBody {
  inputs?: string[][];
  input?: string[];
  model: string;
  input_type: string;
  output_dimension: number;
  output_dtype?: string;
  truncation?: boolean;
}

const requests: { url: string; body: RequestBody }[] = [];
const originalFetch = globalThis.fetch;
let respond: (body: RequestBody) => Response;
const vector = (text: string, dimensions: number) => Array.from({ length: dimensions }, (_, i) => i ? text.length : text.charCodeAt(0));

function contextualResponse(body: RequestBody): Response {
  return Response.json({
    // Return groups AND their chunks out of order to exercise both response indices.
    data: body.inputs!.map((texts, index) => ({
      index,
      data: texts.map((text, index) => ({ index, embedding: vector(text, body.output_dimension) })).reverse(),
    })).reverse(),
    usage: { total_tokens: 7 },
  });
}

console.log("Running embedding tests...");

try {
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init!.body as string) as RequestBody;
    requests.push({ url: String(url), body });
    assert.equal(new Headers(init!.headers).get("Authorization"), "Bearer test-key");
    return respond(body);
  };

  assert.deepEqual(resolveEmbeddingSettings({}), {
    provider: "voyage", model: "voyage-4", dimensions: 1024, contextEmbeddingEnabled: false,
  });
  assert.equal(resolveEmbeddingSettings({ EMBED_PROVIDER: "gemini" }).model, "gemini-embedding-001");
  assert.throws(() => resolveEmbeddingSettings({ CONTEXT_EMBEDDING_ENABLED: "yes" }), /true or false/);
  assert.throws(() => createEmbedder({ EMBED_PROVIDER: "gemini", CONTEXT_EMBEDDING_ENABLED: "true" }), /only supported.*voyage/);
  assert.throws(() => createEmbedder({ EMBED_MODEL: "voyage-4", CONTEXT_EMBEDDING_ENABLED: "true" }), /require EMBED_MODEL/);
  assert.throws(() => createEmbedder({ EMBED_MODEL: "voyage-context-3" }), /context_embedding_enabled=true/);
  assert.throws(() => createEmbedder({ CONTEXT_EMBEDDING_ENABLED: "true", EMBED_DIMENSIONS: "768" }), /support EMBED_DIMENSIONS/);
  assert.throws(() => createEmbedder({ CONTEXT_EMBEDDING_ENABLED: "true" }), /VOYAGE_API_KEY/);
  for (const model of ["voyage-context-3", "voyage-context-4"]) {
    const embedder = createEmbedder({ CONTEXT_EMBEDDING_ENABLED: "true", EMBED_MODEL: model, VOYAGE_API_KEY: "test-key" });
    assert.ok(embedder instanceof VoyageContextualizedEmbedder);
    assert.equal(embedder.model, model);
  }
  const defaultContext = createEmbedder({ CONTEXT_EMBEDDING_ENABLED: "true", VOYAGE_API_KEY: "test-key" });
  assert.equal(defaultContext.model, "voyage-context-4");

  // Default and explicitly disabled corpora retain the standard /embeddings behavior.
  respond = (body) => Response.json({
    data: body.input!.map((text, index) => ({ index, embedding: vector(text, body.output_dimension) })).reverse(),
    usage: { total_tokens: 5 },
  });
  const standard = createEmbedder({ VOYAGE_API_KEY: "test-key", CONTEXT_EMBEDDING_ENABLED: "false", EMBED_DIMENSIONS: "256" });
  assert.ok(standard instanceof VoyageEmbedder);
  assert.deepEqual(await embedDocumentGroups(standard, [["alpha", "beta"], ["gamma"]]),
    ["alpha", "beta", "gamma"].map((text) => vector(text, 256)));
  assert.deepEqual(requests.at(-1)!.body.input, ["alpha", "beta", "gamma"]);
  await standard.embedQuery("query");
  assert.equal(requests.at(-1)!.url, "https://api.voyageai.com/v1/embeddings");
  assert.equal(requests.at(-1)!.body.input_type, "query");

  respond = contextualResponse;
  requests.length = 0;
  const contextual = new VoyageContextualizedEmbedder("test-key", "voyage-context-4", 2);
  assert.deepEqual(await embedDocumentGroups(contextual, [["alpha", "beta"], [], ["gamma"]]),
    ["alpha", "beta", "gamma"].map((text) => vector(text, 2)));
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body, {
    inputs: [["alpha", "beta"], ["gamma"]], model: "voyage-context-4",
    input_type: "document", output_dimension: 2, output_dtype: "float",
  });
  assert.equal(requests[0].url, "https://api.voyageai.com/v1/contextualizedembeddings");
  assert.equal(contextual.tokensUsed, 7);
  assert.deepEqual(await contextual.embedQuery("query"), vector("query", 2));
  assert.deepEqual(requests.at(-1)!.body.inputs, [["query"]]);
  assert.equal(requests.at(-1)!.body.input_type, "query");
  assert.equal(contextual.tokensUsed, 14);
  const count = requests.length;
  assert.deepEqual(await contextual.embedDocumentGroups([[], []]), []);
  assert.equal(requests.length, count);

  // Split long documents into consecutive windows without mixing document contexts.
  requests.length = 0;
  const texts = ["a", "b", "c"].map((c) => c.repeat(20_000));
  assert.deepEqual(await contextual.embedDocumentGroups([texts, ["other document"]]),
    [...texts, "other document"].map((text) => vector(text, 2)));
  assert.deepEqual(requests.map((r) => r.body.inputs), [[texts.slice(0, 2)], [[texts[2]], ["other document"]]]);
  requests.length = 0;
  const context3 = new VoyageContextualizedEmbedder("test-key", "voyage-context-3", 2);
  await context3.embedDocumentGroups([texts]);
  assert.deepEqual(requests.map((r) => r.body.inputs), [[texts]]);

  requests.length = 0;
  const manyDocs = Array.from({ length: 1001 }, () => ["x"]);
  assert.equal((await contextual.embedDocumentGroups(manyDocs)).length, 1001);
  assert.deepEqual(requests.map((r) => r.body.inputs!.length), [1000, 1]);
  requests.length = 0;
  assert.equal((await contextual.embedDocuments(Array(16_001).fill("x"))).length, 16_001);
  assert.deepEqual(requests.map((r) => r.body.inputs![0].length), [16_000, 1]);
  requests.length = 0;
  await assert.rejects(contextual.embedDocuments(["x".repeat(100_000)]), /Reduce CHUNK_SIZE/);
  assert.equal(requests.length, 0);

  // API token estimates can differ: split rejected batches, preserving vector order.
  respond = (body) => body.inputs!.flat().length > 1
    ? new Response("TOO_MANY_TOKENS_IN_BATCH", { status: 400 })
    : contextualResponse(body);
  assert.deepEqual(await contextual.embedDocumentGroups([["alpha", "beta"], ["gamma"]]),
    ["alpha", "beta", "gamma"].map((text) => vector(text, 2)));
  respond = () => new Response("invalid API key", { status: 401 });
  requests.length = 0;
  await assert.rejects(contextual.embedDocuments(["alpha", "beta"]), /HTTP 401/);
  assert.equal(requests.length, 1);

  // Partial or malformed responses must fail before vectors reach Pinecone.
  for (const data of [
    [],
    [{ index: 0, data: [] }],
    [{ index: 0, data: [{ index: 0, embedding: [1] }] }],
    [{ index: 1, data: [{ index: 0, embedding: [1, 2] }] }],
    [{ index: 0, data: [{ index: 0, embedding: ["bad", 2] }] }],
  ]) {
    respond = () => Response.json({ data });
    await assert.rejects(contextual.embedDocuments(["alpha"]), /invalid or missing vectors/);
  }
  respond = () => Response.json({ data: [{ index: 0, data: [
    { index: 0, embedding: [1, 2] }, { index: 0, embedding: [3, 4] },
  ] }] });
  await assert.rejects(contextual.embedDocuments(["alpha", "beta"]), /invalid or missing vectors/);
} finally {
  globalThis.fetch = originalFetch;
}

console.log("✅ All embedding tests passed!");
