/**
 * tools.ts — Tool registry: loads tools.json, builds MCP input schemas,
 * and dispatches tool calls to the API client.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ToolDef, ToolsData, ASCCredentials } from "./types.js";
import { callApi } from "./client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Load the generated tools data from tools.json. */
export function loadTools(): ToolsData {
  const raw = readFileSync(join(__dirname, "tools.json"), "utf-8");
  return JSON.parse(raw) as ToolsData;
}

/**
 * Build a JSON Schema input for an MCP tool from its definition.
 *
 * Path params become top-level required string properties.
 * Query params become optional properties (arrays / strings / enums).
 * POST/PATCH operations get a `_body` object property.
 */
export function buildInputSchema(tool: ToolDef): object {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  // Path parameters
  for (const p of tool.pathParams) {
    properties[p.name] = {
      type: "string",
      description: p.description || `Path parameter: ${p.name}`,
    };
    if (p.required) {
      required.push(p.name);
    }
  }

  // Query parameters
  for (const p of tool.queryParams) {
    const schemaType = p.schema?.type;
    if (schemaType === "array") {
      const items = p.schema?.items;
      properties[p.name] = {
        type: "array",
        items: {
          type: items?.type || "string",
          ...(items?.enum ? { enum: items.enum } : {}),
        },
        description: p.description || `Query parameter: ${p.name}`,
      };
    } else if (p.schema?.enum) {
      properties[p.name] = {
        type: "string",
        enum: p.schema.enum,
        description: p.description || `Query parameter: ${p.name}`,
      };
    } else {
      properties[p.name] = {
        type: schemaType || "string",
        description: p.description || `Query parameter: ${p.name}`,
      };
    }
    if (p.required) {
      required.push(p.name);
    }
  }

  // Request body for POST/PATCH
  if (tool.hasBody) {
    properties["_body"] = {
      type: "object",
      description:
        "JSON:API request body. Follow the App Store Connect API JSON:API format: { data: { type, attributes, relationships } }.",
    };
    required.push("_body");
  }

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/**
 * Execute a tool call: extract params, call the API, return the result.
 *
 * @returns the API response (already JSON-parsed).
 */
export async function executeTool(
  tool: ToolDef,
  args: Record<string, unknown>,
  credentials: ASCCredentials
): Promise<unknown> {
  // Separate path params, query params, and body
  const pathParams: Record<string, string> = {};
  const queryParams: Record<string, string | string[]> = {};
  let body: unknown = undefined;

  for (const p of tool.pathParams) {
    if (p.name in args) {
      pathParams[p.name] = String(args[p.name]);
    }
  }

  for (const p of tool.queryParams) {
    if (p.name in args && args[p.name] !== undefined) {
      const val = args[p.name];
      if (Array.isArray(val)) {
        queryParams[p.name] = val.map(String);
      } else {
        queryParams[p.name] = String(val);
      }
    }
  }

  if (tool.hasBody && "_body" in args) {
    body = args["_body"];
  }

  return callApi({
    method: tool.method,
    path: tool.path,
    pathParams,
    queryParams,
    body,
    credentials,
  });
}
