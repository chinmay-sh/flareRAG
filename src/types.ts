import type { EmbeddingConfig } from "./services/embeddings";

/**
 * Environment bindings for the Cloudflare Worker (query side only).
 * Indexing happens locally via `scripts/ingest.ts`.
 */
export interface Env extends EmbeddingConfig {
  // Cloudflare R2 bucket with the raw source documents (optional, for full-document tools)
  DOCS_BUCKET?: R2Bucket;

  // Secrets (`wrangler secret put ...`): VOYAGE_API_KEY / GEMINI_API_KEY come from EmbeddingConfig
  PINECONE_API_KEY: string;
  MCP_TOKEN: string;

  // Vars (wrangler.jsonc): EMBED_PROVIDER / EMBED_MODEL / EMBED_DIMENSIONS / RERANK_MODEL from EmbeddingConfig
  PINECONE_INDEX_HOST: string;
  PINECONE_NAMESPACE?: string; // default: "docs"
  // Corpus description shown to MCP clients (all optional; see wrangler.jsonc)
  COLLECTION_NAME?: string; // short name, e.g. "My library"; used for the MCP server name and test page title
  COLLECTION_DESCRIPTION?: string; // completes "This server searches ..."
  SEARCH_TIPS?: string; // corpus-specific query advice appended to the search tool description
  EXAMPLE_QUERY?: string; // example question shown in the search tool's `query` parameter
}

/**
 * Metadata stored with each Pinecone record (40 KB limit per record).
 * The chunk text lives here so a search needs no second lookup.
 */
export interface ChunkMetadata {
  source: string; // relative path of the original file; also the R2 key
  title: string;
  section?: string; // heading path, e.g. "Architecture > Edge Routing"
  chunkIndex: number;
  totalChunks: number;
  text: string;
  [key: string]: string | number | boolean | string[] | undefined;
}

export interface SearchResultItem {
  rank: number;
  id: string;
  rerank_score: number | null;
  retrieval_score: number;
  source: string;
  title: string;
  section?: string;
  chunkIndex: number;
  totalChunks: number;
  text: string;
  also_in?: string[]; // other files containing (nearly) the same passage, up to 10
  also_in_count?: number;
}

export interface SearchResponse {
  query: string;
  retrieved_count: number; // raw candidates from Pinecone
  unique_count: number; // after de-duplication (what the reranker saw)
  results: SearchResultItem[];
  context_bundle: string;
  rerank_warning?: string;
  latency_ms: number;
}
