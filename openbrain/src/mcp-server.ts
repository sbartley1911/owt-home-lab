import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  brainStats,
  captureThought,
  createPool,
  recentEntries,
  semanticSearch
} from "./openbrain.js";

const pool = createPool();
const defaultMatchCount = Number(process.env.OPENBRAIN_DEFAULT_MATCH_COUNT ?? "8");

const server = new McpServer({
  name: "openbrain",
  version: "0.1.0"
});

server.registerTool(
  "semantic_search",
  {
    title: "Search OpenBrain",
    description: "Find saved thoughts by meaning, not exact keywords.",
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(50).optional(),
      source: z.string().optional()
    }
  },
  async ({ query, limit, source }) => {
    const entries = await semanticSearch(pool, query, limit ?? defaultMatchCount, source);
    return textResult(entries);
  }
);

server.registerTool(
  "recent_entries",
  {
    title: "Recent OpenBrain Entries",
    description: "List recently captured thoughts.",
    inputSchema: {
      limit: z.number().int().min(1).max(50).optional(),
      source: z.string().optional()
    }
  },
  async ({ limit, source }) => {
    const entries = await recentEntries(pool, limit ?? 10, source);
    return textResult(entries);
  }
);

server.registerTool(
  "brain_stats",
  {
    title: "OpenBrain Stats",
    description: "Summarize capture counts, sources, and common topics.",
    inputSchema: {}
  },
  async () => textResult(await brainStats(pool))
);

server.registerTool(
  "capture_thought",
  {
    title: "Capture Thought",
    description: "Save a new thought into OpenBrain.",
    inputSchema: {
      content: z.string().min(1),
      source: z.string().optional(),
      sourceRef: z.string().optional(),
      people: z.array(z.string()).optional(),
      topics: z.array(z.string()).optional(),
      entryType: z.string().optional()
    }
  },
  async (input) => {
    const entry = await captureThought(pool, input);
    return textResult(entry);
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

function textResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}
