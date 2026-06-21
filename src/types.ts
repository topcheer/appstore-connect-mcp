/**
 * Type definitions for the App Store Connect MCP server.
 */

/** A single parameter in a tool definition (path or query). */
export interface ToolParam {
  name: string;
  required: boolean;
  description: string;
  schema: {
    type?: string;
    items?: { type?: string; enum?: string[] };
    enum?: string[];
  };
}

/** A tool definition generated from the OpenAPI spec. */
export interface ToolDef {
  name: string;
  summary: string;
  description: string;
  method: string;
  path: string;
  category: string;
  pathParams: ToolParam[];
  queryParams: ToolParam[];
  hasBody: boolean | object;
}

/** The overall tools.json structure. */
export interface ToolsData {
  "$comment": string;
  apiVersion: string;
  baseUrl: string;
  stats: { total: number; by_method: Record<string, number> };
  categories: string[];
  tools: ToolDef[];
}

/** Credentials for App Store Connect API. */
export interface ASCCredentials {
  issuerId: string;
  keyId: string;
  privateKey: string; // PEM-formatted ECDSA P-256 private key
}

/** Configuration for the MCP server. */
export interface ServerConfig {
  credentials: ASCCredentials;
  transport: "stdio" | "http";
  port?: number;
  host?: string;
  verbose?: boolean;
}
