import type { ChunkMetadata } from "../types";
import { requestJsonWithRetry } from "./http";

const API_VERSION = "2025-04";

export interface PineconeRecord {
  id: string;
  values: number[];
  metadata: ChunkMetadata;
}

export interface PineconeMatch {
  id: string;
  score: number;
  metadata?: ChunkMetadata;
}

/**
 * Minimal fetch-based Pinecone data-plane client. Works in the Worker and in Node.
 * `host` is the index host shown in the Pinecone console (with or without https://).
 */
export class PineconeClient {
  private baseUrl: string;

  constructor(host: string, private apiKey: string, private namespace = "docs") {
    if (!host) throw new Error("PINECONE_INDEX_HOST is required but was not provided.");
    if (!apiKey) throw new Error("PINECONE_API_KEY is required but was not provided.");
    this.baseUrl = (host.startsWith("http") ? host : `https://${host}`).replace(/\/+$/, "");
  }

  async query(vector: number[], topK: number, filter?: Record<string, unknown>): Promise<PineconeMatch[]> {
    const res = await this.request<{ matches?: PineconeMatch[] }>("POST", "/query", {
      namespace: this.namespace,
      vector,
      topK,
      includeMetadata: true,
      includeValues: false,
      ...(filter ? { filter } : {}),
    });
    return res.matches ?? [];
  }

  /** Upserts one request's worth of records. Callers keep batches under Pinecone's 2 MB / 1000-record limit. */
  async upsert(records: PineconeRecord[]): Promise<number> {
    if (records.length === 0) return 0;
    const res = await this.request<{ upsertedCount?: number }>("POST", "/vectors/upsert", {
      namespace: this.namespace,
      vectors: records,
    });
    return res.upsertedCount ?? records.length;
  }

  async deleteIds(ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += 1000) {
      await this.request("POST", "/vectors/delete", { namespace: this.namespace, ids: ids.slice(i, i + 1000) });
    }
  }

  async fetch(ids: string[]): Promise<Record<string, { id: string; metadata?: ChunkMetadata }>> {
    const params = new URLSearchParams({ namespace: this.namespace });
    for (const id of ids) params.append("ids", id);
    const res = await this.request<{ vectors?: Record<string, { id: string; metadata?: ChunkMetadata }> }>(
      "GET",
      `/vectors/fetch?${params}`
    );
    return res.vectors ?? {};
  }

  async describeStats(): Promise<{ dimension?: number; totalVectorCount?: number; namespaces?: Record<string, { vectorCount: number }> }> {
    return this.request("POST", "/describe_index_stats", {});
  }

  private request<T = unknown>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    return requestJsonWithRetry<T>(
      this.baseUrl + path,
      {
        method,
        headers: { "Api-Key": this.apiKey, "X-Pinecone-API-Version": API_VERSION },
        body,
      },
      "Pinecone"
    );
  }
}
