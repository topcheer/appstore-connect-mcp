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
  /** Key into ToolsData.bodySchemas for the resolved JSON:API request body schema. */
  bodySchemaRef?: string;
  /** Compact shape of the success response: where the payload lives. */
  responseSchema?: ResponseSchemaInfo;
}

/** Shape of a success response body. */
export interface ResponseSchemaInfo {
  kind: "single" | "collection" | "reference";
  data?: { resourceRef?: string; resourceType?: string | null };
  /** Resource types that may appear in JSON:API "included" (compound documents). */
  included?: string[];
}

/** Resolved JSON:API request body schema (from tools.json bodySchemas). */
export interface BodySchema {
  data: {
    type?: { enum?: string[] };
    attributes?: { properties?: Record<string, unknown>; required?: string[] };
    relationships?: { properties?: Record<string, unknown>; required?: string[] };
    required?: string[];
  };
}

/** Resolved resource schema (from tools.json resourceSchemas). */
export interface ResourceSchema {
  resourceType?: string | null;
  attributes?: { properties?: Record<string, unknown>; required?: string[] };
  relationships?: { properties?: Record<string, unknown> };
}

/** The overall tools.json structure. */
export interface ToolsData {
  "$comment": string;
  apiVersion: string;
  baseUrl: string;
  stats: { total: number; by_method: Record<string, number> };
  categories: string[];
  /** Deduped request body schemas, keyed by Apple spec schema name. */
  bodySchemas?: Record<string, BodySchema>;
  /** Deduped resource schemas (response payloads), keyed by resource schema name. */
  resourceSchemas?: Record<string, ResourceSchema>;
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
