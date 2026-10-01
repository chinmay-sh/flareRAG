# flareRAG Architecture & System Design

## Overview
flareRAG is an edge-first document search service designed to expose semantic retrieval through an MCP server.

## Edge Routing
The edge layer runs on Cloudflare Workers. Each request is automatically routed to the nearest edge location via Anycast DNS.

### Caching Strategy
Static assets can be cached using Cloudflare's cache controls.

### Vector Retrieval & Search
Vector indexing is handled through Pinecone. Embeddings are produced using a configured Voyage AI or Gemini model, with dimensions and metric set by the selected index.

## Storage Layer
Source documents can reside in Cloudflare R2 object storage. Documents are addressed by their source paths and can be retrieved through the optional document tools.
