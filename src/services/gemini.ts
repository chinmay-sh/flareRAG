import type { Embedder } from "./embeddings";
import { postJsonWithRetry } from "./http";

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const MAX_BATCH_SIZE = 100; // batchEmbedContents limit

export const DEFAULT_GEMINI_EMBED_MODEL = "gemini-embedding-001";

interface BatchEmbedResponse {
  embeddings: { values: number[] }[];
}

/**
 * Google Gemini embeddings via `batchEmbedContents`.
 * Uses taskType RETRIEVAL_QUERY / RETRIEVAL_DOCUMENT and `outputDimensionality`.
 * Vectors are L2-normalized here because Gemini only normalizes its full-size output.
 */
export class GeminiEmbedder implements Embedder {
  readonly provider = "gemini";
  /** Gemini doesn't report token usage; this is a chars/4 estimate. */
  tokensUsed = 0;

  constructor(
    private apiKey: string,
    readonly model: string = DEFAULT_GEMINI_EMBED_MODEL,
    readonly dimensions: number = 1024
  ) {
    if (!apiKey) throw new Error("GEMINI_API_KEY is required for EMBED_PROVIDER=gemini.");
  }

  async embedQuery(query: string): Promise<number[]> {
    const [embedding] = await this.embedBatch([query], "RETRIEVAL_QUERY");
    return embedding;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      out.push(...(await this.embedBatch(texts.slice(i, i + MAX_BATCH_SIZE), "RETRIEVAL_DOCUMENT")));
    }
    return out;
  }

  private async embedBatch(
    texts: string[],
    taskType: "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT"
  ): Promise<number[][]> {
    const modelPath = `models/${this.model}`;
    const res = await postJsonWithRetry<BatchEmbedResponse>(
      `${GEMINI_BASE_URL}/${modelPath}:batchEmbedContents`,
      { "x-goog-api-key": this.apiKey },
      {
        requests: texts.map((text) => ({
          model: modelPath,
          content: { parts: [{ text }] },
          taskType,
          outputDimensionality: this.dimensions,
        })),
      },
      "Gemini"
    );
    this.tokensUsed += Math.ceil(texts.reduce((n, t) => n + t.length, 0) / 4);
    return res.embeddings.map((e) => normalize(e.values));
  }
}

function normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  return norm === 0 ? v : v.map((x) => x / norm);
}
