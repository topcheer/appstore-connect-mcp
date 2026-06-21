/**
 * server.ts — MCP server core.
 *
 * Exposes 4 MCP tools instead of 1200+ to keep LLM context small:
 *   - search_apis      → find the right operation by keyword
 *   - get_tool_details → get full parameter schema for an operation
 *   - call_api         → execute any App Store Connect API operation
 *   - list_categories  → browse API resource groups
 *
 * The LLM workflow: search → get details → call_api.
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

export function createMcpServer(opts: CreateServerOptions): Server {
  const { credentials, verbose } = opts;
  const toolsData = loadTools();

  const toolMap = new Map<string, ToolDef>();
  for (const t of toolsData.tools) {
    toolMap.set(t.name, t);
  }

  const server = new Server(
    { name: "appstore-connect-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  // ── Only register 4 tools ──────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "search_apis",
          description:
            "Search App Store Connect API operations by keyword. " +
            "Returns matching tool names, methods, paths, and categories. " +
            "Use this first to find the right operation before calling call_api.",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  "Search keyword (e.g. 'app', 'build', 'subscription', 'review', 'beta tester')",
              },
              category: {
                type: "string",
                description:
                  "Filter by category. Use list_categories to see all options.",
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
          name: "get_tool_details",
          description:
            "Get full details of a specific API operation: all parameters, " +
            "their types, descriptions, and required/optional status. " +
            "Call this after search_apis to learn what arguments call_api needs.",
          inputSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description:
                  "The tool name (operationId), e.g. 'apps_getCollection'",
              },
            },
            required: ["name"],
          },
        },
        {
          name: "call_api",
          description:
            "Execute any App Store Connect API operation. " +
            "Use search_apis to find the operation name, then get_tool_details " +
            "to see required parameters, then call_api to execute it.",
          inputSchema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description:
                  "The operation name (from search_apis), e.g. 'apps_getCollection'",
              },
              arguments: {
                type: "object",
                description:
                  "Arguments for the operation. " +
                  "Path params: e.g. {\"id\": \"123456\"}. " +
                  "Query params: e.g. {\"filter[name]\": \"MyApp\", \"limit\": 10}. " +
                  "For POST/PATCH: include \"_body\" with the JSON:API request body.",
                additionalProperties: true,
              },
            },
            required: ["name"],
          },
        },
        {
          name: "list_categories",
          description:
            "List all API categories (resource groups) and total operation count.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
      ],
    };
  });

  // ── CallTool handler ───────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const toolArgs = (args ?? {}) as Record<string, unknown>;

    if (verbose) {
      console.error(`[appstore-connect-mcp] tool call: ${name}`);
    }

    // ── search_apis ──────────────────────────────────────────────
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

    // ── get_tool_details ─────────────────────────────────────────
    if (name === "get_tool_details") {
      const toolName = String(toolArgs.name);
      const tool = toolMap.get(toolName);
      if (!tool) {
        return {
          content: [{ type: "text", text: `Tool not found: ${toolName}` }],
          isError: true,
        };
      }
      // Return tool def + computed input schema so LLM knows what to pass
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                name: tool.name,
                summary: tool.summary,
                method: tool.method,
                path: tool.path,
                category: tool.category,
                pathParams: tool.pathParams,
                queryParams: tool.queryParams.map((p) => ({
                  name: p.name,
                  required: p.required,
                  description: p.description,
                  type: p.schema.type,
                  ...(p.schema.items?.enum ? { enum: p.schema.items.enum } : {}),
                  ...(p.schema.enum ? { enum: p.schema.enum } : {}),
                })),
                hasBody: tool.hasBody,
                example: buildExample(tool),
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // ── call_api ─────────────────────────────────────────────────
    if (name === "call_api") {
      const opName = String(toolArgs.name);
      const opArgs = (toolArgs.arguments ?? {}) as Record<string, unknown>;
      const tool = toolMap.get(opName);

      if (!tool) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown operation: ${opName}. Use search_apis to find available operations.`,
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await executeTool(tool, opArgs, credentials);
        const text =
          typeof result === "string" ? result : JSON.stringify(result, null, 2);

        // Truncate large responses to protect LLM context
        const MAX = 25000;
        return {
          content: [
            {
              type: "text",
              text:
                text.length > MAX
                  ? text.slice(0, MAX) +
                    `\n\n... (truncated, ${text.length - MAX} more bytes)`
                  : text,
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
    }

    // ── list_categories ──────────────────────────────────────────
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
                byMethod: toolsData.stats.by_method,
                categories: toolsData.categories,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  });

  return server;
}

/** Build a usage example for a tool to help the LLM call it correctly. */
function buildExample(tool: ToolDef): object {
  const example: Record<string, unknown> = {};
  for (const p of tool.pathParams) {
    example[p.name] = p.name === "id" ? "1234567890" : `<${p.name}>`;
  }
  if (tool.queryParams.length > 0) {
    const first = tool.queryParams[0];
    example[first.name] = first.schema.type === "array" ? ["value1"] : "value";
  }
  if (tool.hasBody) {
    example["_body"] = {
      data: { type: "resourceType", attributes: {} },
    };
  }
  return example;
}
