#!/usr/bin/env node
/**
 * index.ts — Entry point for appstore-connect-mcp.
 *
 * Usage:
 *   # Local (stdio) — for Claude Desktop, Cursor, etc.
 *   appstore-connect-mcp
 *   appstore-connect-mcp --transport stdio
 *
 *   # Remote (HTTP) — for server deployment
 *   appstore-connect-mcp --transport http --port 3000 --host 0.0.0.0
 *
 * Environment variables:
 *   APP_STORE_CONNECT_ISSUER_ID    Your App Store Connect issuer ID
 *   APP_STORE_CONNECT_KEY_ID       Your API key ID
 *   APP_STORE_CONNECT_PRIVATE_KEY  PEM private key content (alternative: path)
 *   APP_STORE_CONNECT_P8_FILE      Path to your .p8 private key file
 *   MCP_TRANSPORT                  'stdio' (default) or 'http'
 *   MCP_PORT                       HTTP port (default: 3000)
 *   MCP_HOST                       HTTP host (default: 0.0.0.0)
 *   MCP_VERBOSE                    Set to '1' for verbose logging
 */

import { readFileSync } from "node:fs";
import { createMcpServer } from "./server.js";
import { startStdio, startHttp } from "./transport.js";
import { getToken, parsePrivateKey, validateCredentials } from "./auth.js";
import type { ServerConfig } from "./types.js";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        result[key] = next;
        i++;
      } else {
        result[key] = true;
      }
    }
  }
  return result;
}

function loadConfig(): ServerConfig {
  const args = parseArgs(process.argv);

  // Transport
  const transport = (
    (args.transport as string) ||
    process.env.MCP_TRANSPORT ||
    "stdio"
  ) as "stdio" | "http";

  // Credentials
  const issuerId =
    (args["issuer-id"] as string) ||
    process.env.APP_STORE_CONNECT_ISSUER_ID ||
    "";

  const keyId =
    (args["key-id"] as string) ||
    process.env.APP_STORE_CONNECT_KEY_ID ||
    "";

  // Private key: env var content or file path
  let privateKey = process.env.APP_STORE_CONNECT_PRIVATE_KEY || "";
  const p8File =
    (args["p8-file"] as string) ||
    process.env.APP_STORE_CONNECT_P8_FILE ||
    "";

  if (!privateKey && p8File) {
    privateKey = readFileSync(p8File, "utf-8");
  }

  // Also check legacy env var names
  const legacyKey = process.env.ASC_PRIVATE_KEY || process.env.APPSTORE_CONNECT_PRIVATE_KEY;
  if (!privateKey && legacyKey) {
    privateKey = legacyKey;
  }

  const credentials = {
    issuerId,
    keyId,
    privateKey: privateKey ? parsePrivateKey(privateKey) : "",
  };

  const verbose =
    args.verbose === true || process.env.MCP_VERBOSE === "1";

  const port = parseInt(
    (args.port as string) || process.env.MCP_PORT || "3000",
    10
  );
  const host = (args.host as string) || process.env.MCP_HOST || "0.0.0.0";

  return {
    credentials,
    transport,
    port,
    host,
    verbose,
  };
}

async function main(): Promise<void> {
  const config = loadConfig();

  try {
    validateCredentials(config.credentials);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    console.error("\nSee https://github.com/topcheer/appstore-connect-mcp#setup for help.");
    process.exit(1);
  }

  // Verify the key works by generating a test token
  try {
    getToken(config.credentials);
  } catch (err) {
    console.error(`Error: Failed to sign JWT — invalid private key. ${(err as Error).message}`);
    process.exit(1);
  }

  if (config.verbose) {
    console.error(`[appstore-connect-mcp] Starting in ${config.transport} mode`);
  }

  if (config.transport === "http") {
    // HTTP mode: factory creates a fresh server per session
    const createServer = () =>
      createMcpServer({
        credentials: config.credentials,
        verbose: config.verbose,
      });
    await startHttp(createServer, config.host ?? "0.0.0.0", config.port ?? 3000);
  } else {
    // Stdio mode: single server instance
    const server = createMcpServer({
      credentials: config.credentials,
      verbose: config.verbose,
    });
    await startStdio(server);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
