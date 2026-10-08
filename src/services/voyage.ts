import type { Embedder } from "./embeddings";
import { postJsonWithRetry } from "./http";

const VOYAGE_BASE_URL = "https://api.voyageai.com/v1";
const MAX_BATCH_SIZE = 128;

// Max total tokens per /embeddings request (Voyage docs). Unknown models get the smallest limit.
const BATCH_TOKEN_LIMITS: [RegExp, number][] = [
  [/-lite$/, 1_000_000],
  [/^voyage-(4|3\.5)$/, 320_000],
];
const DEFAULT_BATCH_TOKEN_LIMIT = 120_000; // voyage-4-large, voyage-3-large, voyage-code-*, …

// Conservative token estimate. English is ~4 chars/token, but transliterated or non-Latin
// text is much denser (IAST measured ~2.1), so assume 1.8 and keep 15% headroom.
const CHARS_PER_TOKEN = 1.8;
const BUDGET_FRACTION = 0.85;

function batchTokenLimit(model: string): number {
  return BATCH_TOKEN_LIMITS.find(([re]) => re.test(model))?.[1] ?? DEFAULT_BATCH_TOKEN_LIMIT;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export const DEFAULT_VOYAGE_EMBED_MODEL = "voyage-4";
export const DEFAULT_VOYAGE_CONTEXT_MODEL = "voyage-context-4";
export const DEFAULT_RERANK_MODEL = "rerank-2.5";

interface EmbeddingResponse {
  data: { embedding: number[]; index: number }[];
  usage: { total_tokens: number };
}

interface ContextualizedEmbeddingResponse {
  data: { index: number; data: { embedding: number[]; index: number }[] }[];
  usage: { total_tokens: number };
}

interface RerankResponse {
  data: { index: number; relevance_score: number }[];
  usage: { total_tokens: number };
}

export interface RerankHit {
  index: number;
  score: number;
}

function voyageHeaders(apiKey: string) {
  return { Authorization: `Bearer ${apiKey}` };
}

/** Voyage AI embeddings (`input_type` query/document, Matryoshka `output_dimension`). */
export class VoyageEmbedder implements Embedder {
  readonly provider = "voyage";
  tokensUsed = 0;

  constructor(
    private apiKey: string,
    readonly model: string = DEFAULT_VOYAGE_EMBED_MODEL,
    readonly dimensions: number = 1024
  ) {
    if (!apiKey) throw new Error("VOYAGE_API_KEY is required for EMBED_PROVIDER=voyage.");
  }

  async embedQuery(query: string): Promise<number[]> {
    const [embedding] = await this.embedBatch([query], "query");
    return embedding;
  }

  /**
   * Embeds documents in batches that respect both the 128-input limit and the model's
   * per-request token limit. If Voyage still rejects a batch as too large (the estimate
   * is only an estimate), the batch is split in half and retried.
   */
  async embedDocuments(texts: string[]): Promise<number[][]> {
    const budget = batchTokenLimit(this.model) * BUDGET_FRACTION;
    const out: number[][] = [];
    let batch: string[] = [];
    let batchTokens = 0;

    for (const text of texts) {
      const tokens = estimateTokens(text);
      if (batch.length && (batch.length >= MAX_BATCH_SIZE || batchTokens + tokens > budget)) {
        out.push(...(await this.embedDocumentBatch(batch)));
        batch = [];
        batchTokens = 0;
      }
      batch.push(text);
      batchTokens += tokens;
    }
    if (batch.length) out.push(...(await this.embedDocumentBatch(batch)));
    return out;
  }

  private async embedDocumentBatch(texts: string[]): Promise<number[][]> {
    try {
      return await this.embedBatch(texts, "document");
    } catch (err) {
      const tooBig = err instanceof Error && /TOO_MANY_TOKENS_IN_BATCH|max allowed tokens per submitted batch/i.test(err.message);
      if (!tooBig || texts.length === 1) throw err;
      const mid = Math.ceil(texts.length / 2);
      return [...(await this.embedDocumentBatch(texts.slice(0, mid))), ...(await this.embedDocumentBatch(texts.slice(mid)))];
    }
  }

  private async embedBatch(texts: string[], inputType: "query" | "document"): Promise<number[][]> {
    const res = await postJsonWithRetry<EmbeddingResponse>(
      `${VOYAGE_BASE_URL}/embeddings`,
      voyageHeaders(this.apiKey),
      {
        input: texts,
        model: this.model,
        input_type: inputType,
        output_dimension: this.dimensions,
        truncation: true,
      },
      "Voyage"
    );
    this.tokensUsed += res.usage?.total_tokens ?? 0;
    const out: number[][] = new Array(texts.length);
    for (const item of res.data) out[item.index] = item.embedding;
    return out;
  }
}

// Individual chunks are limited to 32K tokens. Context-4 caps pre-chunked requests
// at 32K; context-3 allows 120K across documents. Keep estimation headroom.
const CONTEXT_TOKEN_LIMIT = 32_000;
const CONTEXT_MAX_INPUTS = 1000;
const CONTEXT_MAX_CHUNKS = 16_000;

/** Voyage contextual embeddings: one ordered chunk group per source document. */
export class VoyageContextualizedEmbedder implements Embedder {
  readonly provider = "voyage";
  tokensUsed = 0;

  constructor(
    private apiKey: string,
    readonly model: string = DEFAULT_VOYAGE_CONTEXT_MODEL,
    readonly dimensions: number = 1024
  ) {
    if (!apiKey) throw new Error("VOYAGE_API_KEY is required for EMBED_PROVIDER=voyage.");
  }

  async embedQuery(query: string): Promise<number[]> {
    const [embedding] = await this.embedBatch([[query]], "query");
    return embedding;
  }

  /** A flat list here is the ordered chunks of one document. */
  embedDocuments(texts: string[]): Promise<number[][]> {
    return this.embedDocumentGroups([texts]);
  }

  async embedDocumentGroups(documents: string[][]): Promise<number[][]> {
    const requestBudget = this.requestTokenBudget;
    const out: number[][] = [];
    let batch: string[][] = [];
    let batchTokens = 0;
    let batchChunks = 0;

    // Long documents use consecutive context windows, never chunks from other documents.
    for (const { texts, tokens } of this.documentWindows(documents)) {
      if (batch.length && (batch.length >= CONTEXT_MAX_INPUTS ||
        batchChunks + texts.length > CONTEXT_MAX_CHUNKS || batchTokens + tokens > requestBudget)) {
        out.push(...await this.embedDocumentBatch(batch));
        batch = [];
        batchTokens = 0;
        batchChunks = 0;
      }
      batch.push(texts);
      batchTokens += tokens;
      batchChunks += texts.length;
    }
    if (batch.length) out.push(...await this.embedDocumentBatch(batch));
    return out;
  }

  private get requestTokenBudget(): number {
    return (this.model === "voyage-context-4" ? CONTEXT_TOKEN_LIMIT : 120_000) * BUDGET_FRACTION;
  }

  private *documentWindows(documents: string[][]): Generator<{ texts: string[]; tokens: number }> {
    const budget = this.requestTokenBudget;
    for (const document of documents) {
      let texts: string[] = [];
      let tokens = 0;
      for (const text of document) {
        const estimated = estimateTokens(text);
        if (estimated > CONTEXT_TOKEN_LIMIT * BUDGET_FRACTION) {
          throw new Error("A chunk exceeds the Voyage context token budget. Reduce CHUNK_SIZE and re-ingest.");
        }
        if (texts.length && (tokens + estimated > budget || texts.length >= CONTEXT_MAX_CHUNKS)) {
          yield { texts, tokens };
          texts = [];
          tokens = 0;
        }
        texts.push(text);
        tokens += estimated;
      }
      if (texts.length) yield { texts, tokens };
    }
  }

  private async embedDocumentBatch(documents: string[][]): Promise<number[][]> {
    try {
      return await this.embedBatch(documents, "document");
    } catch (err) {
      const tooBig = err instanceof Error &&
        /TOO_MANY_TOKENS|TOO_MANY_CHUNKS|max allowed tokens|exceed.*(?:token|chunk)|(?:token|chunk).*(?:limit|maximum|exceed)/i.test(err.message);
      if (!tooBig) throw err;
      if (documents.length > 1) {
        const mid = Math.ceil(documents.length / 2);
        return [...await this.embedDocumentBatch(documents.slice(0, mid)),
          ...await this.embedDocumentBatch(documents.slice(mid))];
      }
      const chunks = documents[0];
      if (chunks.length <= 1) throw err;
      const mid = Math.ceil(chunks.length / 2);
      return [...await this.embedDocumentBatch([chunks.slice(0, mid)]),
        ...await this.embedDocumentBatch([chunks.slice(mid)])];
    }
  }

  private async embedBatch(inputs: string[][], inputType: "query" | "document"): Promise<number[][]> {
    const res = await postJsonWithRetry<ContextualizedEmbeddingResponse>(
      `${VOYAGE_BASE_URL}/contextualizedembeddings`,
      voyageHeaders(this.apiKey),
      {
        inputs,
        model: this.model,
        input_type: inputType,
        output_dimension: this.dimensions,
        output_dtype: "float",
      },
      "Voyage contextual embeddings"
    );
    this.tokensUsed += res.usage?.total_tokens ?? 0;
    const groups: number[][][] = new Array(inputs.length);
    const invalidResponse = () => new Error("Voyage contextual embeddings returned invalid or missing vectors.");
    if (!Array.isArray(res.data) || res.data.length !== inputs.length) throw invalidResponse();
    for (const group of res.data) {
      if (!Number.isInteger(group.index) || group.index < 0 || group.index >= inputs.length || groups[group.index] ||
        !Array.isArray(group.data) || group.data.length !== inputs[group.index].length) throw invalidResponse();
      const vectors: number[][] = new Array(inputs[group.index].length);
      for (const item of group.data) {
        if (!Number.isInteger(item.index) || item.index < 0 || item.index >= vectors.length || vectors[item.index] ||
          !Array.isArray(item.embedding) || item.embedding.length !== this.dimensions ||
          !item.embedding.every((value) => typeof value === "number" && Number.isFinite(value))) throw invalidResponse();
        vectors[item.index] = item.embedding;
      }
      groups[group.index] = vectors;
    }
    return groups.flat();
  }
}

/** Voyage reranker (used regardless of which provider made the embeddings). */
export class VoyageReranker {
  tokensUsed = 0;

  constructor(private apiKey: string, readonly model: string = DEFAULT_RERANK_MODEL) {
    if (!apiKey) throw new Error("VOYAGE_API_KEY is required for reranking (set RERANK_MODEL=none to disable).");
  }

  async rerank(query: string, documents: string[], topK: number): Promise<RerankHit[]> {
    if (documents.length === 0) return [];
    const res = await postJsonWithRetry<RerankResponse>(
      `${VOYAGE_BASE_URL}/rerank`,
      voyageHeaders(this.apiKey),
      {
        query,
        documents,
        model: this.model,
        top_k: Math.min(topK, documents.length),
        truncation: true,
      },
      "Voyage"
    );
    this.tokensUsed += res.usage?.total_tokens ?? 0;
    return res.data.map((d) => ({ index: d.index, score: d.relevance_score }));
  }
}
