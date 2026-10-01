import type { Env } from "../types";

export interface DocumentInfo {
  key: string;
  size: number;
  uploaded: string;
}

/**
 * Reads original documents from R2. Keys are the same relative paths stored
 * as `metadata.source` in Pinecone (uploaded by `npm run ingest -- --upload-r2`).
 */
export class DocumentStorage {
  constructor(private env: Env) {}

  get configured(): boolean {
    return Boolean(this.env.DOCS_BUCKET);
  }

  async getDocumentContent(key: string): Promise<string | null> {
    if (!this.env.DOCS_BUCKET) return null;
    const object = await this.env.DOCS_BUCKET.get(key);
    return object ? await object.text() : null;
  }

  async listDocuments(prefix?: string, limit = 100, cursor?: string): Promise<{ documents: DocumentInfo[]; cursor?: string }> {
    if (!this.env.DOCS_BUCKET) return { documents: [] };
    const listing = await this.env.DOCS_BUCKET.list({ prefix, limit, cursor });
    return {
      documents: listing.objects.map((obj) => ({
        key: obj.key,
        size: obj.size,
        uploaded: obj.uploaded.toISOString(),
      })),
      cursor: listing.truncated ? listing.cursor : undefined,
    };
  }
}
