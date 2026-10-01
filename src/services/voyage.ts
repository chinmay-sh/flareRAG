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
export const DEFAULT_RERANK_MODEL = "rerank-2.5";

interface EmbeddingResponse {
  data: { embedding: number[]; index: number }[];
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
