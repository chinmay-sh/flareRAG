import { GeminiEmbedder, DEFAULT_GEMINI_EMBED_MODEL } from "./gemini";
import { VoyageEmbedder, VoyageReranker, DEFAULT_VOYAGE_EMBED_MODEL, DEFAULT_RERANK_MODEL } from "./voyage";

export interface Embedder {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  tokensUsed: number;
  embedQuery(query: string): Promise<number[]>;
  embedDocuments(texts: string[]): Promise<number[][]>;
}

/**
 * Embedding/rerank settings. Shared by the Worker (from `env`) and the ingest
 * script (from `process.env`) so both sides always use the same model.
 * Changing provider, model or dimensions requires re-indexing.
 */
export interface EmbeddingConfig {
  EMBED_PROVIDER?: string; // "voyage" (default) | "gemini"
  EMBED_MODEL?: string;
  EMBED_DIMENSIONS?: string; // default "1024"; must match the Pinecone index dimension
  RERANK_MODEL?: string; // default "rerank-2.5"; "none" disables reranking
  VOYAGE_API_KEY?: string;
  GEMINI_API_KEY?: string;
}

export function createEmbedder(cfg: EmbeddingConfig): Embedder {
  const provider = (cfg.EMBED_PROVIDER || "voyage").toLowerCase();
  const dims = parseInt(cfg.EMBED_DIMENSIONS || "1024", 10);
  if (provider === "voyage") {
    return new VoyageEmbedder(cfg.VOYAGE_API_KEY ?? "", cfg.EMBED_MODEL || DEFAULT_VOYAGE_EMBED_MODEL, dims);
  }
  if (provider === "gemini") {
    return new GeminiEmbedder(cfg.GEMINI_API_KEY ?? "", cfg.EMBED_MODEL || DEFAULT_GEMINI_EMBED_MODEL, dims);
  }
  throw new Error(`Unknown EMBED_PROVIDER "${cfg.EMBED_PROVIDER}" (expected "voyage" or "gemini").`);
}

/** Returns null when reranking is disabled (RERANK_MODEL=none). */
export function createReranker(cfg: EmbeddingConfig): VoyageReranker | null {
  const model = cfg.RERANK_MODEL || DEFAULT_RERANK_MODEL;
  if (model.toLowerCase() === "none") return null;
  return new VoyageReranker(cfg.VOYAGE_API_KEY ?? "", model);
}
