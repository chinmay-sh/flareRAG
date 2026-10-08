import { GeminiEmbedder, DEFAULT_GEMINI_EMBED_MODEL } from "./gemini";
import { VoyageEmbedder, VoyageContextualizedEmbedder, VoyageReranker, DEFAULT_VOYAGE_EMBED_MODEL, DEFAULT_VOYAGE_CONTEXT_MODEL, DEFAULT_RERANK_MODEL } from "./voyage";

export interface Embedder {
  readonly provider: string;
  readonly model: string;
  readonly dimensions: number;
  tokensUsed: number;
  embedQuery(query: string): Promise<number[]>;
  embedDocuments(texts: string[]): Promise<number[][]>;
  /** Contextual embedders preserve each document's ordered chunks as a separate group. */
  embedDocumentGroups?(documents: string[][]): Promise<number[][]>;
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
  CONTEXT_EMBEDDING_ENABLED?: string; // "false" (default) | "true"; Voyage only
  RERANK_MODEL?: string; // default "rerank-2.5"; "none" disables reranking
  VOYAGE_API_KEY?: string;
  GEMINI_API_KEY?: string;
}

/** Resolve and validate settings without requiring API keys (also used by dry-run ingestion). */
export function resolveEmbeddingSettings(cfg: EmbeddingConfig) {
  const provider = (cfg.EMBED_PROVIDER || "voyage").toLowerCase();
  const dimensions = parseInt(cfg.EMBED_DIMENSIONS || "1024", 10);
  const flag = cfg.CONTEXT_EMBEDDING_ENABLED ?? "false";
  if (flag !== "true" && flag !== "false") {
    throw new Error("CONTEXT_EMBEDDING_ENABLED must be true or false.");
  }
  const contextEmbeddingEnabled = flag === "true";
  if (contextEmbeddingEnabled && provider !== "voyage") {
    throw new Error("Context embeddings are only supported for EMBED_PROVIDER=voyage for now.");
  }
  if (provider !== "voyage" && provider !== "gemini") {
    throw new Error(`Unknown EMBED_PROVIDER "${cfg.EMBED_PROVIDER}" (expected "voyage" or "gemini").`);
  }
  const model = cfg.EMBED_MODEL || (contextEmbeddingEnabled ? DEFAULT_VOYAGE_CONTEXT_MODEL :
    provider === "gemini" ? DEFAULT_GEMINI_EMBED_MODEL : DEFAULT_VOYAGE_EMBED_MODEL);
  if (contextEmbeddingEnabled && !/^voyage-context-(3|4)$/.test(model)) {
    throw new Error(`Context embeddings require EMBED_MODEL=voyage-context-4 or voyage-context-3 (got "${model}").`);
  }
  if (!contextEmbeddingEnabled && /^voyage-context-/.test(model)) {
    throw new Error("Voyage contextual models require context_embedding_enabled=true in the corpus file.");
  }
  if (contextEmbeddingEnabled && ![256, 512, 1024, 2048].includes(Number(cfg.EMBED_DIMENSIONS || "1024"))) {
    throw new Error("Voyage context embeddings support EMBED_DIMENSIONS=256, 512, 1024 or 2048.");
  }
  return { provider, model, dimensions, contextEmbeddingEnabled };
}

export function createEmbedder(cfg: EmbeddingConfig): Embedder {
  const { provider, model, dimensions, contextEmbeddingEnabled } = resolveEmbeddingSettings(cfg);
  if (provider === "voyage") {
    return contextEmbeddingEnabled
      ? new VoyageContextualizedEmbedder(cfg.VOYAGE_API_KEY ?? "", model, dimensions)
      : new VoyageEmbedder(cfg.VOYAGE_API_KEY ?? "", model, dimensions);
  }
  return new GeminiEmbedder(cfg.GEMINI_API_KEY ?? "", model, dimensions);
}

/** Returns vectors in document order, then chunk order, for pairing with Pinecone records. */
export function embedDocumentGroups(embedder: Embedder, documents: string[][]): Promise<number[][]> {
  return embedder.embedDocumentGroups
    ? embedder.embedDocumentGroups(documents)
    : embedder.embedDocuments(documents.flat());
}

/** Returns null when reranking is disabled (RERANK_MODEL=none). */
export function createReranker(cfg: EmbeddingConfig): VoyageReranker | null {
  const model = cfg.RERANK_MODEL || DEFAULT_RERANK_MODEL;
  if (model.toLowerCase() === "none") return null;
  return new VoyageReranker(cfg.VOYAGE_API_KEY ?? "", model);
}
