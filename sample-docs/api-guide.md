# flareRAG Model Context Protocol (MCP) Guide

## Model Context Protocol Overview
The Model Context Protocol (MCP) is an open standard created to enable Large Language Models (LLMs) and AI agents to discover tools, resources, and contextual knowledge from external services securely.

## Connecting Claude Desktop or Cursor
To connect Claude Desktop or Cursor to a flareRAG static docs search server, add the following configuration to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mycorpus-search": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://your-worker.workers.dev/mcp"]
    }
  }
}
```

## Available MCP Tools
- `search_documents`: Executes high-dimensional vector search across all indexed chunks using Voyage AI embeddings.
- `get_document_chunk`: Retrieves full text and metadata for a specific vector chunk ID.
- `get_full_document`: Reads raw document text directly from R2 or B2 storage.
- `list_documents`: Lists all indexed document keys in the system.
