/**
 * client.ts — HTTP client for the App Store Connect REST API.
 *
 * Handles JWT authentication, request building, JSON:API conventions,
 * error normalisation, and response formatting.
 */

import type { ASCCredentials } from "./types.js";
import { getToken } from "./auth.js";

const BASE_URL = "https://api.appstoreconnect.apple.com";

export interface ApiRequestOptions {
  method: string;
  path: string; // path template, e.g. "/v1/apps/{id}"
  pathParams?: Record<string, string>;
  queryParams?: Record<string, string | string[]>;
  body?: unknown;
  credentials: ASCCredentials;
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
       for (const v of value) {
         urlObj.searchParams.append(key, String(v));
       }
     } else {
       urlObj.searchParams.append(key, String(value));
     }
   }
 }

 // Get JWT token
 const token = getToken(opts.credentials);

 // Build fetch options
 const fetchOpts: RequestInit = {
   method: opts.method,
   headers: {
     Authorization: `Bearer ${token}`,
     Accept: "application/json",
   },
 };

 if (opts.body !== undefined && opts.method !== "GET" && opts.method !== "DELETE") {
   fetchOpts.headers = {
     ...fetchOpts.headers,
     "Content-Type": "application/json",
   };
   fetchOpts.body = JSON.stringify(opts.body);
 }

 // Execute request
 const response = await fetch(urlObj.toString(), fetchOpts);

 // Parse response
 const responseText = await response.text();

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
 if (response.status === 204 || !responseText) {
   return { status: response.status, message: "Success (no content)" };
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
