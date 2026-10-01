import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env } from "../types";
import { pineconeFromEnv, searchDocuments } from "../services/search";
import { DocumentStorage } from "../services/storage";

const SERVER_VERSION = "2.2.0";
const DEFAULT_COLLECTION = "a static collection of documents";
const DEFAULT_EXAMPLE = "what does the collection say about <topic>?";

/** MCP server name derived from COLLECTION_NAME, e.g. "My library" → "my-library-search". */
function serverName(env: Env): string {
  const slug = (env.COLLECTION_NAME ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug ? `${slug}-search` : "docs-search";
}

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}

/** Builds a fresh MCP server per request (required by the stateless `createMcpHandler`). */
export function createMcpServer(env: Env): McpServer {
  // What the documents are (wrangler.jsonc → COLLECTION_DESCRIPTION); tells clients when to use this server.
  const collection = env.COLLECTION_DESCRIPTION?.trim() || DEFAULT_COLLECTION;
  const tips = env.SEARCH_TIPS?.trim();
  const example = env.EXAMPLE_QUERY?.trim() || DEFAULT_EXAMPLE;

  const server = new McpServer(
    { name: serverName(env), title: env.COLLECTION_NAME?.trim() || undefined, version: SERVER_VERSION },
    {
      instructions: [
        `This server searches ${collection}.`,
        "Workflow: (1) call search_documents with a natural-language question; (2) if a passage is relevant " +
          "but cut off or missing context, call get_full_document with its `source`; (3) cite the `source` " +
          "file name for every fact you use.",
        "Search is semantic (by meaning), not keyword matching: describe what you are looking for, and try 2-3 " +
          "differently worded queries (synonyms, names, code words, dates) before concluding something is not there.",
        "Only state what the returned passages say. The texts may contain OCR errors, so quote carefully.",
        ...(tips ? [tips] : []),
      ].join("\n"),
    }
  );
  const storage = new DocumentStorage(env);

  server.registerTool(
    "search_documents",
    {
      title: "Search documents",
      description:
        `Search ${collection} by meaning and return the most relevant passages.\n\n` +
        "Use this first for any question the collection might answer. Each result has a rank, a relevance " +
        "score (0-1), the document title and section, the `source` file name (use it for citations and for " +
        "get_full_document), a chunk id, and the passage text (up to ~2000 characters). The same passage found " +
        'in several files is returned once, with the other files listed as "same text also in".\n\n' +
        "Tips: ask full questions rather than single keywords; include specific names, places, code words or " +
        "dates; if results are weak, rephrase or raise rerank_k. Scores below ~0.3 usually mean no good match." +
        (tips ? `\n${tips}` : ""),
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe(`What to find, as a natural-language question or description, e.g. "${example}"`),
        rerank_k: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Number of passages to return (default 5). Use 10-20 for broad or survey-style questions."),
        retrieval_k: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Candidate passages considered before reranking (default 20). Raise it for rare topics."),
        source: z
          .string()
          .optional()
          .describe("Only search inside this one document (its exact `source` file name from an earlier result)."),
        dedupe: z
          .boolean()
          .optional()
          .describe("Merge identical passages from different files (default true). Set false to see every copy."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, retrieval_k, rerank_k, source, dedupe }) => {
      const res = await searchDocuments(env, query, { retrievalK: retrieval_k, rerankK: rerank_k, source, dedupe });
      if (res.results.length === 0) return text(`No matching passages found for: "${res.query}"`);
      const header =
        `${res.results.length} passages (from ${res.unique_count} distinct of ${res.retrieved_count} candidates, ${res.latency_ms} ms)` +
        (res.rerank_warning ? `\nWarning: ${res.rerank_warning}` : "");
      return text(`${header}\n\n${res.context_bundle}`);
    }
  );

  server.registerTool(
    "get_document_chunk",
    {
      title: "Get passage by id",
      description:
        "Fetch one passage and its metadata (source, title, section, position in the document) by the chunk id " +
        "shown in search results. Useful for re-reading one specific result.",
      inputSchema: z.object({
        chunk_id: z.string().min(1).describe('Chunk id exactly as shown in a search result (format "<hash>:<number>").'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ chunk_id }) => {
      const records = await pineconeFromEnv(env).fetch([chunk_id]);
      const rec = records[chunk_id];
      if (!rec?.metadata) return text(`Chunk not found: ${chunk_id}`, true);
      return text(JSON.stringify(rec.metadata, null, 2));
    }
  );

  server.registerTool(
    "get_full_document",
    {
      title: "Read full document",
      description:
        "Read the complete original text of one document, to see the context around a search result or to " +
        "summarize a whole document. Long documents are returned in pages: if the reply ends with a " +
        "[truncated ...] note, call again with the offset it gives to continue.",
      inputSchema: z.object({
        path: z.string().min(1).describe("The document's `source` file name exactly as shown in search results."),
        offset: z.number().int().min(0).optional().describe("Character offset to start reading from (default 0)."),
        max_chars: z.number().int().min(1000).max(200_000).optional().describe("Maximum characters returned (default 50000)."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ path, offset = 0, max_chars = 50_000 }) => {
      if (!storage.configured) return text("Document storage (R2) is not configured on this server.", true);
      const content = await storage.getDocumentContent(path);
      if (content === null) return text(`Document not found: ${path}`, true);
      const part = content.slice(offset, offset + max_chars);
      const end = offset + part.length;
      const note = end < content.length ? `\n\n[truncated: showing ${offset}-${end} of ${content.length} chars; call again with offset=${end}]` : "";
      return text(part + note);
    }
  );

  server.registerTool(
    "list_documents",
    {
      title: "List documents",
      description:
        "List document file names in the collection, optionally filtered by a file-name prefix. Use it to browse " +
        "or to check whether a specific document exists. To find documents about a topic, use search_documents instead.",
      inputSchema: z.object({
        prefix: z.string().optional().describe("Only list file names starting with this text."),
        limit: z.number().int().min(1).max(1000).optional().describe("Maximum names returned (default 100)."),
        cursor: z.string().optional().describe("Pagination cursor returned by a previous call."),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ prefix, limit = 100, cursor }) => {
      if (!storage.configured) return text("Document storage (R2) is not configured on this server.", true);
      const res = await storage.listDocuments(prefix, limit, cursor);
      return text(JSON.stringify(res, null, 2));
    }
  );

  return server;
}
