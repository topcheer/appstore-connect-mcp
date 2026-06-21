/**
 * transport.ts — Transport layer for the MCP server.
 *
 * Provides both stdio (local) and Streamable HTTP (remote) transports.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { randomUUID } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

/** Start the server with stdio transport (for local use). */
export async function startStdio(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[appstore-connect-mcp] stdio transport ready");
}

/** Factory that creates a fresh MCP server per HTTP session. */
export type ServerFactory = () => Server;

interface HttpSession {
  server: Server;
  transport: StreamableHTTPServerTransport;
}

/**
 * Start the server with HTTP/SSE transport (for remote deployment).
 *
 * Each client session gets its own Server instance + transport pair
 * (the MCP Server class only supports one transport at a time).
 *
 * Includes a health check endpoint at /health.
 */
export async function startHttp(
  createServer: ServerFactory,
  host: string,
  port: number
): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "50mb" }));

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: "appstore-connect-mcp", version: "1.0.0" });
  });

  // Session storage — each session has its own server + transport
  const sessions = new Map<string, HttpSession>();

  app.post("/mcp", async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const session = sessionId ? sessions.get(sessionId) : undefined;

      if (session) {
        // Existing session — delegate to its transport
        await session.transport.handleRequest(req, res, req.body);
      } else {
        // New session: create server + transport, handle the (initialize) request,
        // then store the session once its ID is available.
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        const server = createServer();

        transport.onclose = async () => {
          const sid = transport.sessionId;
          if (sid) {
            sessions.delete(sid);
            await server.close();
          }
        };

        await server.connect(transport);

        // handleRequest processes the initialize request and sets the session ID
        await transport.handleRequest(req, res, req.body);

        // After the initialize handshake, the session ID is available
        const newSid = transport.sessionId;
        if (newSid) {
          sessions.set(newSid, { server, transport });
        }
      }
    } catch (err) {
      console.error("[appstore-connect-mcp] MCP POST error:", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  // SSE streaming endpoint for server-to-client messages
  app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      res
        .status(400)
        .json({ error: "No valid session. Send an initialize request first." });
      return;
    }
    await session.transport.handleRequest(req, res);
  });

  // Session termination
  app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      res.status(400).json({ error: "No valid session." });
      return;
    }
    await session.transport.handleRequest(req, res);
  });

  app.listen(port, host, () => {
    console.error(
      `[appstore-connect-mcp] HTTP transport ready on http://${host}:${port}/mcp`
    );
    console.error(
      `[appstore-connect-mcp] Health check at http://${host}:${port}/health`
    );
  });
}
