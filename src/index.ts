import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "./types";
import { createMcpServer } from "./mcp/server";
import { pineconeFromEnv, searchDocuments } from "./services/search";
import { DocumentStorage } from "./services/storage";
import { renderWebInterface } from "./ui";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // Public routes
    if (pathname === "/health") {
      return json({
        status: "ok",
        collection: env.COLLECTION_NAME || "(unnamed)",
        namespace: env.PINECONE_NAMESPACE || "docs",
        embedProvider: env.EMBED_PROVIDER || "voyage",
        embedModel: env.EMBED_MODEL || "(provider default)",
        dimensions: env.EMBED_DIMENSIONS || "1024",
        contextEmbeddingEnabled: env.CONTEXT_EMBEDDING_ENABLED === "true",
        rerankModel: env.RERANK_MODEL || "rerank-2.5",
        pineconeConfigured: Boolean(env.PINECONE_INDEX_HOST && env.PINECONE_API_KEY),
        r2Configured: Boolean(env.DOCS_BUCKET),
      });
    }
    if (pathname === "/" && request.method === "GET") {
      return new Response(renderWebInterface(env.COLLECTION_NAME), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // Everything else requires the bearer token (CORS preflights pass through to the MCP handler).
    if (request.method !== "OPTIONS" && !(await isAuthorized(request, env))) {
      return json({ error: "Unauthorized" }, 401, { "WWW-Authenticate": 'Bearer realm="docs-search"' });
    }

    if (pathname === "/mcp") {
      return createMcpHandler(() => createMcpServer(env), { route: "/mcp" })(request, env, ctx);
    }

    if (pathname === "/search" && request.method === "GET") {
      const q = url.searchParams.get("q") ?? "";
      if (!q.trim()) return json({ error: "Query parameter 'q' is required." }, 400);
      try {
        return json(
          await searchDocuments(env, q, {
            retrievalK: intParam(url, "retrieval_k"),
            rerankK: intParam(url, "rerank_k"),
            source: url.searchParams.get("source") || undefined,
            dedupe: url.searchParams.get("dedupe") !== "false",
          })
        );
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }

    if (pathname.startsWith("/doc/") && request.method === "GET") {
      const key = decodeURIComponent(pathname.slice("/doc/".length));
      const content = await new DocumentStorage(env).getDocumentContent(key);
      if (content === null) return new Response(`Document '${key}' not found`, { status: 404 });
      return new Response(content, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    return new Response("Not Found", { status: 404 });
  },

  /** Daily keep-alive query so the free Pinecone index never counts as inactive. */
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const dims = parseInt(env.EMBED_DIMENSIONS || "1024", 10);
    const probe = new Array(dims).fill(0);
    probe[0] = 1;
    const matches = await pineconeFromEnv(env).query(probe, 1);
    console.log(`keep-alive: Pinecone returned ${matches.length} match(es)`);
  },
} satisfies ExportedHandler<Env>;

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  if (!env.MCP_TOKEN) return false; // fail closed if the secret is missing
  const header = request.headers.get("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return false;
  // Compare fixed-length digests so the comparison is constant-time regardless of input length.
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(token)),
    crypto.subtle.digest("SHA-256", enc.encode(env.MCP_TOKEN)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function intParam(url: URL, name: string): number | undefined {
  const v = url.searchParams.get(name);
  return v ? parseInt(v, 10) || undefined : undefined;
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
