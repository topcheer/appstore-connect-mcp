/**
 * server.ts - MCP server core.
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
import type { ASCCredentials, ToolDef, ToolsData } from "./types.js";
import { loadTools, buildInputSchema, executeTool } from "./tools.js";
import { SERVER_VERSION } from "./version.js";

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
    { name: "appstore-connect-mcp", version: SERVER_VERSION },
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
                  "For POST/PATCH: include \"_body\" with the JSON:API request body - " +
                  "call get_tool_details first for the exact body schema " +
                  "(attributes, relationships and response field names).",
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
      const bodySchema = tool.bodySchemaRef
        ? toolsData.bodySchemas?.[tool.bodySchemaRef]
        : undefined;
      const resource = tool.responseSchema?.data?.resourceRef
        ? toolsData.resourceSchemas?.[tool.responseSchema.data.resourceRef]
        : undefined;
      const responseSchema = tool.responseSchema
        ? {
            ...tool.responseSchema,
            ...(resource ? { resource } : {}),
          }
        : undefined;
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
                pathParams: tool.pathParams.map((p) => ({
                  name: p.name,
                  required: p.required,
                  description: truncate(p.description),
                  schema: p.schema,
                })),
                queryParams: tool.queryParams.map((p) => ({
                  name: p.name,
                  required: p.required,
                  description: truncate(p.description),
                  type: p.schema.type,
                  ...(p.schema.items?.enum ? { enum: capEnum(p.schema.items.enum) } : {}),
                  ...(p.schema.enum ? { enum: capEnum(p.schema.enum) } : {}),
                })),
                hasBody: tool.hasBody,
                ...(bodySchema ? { bodySchema } : {}),
                ...(responseSchema ? { responseSchema } : {}),
                example: buildExample(tool, toolsData),
              }
              // Compact JSON: this payload is consumed by an LLM, pretty-printing
              // would nearly double its size for large operations.
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
const MAX_DESCRIPTION = 500;
const MAX_ENUM = 40;

/** Cap long spec descriptions (some field docs run >1KB and poison LLM context). */
function truncate(text: string, max = MAX_DESCRIPTION): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "...";
}

/** Cap long enum lists (fields[...] enums enumerate whole resource schemas). */
function capEnum(values: string[]): string[] {
  if (values.length <= MAX_ENUM) return values;
  return [...values.slice(0, MAX_ENUM), `... (+${values.length - MAX_ENUM} more)`];
}

function buildExample(tool: ToolDef, toolsData: ToolsData): object {
  const example: Record<string, unknown> = {};
  for (const p of tool.pathParams) {
    example[p.name] = p.name === "id" ? "1234567890" : `<${p.name}>`;
  }
  if (tool.queryParams.length > 0) {
    const first = tool.queryParams[0];
    example[first.name] = first.schema.type === "array" ? ["value1"] : "value";
  }
  if (tool.hasBody) {
    example["_body"] = bodyExample(tool, toolsData);
  }
  return example;
}

/**
 * Build a realistic _body example from the resolved body schema, so the LLM
 * sees the exact data.type, attribute names and relationship targets.
 */
function bodyExample(tool: ToolDef, toolsData: ToolsData): object {
  const bs = tool.bodySchemaRef
    ? toolsData.bodySchemas?.[tool.bodySchemaRef]
    : undefined;
  const dataDef = bs?.data;
  if (!dataDef) {
    return { data: { type: "resourceType", attributes: {} } };
  }
  const data: Record<string, unknown> = {
    type: dataDef.type?.enum?.[0] ?? "<resourceType>",
  };
  const attrs = dataDef.attributes?.properties;
  if (attrs) {
    const attributes: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(attrs)) {
      attributes[k] = placeholder(v);
    }
    data.attributes = attributes;
  }
  const rels = dataDef.relationships?.properties;
  if (rels) {
    const relationships: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rels)) {
      const target =
        (v as { data?: { type?: { enum?: string[] } } })?.data?.type?.enum?.[0] ??
        "<resourceType>";
      relationships[k] =
        (v as { kind?: string })?.kind === "toMany"
          ? { data: [{ type: target, id: "<related-id>" }] }
          : { data: { type: target, id: "<related-id>" } };
    }
    data.relationships = relationships;
  }
  return { data };
}

/** Produce a plausible placeholder value for a compact schema node. */
function placeholder(v: unknown): unknown {
  if (!v || typeof v !== "object") return "value";
  const node = v as {
    type?: string;
    enum?: unknown[];
    nullable?: boolean;
    items?: unknown;
    properties?: Record<string, unknown>;
  };
  if (node.enum && node.enum.length > 0) return node.enum[0];
  if (node.nullable) return null;
  switch (node.type) {
    case "boolean":
      return true;
    case "integer":
    case "number":
      return 1;
    case "array":
      return [placeholder(node.items)];
    case "object":
      if (node.properties) {
        const obj: Record<string, unknown> = {};
        for (const [k, sv] of Object.entries(node.properties)) {
          obj[k] = placeholder(sv);
        }
        return obj;
      }
      return {};
    default:
      return "string";
  }
}
