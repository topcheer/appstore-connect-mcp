/**
 * client.ts — HTTP client for the App Store Connect REST API.
 *
 * Handles JWT authentication, request building, JSON:API conventions,
 * error normalisation, and response formatting.
 */

import type { ASCCredentials } from "./types.js";
import { getToken } from "./auth.js";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE_URL = "https://api.appstoreconnect.apple.com";

/** Binary bodies up to this size are inlined as base64; larger ones go to a temp file. */
const MAX_INLINE_BINARY = 8 * 1024 * 1024;

export interface ApiRequestOptions {
  method: string;
  path: string; // path template, e.g. "/v1/apps/{id}"
  pathParams?: Record<string, string>;
  queryParams?: Record<string, string | string[]>;
  body?: unknown;
  credentials: ASCCredentials;
  /**
   * Override the Accept header. Report endpoints return gzip files (Apple
   * rejects `application/json` with 406): use `application/a-gzip` for
   * salesReports/financeReports, an asterisk wildcard (`&#42;/&#42;`) for perfPowerMetrics.
   */
  accept?: string;
}

/**
 * Execute a single App Store Connect API request.
 *
 * @returns the parsed JSON response body (or null for 204).
 * @throws  Error with a descriptive message on failure.
 */
export async function callApi(opts: ApiRequestOptions): Promise<unknown> {
 // Build the URL with path parameters
 let url = opts.path;
 for (const [key, value] of Object.entries(opts.pathParams ?? {})) {
   url = url.replace(`{${key}}`, encodeURIComponent(value));
 }

 // Append query parameters
 const urlObj = new URL(url, BASE_URL);
 if (opts.queryParams) {
   for (const [key, value] of Object.entries(opts.queryParams)) {
     if (value === undefined || value === null || value === "") continue;
     if (Array.isArray(value)) {
       // App Store Connect expects comma-separated values
       // (`fields[apps]=name,bundleId`), NOT repeated keys - repeated
       // keys fail with 400 PARAMETER_ERROR.DUPLICATE.
       const joined = value
         .filter((v) => v !== undefined && v !== null && String(v) !== "")
         .map((v) => String(v))
         .join(",");
       if (joined) {
         urlObj.searchParams.append(key, joined);
       }
     } else {
       urlObj.searchParams.append(key, String(value));
     }
   }
 }

 // Get JWT token
 let token = getToken(opts.credentials);

 // Build fetch options
 const buildFetchOpts = (t: string): RequestInit => {
   const headers: Record<string, string> = {
     Authorization: `Bearer ${t}`,
     Accept: opts.accept ?? "application/json",
   };
   if (opts.body !== undefined && opts.method !== "GET" && opts.method !== "DELETE") {
     headers["Content-Type"] = "application/json";
   }
   const init: RequestInit = { method: opts.method, headers };
   if (opts.body !== undefined && opts.method !== "GET" && opts.method !== "DELETE") {
     init.body = JSON.stringify(opts.body);
   }
   return init;
 };

 // Execute request
 let response = await fetch(urlObj.toString(), buildFetchOpts(token));

 // Self-healing: a cached token can be rejected by Apple (clock skew,
 // server-side revocation between calls). Force-sign a fresh JWT and
 // retry exactly once - subsequent calls take the normal cache path.
 if (response.status === 401) {
   token = getToken(opts.credentials, true);
   response = await fetch(urlObj.toString(), buildFetchOpts(token));
 }

  // Parse response. Read bytes first: report endpoints return gzip files,
  // which `response.text()` would corrupt.
  const contentType = response.headers.get("content-type") ?? "";
  const buffer = Buffer.from(await response.arrayBuffer());
  const responseText = buffer.toString("utf8");

  if (!response.ok) {
    let errorDetail: unknown;
    try {
      errorDetail = JSON.parse(responseText);
    } catch {
      errorDetail = responseText;
    }
    throw new ApiError(response.status, errorDetail, opts.method, url);
  }

  // 204 No Content or empty body
  if (response.status === 204 || buffer.length === 0) {
    return { status: response.status, message: "Success (no content)" };
  }

  const isJson = /json/i.test(contentType) || /^\s*(\[|\{)/.test(responseText);
  if (!isJson) {
    const meta = { contentType, size: buffer.length };
    if (buffer.length <= MAX_INLINE_BINARY) {
      return { _binary: { ...meta, encoding: "base64", base64: buffer.toString("base64") } };
    }
    const file = join(tmpdir(), `appstore-connect-mcp-${randomBytes(6).toString("hex")}.bin`);
    writeFileSync(file, buffer);
    return { _binary: { ...meta, file } };
  }

  try {
    return JSON.parse(responseText);
  } catch {
    return responseText;
  }
}

/** Structured error from the App Store Connect API. */
export class ApiError extends Error {
  status: number;
  detail: unknown;
  method: string;
  url: string;

  constructor(status: number, detail: unknown, method: string, url: string) {
    const message =
      typeof detail === "object" && detail !== null && "errors" in detail
        ? JSON.stringify((detail as any).errors, null, 2)
        : `HTTP ${status}: ${String(detail).slice(0, 200)}`;
    super(message);
    this.name = "AppStoreConnectApiError";
    this.status = status;
    this.detail = detail;
    this.method = method;
    this.url = url;
  }
}
