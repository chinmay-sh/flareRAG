import type { Env, SearchResponse, SearchResultItem } from "../types";
import { createEmbedder, createReranker } from "./embeddings";
import { dedupe } from "./dedupe";
import { PineconeClient, type PineconeMatch } from "./pinecone";

const MAX_ALSO_IN = 10;

export interface SearchOptions {
  retrievalK?: number; // candidates fetched from Pinecone (default 20, max 50)
  rerankK?: number; // results returned after reranking (default 5)
  source?: string; // restrict to one document (metadata.source)
  dedupe?: boolean; // collapse near-duplicate passages from different files (default true)
}

export function pineconeFromEnv(env: Env): PineconeClient {
  return new PineconeClient(env.PINECONE_INDEX_HOST, env.PINECONE_API_KEY, env.PINECONE_NAMESPACE || "docs");
}

/**
 * Two-stage retrieval: query embedding → Pinecone top-N → de-duplicate → Voyage rerank → top-K.
 * With de-duplication on, 2×N candidates are fetched so N distinct passages reach the reranker;
 * copies of the same text in other files are reported in `also_in`.
 * If reranking fails (or is disabled), falls back to the vector-search order.
 */
export async function searchDocuments(env: Env, query: string, options: SearchOptions = {}): Promise<SearchResponse> {
  const start = Date.now();
  const cleaned = query.trim();
  if (!cleaned) throw new Error("query must be non-empty");

  const retrievalK = clamp(options.retrievalK ?? 20, 1, 50);
  const rerankK = clamp(options.rerankK ?? 5, 1, retrievalK);

  const embedder = createEmbedder(env);
  const pinecone = pineconeFromEnv(env);

  const useDedupe = options.dedupe ?? true;

  const vector = await embedder.embedQuery(cleaned);
  const raw = await pinecone.query(
    vector,
    useDedupe ? retrievalK * 2 : retrievalK,
    options.source ? { source: { $eq: options.source } } : undefined
  );

  // Collapse near-duplicates (best vector score wins), then keep the top N distinct passages.
  const groups = (useDedupe ? dedupe(raw, (m) => m.metadata?.text ?? "") : raw.map((item) => ({ item, duplicates: [] })))
    .slice(0, retrievalK);
  const matches = groups.map((g) => g.item);
  const alsoIn = new Map(groups.map((g) => [g.item.id, g.duplicates]));

  let ranked: { match: PineconeMatch; rerankScore: number | null }[];
  let rerankWarning: string | undefined;

  const reranker = createReranker(env);
  if (reranker && matches.length > 1) {
    try {
      const hits = await reranker.rerank(cleaned, matches.map(rerankText), rerankK);
      ranked = hits.map((h) => ({ match: matches[h.index], rerankScore: h.score }));
    } catch (err) {
      rerankWarning = `Rerank failed, returned retrieval-only results: ${err instanceof Error ? err.message : String(err)}`;
      ranked = matches.slice(0, rerankK).map((match) => ({ match, rerankScore: null }));
    }
  } else {
    ranked = matches.slice(0, rerankK).map((match) => ({ match, rerankScore: null }));
  }

  const results: SearchResultItem[] = ranked.map(({ match, rerankScore }, i) => {
    const meta = match.metadata;
    const dups = alsoIn.get(match.id) ?? [];
    const otherSources = [...new Set(dups.map((d) => d.metadata?.source ?? "").filter((s) => s && s !== meta?.source))];
    return {
      rank: i + 1,
      id: match.id,
      rerank_score: rerankScore === null ? null : round(rerankScore),
      retrieval_score: round(match.score),
      source: meta?.source ?? "",
      title: meta?.title ?? "Untitled",
      section: meta?.section,
      chunkIndex: meta?.chunkIndex ?? 0,
      totalChunks: meta?.totalChunks ?? 1,
      text: meta?.text ?? "",
      ...(otherSources.length
        ? { also_in: otherSources.slice(0, MAX_ALSO_IN), also_in_count: otherSources.length }
        : {}),
    };
  });

  return {
    query: cleaned,
    retrieved_count: raw.length,
    unique_count: matches.length,
    results,
    context_bundle: results.map(formatForContext).join("\n\n---\n\n"),
    ...(rerankWarning ? { rerank_warning: rerankWarning } : {}),
    latency_ms: Date.now() - start,
  };
}

function rerankText(m: PineconeMatch): string {
  const meta = m.metadata;
  const context = [meta?.title, meta?.section].filter(Boolean).join(" > ");
  return context ? `${context}\n\n${meta?.text ?? ""}` : meta?.text ?? "";
}

export function formatForContext(r: SearchResultItem): string {
  const heading = [r.title, r.section].filter(Boolean).join(" > ");
  const copies = r.also_in_count
    ? `\nsame text also in ${r.also_in_count} other file(s): ${r.also_in!.join(", ")}${r.also_in_count > r.also_in!.length ? ", …" : ""}`
    : "";
  return `[${r.rank}] ${heading}\nsource: ${r.source} (chunk ${r.chunkIndex + 1}/${r.totalChunks}, id ${r.id})${copies}\n\n${r.text}`;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(Math.floor(n), max));
}

function round(n: number) {
  return Math.round(n * 10000) / 10000;
}
