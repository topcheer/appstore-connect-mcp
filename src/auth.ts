/**
 * auth.ts — JWT token generation for App Store Connect API.
 *
 * Apple's App Store Connect API authenticates using JWT signed with
 * ES256 (ECDSA P-256 + SHA-256). The private key comes from a .p8 file
 * downloaded from App Store Connect → Users and Access → Keys.
 */

import jwt from "jsonwebtoken";
import type { ASCCredentials } from "./types.js";

const AUDIENCE = "appstoreconnect-v1";
const TOKEN_TTL_SECONDS = 20 * 60; // 20 minutes (Apple allows max 20)

/** Cached token to avoid re-signing on every request. */
let cachedToken: string | null = null;
let cachedExpiry = 0;

/**
 * Generate (or return cached) a signed JWT for the App Store Connect API.
 *
 * @param creds  The issuer ID, key ID, and PEM private key
 * @param force  Force a fresh token even if the cache is still valid
 */
export function getToken(creds: ASCCredentials, force = false): string {
  const now = Math.floor(Date.now() / 1000);

  // Return cached token if it has >60s of life left
  if (!force && cachedToken && now < cachedExpiry - 60) {
    return cachedToken;
  }

  const payload = {
    iss: creds.issuerId,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS,
    aud: AUDIENCE,
  };

  cachedToken = jwt.sign(payload, creds.privateKey, {
    algorithm: "ES256",
    keyid: creds.keyId,
  });
  cachedExpiry = now + TOKEN_TTL_SECONDS;

  return cachedToken;
}

/**
 * Parse a .p8 file content into a PEM string suitable for jwt.sign().
 * Handles both raw PEM and the Apple AuthKey format.
 */
export function parsePrivateKey(raw: string): string {
  const trimmed = raw.trim();

  // Already in PEM format
  if (trimmed.includes("-----BEGIN PRIVATE KEY-----")) {
    return trimmed;
  }

  // Apple .p8 files are usually already PEM, but handle edge cases
  // where the header might be missing
  if (trimmed.includes("-----BEGIN")) {
    return trimmed;
  }

  // Try wrapping raw base64 content in PEM headers
  return `-----BEGIN PRIVATE KEY-----\n${trimmed}\n-----END PRIVATE KEY-----`;
}

/**
 * Validate that credentials look reasonable.
 * Throws a descriptive Error if something is missing.
 */
export function validateCredentials(creds: ASCCredentials): void {
  if (!creds.issuerId) {
    throw new Error(
      "Missing APP_STORE_CONNECT_ISSUER_ID. Set it via env or CLI flag."
    );
  }
  if (!creds.keyId) {
    throw new Error(
      "Missing APP_STORE_CONNECT_KEY_ID. Set it via env or CLI flag."
    );
  }
  if (!creds.privateKey) {
    throw new Error(
      "Missing APP_STORE_CONNECT_PRIVATE_KEY. Provide the .p8 file path via APP_STORE_CONNECT_P8_FILE or the key content via the env var."
    );
  }
}
