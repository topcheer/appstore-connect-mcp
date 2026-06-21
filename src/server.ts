/**
 * server.ts — MCP server core.
 *
 * Creates a Model Context Protocol server that exposes all App Store Connect
 * API operations as MCP tools. Uses the low-level Server class for efficient
 * handling of 1200+ dynamically-generated tools.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ASCCredentials, ToolDef } from "./types.js";
import { loadTools, buildInputSchema, executeTool } from "./tools.js";

export interface CreateServerOptions {
  credentials: ASCCredentials;
  verbose?: boolean;
}

/**
 * Create and configure the MCP server.
 *
 * Registers:
 *   - ListTools handler → returns all generated tools + 3 meta-tools
 *   - CallTool handler  → dispatches to the API or meta-tool
 */
export function createMcpServer(opts: CreateServerOptions): Server {
  const { credentials, verbose } = opts;
  const toolsData = loadTools();

  // Build a lookup map for O(1) dispatch
  const toolMap = new Map<string, ToolDef>();
  for (const t of toolsData.tools) {
    toolMap.set(t.name, t);
  }

  const server = new Server(
    {
      name: "appstore-connect-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // ── ListTools handler ──────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const cursor = request.params?.cursor;
    const PAGE_SIZE = 100;
    const startIndex = cursor ? parseInt(cursor, 10) || 0 : 0;

    const allTools = toolsData.tools;
    const page = allTools.slice(startIndex, startIndex + PAGE_SIZE);
    const hasNext = startIndex + PAGE_SIZE < allTools.length;

    const mcpTools = page.map((tool) => ({
      name: tool.name,
      description: `[${tool.category}] ${tool.summary} (${tool.method} ${tool.path})`,
      inputSchema: buildInputSchema(tool),
    }));

    // On the first page, also add meta-tools
    if (startIndex === 0) {
      mcpTools.unshift(
        {
          name: "search_apis",
          description:
            "Search App Store Connect API operations by keyword. Returns matching tool names, methods, and paths.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Search keyword (e.g. 'app', 'build', 'subscription', 'review')",
              },
              category: {
                type: "string",
                description: "Filter by category (e.g. 'Apps', 'Builds')",
              },
              method: {
                type: "string",
                enum: ["GET", "POST", "PATCH", "DELETE"],
                description: "Filter by HTTP method",
              },
            },
            required: ["query"],
          },
        },
        {
          name: "list_categories",
          description: "List all API categories (resource groups) available in the App Store Connect API.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "get_tool_details",
          description:
            "Get full details of a specific API operation including all parameters and their descriptions.",
          inputSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description: "The tool name (operationId), e.g. 'apps_getCollection'",
              },
            },
            required: ["name"],
          },
        }
      );
    }

    return {
      tools: mcpTools,
      ...(hasNext ? { nextCursor: String(startIndex + PAGE_SIZE) } : {}),
    };
  });

  // ── CallTool handler ───────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const toolArgs = (args ?? {}) as Record<string, unknown>;

    if (verbose) {
      console.error(`[appstore-connect-mcp] tool call: ${name}`);
    }

    // ── Meta-tools ───────────────────────────────────────────────
    if (name === "search_apis") {
      const query = String(toolArgs.query || "").toLowerCase();
      const category = toolArgs.category as string | undefined;
      const method = toolArgs.method as string | undefined;

      const matches = toolsData.tools.filter((t) => {
        if (category && t.category !== category) return false;
        if (method && t.method !== method) return false;
        const haystack = `${t.name} ${t.summary} ${t.path} ${t.category}`.toLowerCase();
        return haystack.includes(query);
      });

      const results = matches.slice(0, 50).map((t) => ({
        name: t.name,
        summary: t.summary,
        method: t.method,
        path: t.path,
        category: t.category,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                query,
                totalMatches: matches.length,
                showing: results.length,
                results,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    if (name === "list_categories") {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                apiVersion: toolsData.apiVersion,
                totalTools: toolsData.stats.total,
                totalCategories: toolsData.categories.length,
                categories: toolsData.categories,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    if (name === "get_tool_details") {
      const toolName = String(toolArgs.name);
      const tool = toolMap.get(toolName);
      if (!tool) {
        return {
          content: [{ type: "text", text: `Tool not found: ${toolName}` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(tool, null, 2),
          },
        ],
      };
    }

    // ── API tools ────────────────────────────────────────────────
    const tool = toolMap.get(name);
    if (!tool) {
      return {
        content: [
          {
            type: "text",
            text: `Unknown tool: ${name}. Use search_apis to find available operations.`,
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await executeTool(tool, toolArgs, credentials);

      // Format response — ensure it's compact text for the LLM
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);

      return {
        content: [
          {
            type: "text",
            text: text.length > 50000 ? text.slice(0, 50000) + "\n... (truncated)" : text,
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: `API Error: ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}
