/**
 * version.ts — Single source of truth for the server version.
 *
 * Reads from package.json at build time so the MCP serverInfo and
 * health check always report the real package version.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, "..", "package.json"), "utf-8")
    );
    return pkg.version ?? "0.0.0";
  } catch {
    // Fallback: package.json not available (e.g. running from dist without parent)
    return "0.0.0";
  }
}

export const SERVER_VERSION = readVersion();
