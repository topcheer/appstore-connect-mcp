# appstore-connect-mcp (Rust)

Rust port of [`@ggaiteam/appstore-connect-mcp`](../README.md) - the Model Context
Protocol server that exposes the entire **Apple App Store Connect API**
(1,216 operations) via only **4 MCP tools**.

Same architecture, same data file, same environment variables:

- **4 tools**: `search_apis` -> `get_tool_details` -> `call_api` (+ `list_categories`)
- **Schema enrichment**: `get_tool_details` returns the resolved JSON:API request
  body schema (`data.type`, `attributes`, `relationships` with target resource
  types), the response shape (single/collection + resource fields), and a
  ready-to-copy `_body` example - all derived from Apple's OpenAPI spec at
  generation time.
- **Shared catalog**: embeds the repo's generated `src/tools.json` at compile
  time (`include_str!`) - regenerate with `npm run generate` in the repo root
  and rebuild; no Rust-side step needed.
- **JWT**: ES256 (ECDSA P-256 + SHA-256), 20-minute TTL (Apple maximum),
  in-memory cache refreshed when <60s of life remains.
- **Transports**: stdio (newline-delimited JSON-RPC 2.0) and Streamable HTTP
  (`POST /mcp` JSON request/response, `DELETE /mcp` session termination,
  `GET /health`).

## Build

```bash
cd rust
cargo build --release
# binary: target/release/appstore-connect-mcp
```

Requires a stable Rust toolchain. Dependencies are kept on latest majors
(reqwest 0.13, jsonwebtoken 11, axum 0.8, tokio 1.x).

## Run

```bash
# Local (stdio) - for Claude Desktop, Cursor, etc.
export APP_STORE_CONNECT_ISSUER_ID=...
export APP_STORE_CONNECT_KEY_ID=...
export APP_STORE_CONNECT_PRIVATE_KEY="$(cat ~/AuthKey_XXXXXXXXXX.p8)"
./target/release/appstore-connect-mcp

# Remote (HTTP)
./target/release/appstore-connect-mcp --transport http --port 3000 --host 0.0.0.0
```

### Configuration (identical to the TypeScript server)

| Env var / CLI flag | Purpose |
|--------------------|---------|
| `APP_STORE_CONNECT_ISSUER_ID` / `--issuer-id` | Issuer ID from ASC -> Keys |
| `APP_STORE_CONNECT_KEY_ID` / `--key-id` | API key ID |
| `APP_STORE_CONNECT_PRIVATE_KEY` / (`--p8-file`, `APP_STORE_CONNECT_P8_FILE`) | PEM key content or .p8 path |
| `MCP_TRANSPORT` / `--transport` | `stdio` (default) or `http` |
| `MCP_PORT` / `--port` | HTTP port (default 3000) |
| `MCP_HOST` / `--host` | HTTP host (default 0.0.0.0) |
| `MCP_VERBOSE` / `--verbose` | Verbose stderr logging (tool-call names only) |

Legacy env aliases `ASC_PRIVATE_KEY` / `APPSTORE_CONNECT_PRIVATE_KEY` are honored.

## Differences from the TypeScript server

- `GET /mcp` (server-initiated SSE stream) responds **405** - this server has no
  server-initiated messages; the MCP Streamable HTTP spec permits 405. All
  client flows (initialize, tools/list, tools/call) work over plain POST.
- The MCP protocol layer is implemented directly (no SDK): JSON-RPC 2.0 with
  protocol-version echo on `initialize`.

## Docker

The image builds from the **repo root context** (the crate embeds `src/tools.json`):

```bash
docker build -f rust/Dockerfile -t appstore-connect-mcp-rust .
docker run -d -p 3000:3000 --env-file .env appstore-connect-mcp-rust
```

Or via compose (from repo root):

```bash
docker compose -f rust/docker-compose.yml up -d
```

CI publishes it on push/tag as `ghcr.io/topcheer/appstore-connect-mcp-rust`
(same tag scheme as the TypeScript image: `latest`, `main`, semver). Defaults
to HTTP transport in Docker (parity with the TS image), non-root user,
`/health` healthcheck baked into the image.

## Layout

```
rust/
├── Cargo.toml
└── src/
    ├── main.rs    # entry + CLI/env config (same names as TS version)
    ├── data.rs    # tools.json types + embedded catalog
    ├── tools.rs   # search / details / schema-derived example builders
    ├── auth.rs    # ES256 JWT + 20-min cache
    ├── client.rs  # ASC REST client (URL builder, error normalization)
    ├── mcp.rs     # JSON-RPC dispatch for the 4 tools + stdio loop
    ├── http.rs    # axum transport: POST/DELETE /mcp + /health
    └── types.rs   # Credentials / ServerConfig
```

## Tests

```bash
cargo test     # 21 unit tests: catalog load, search/details/example, JWT
               # sign+verify against fixtures, URL building, MCP dispatch
```

The JWT test signs with `tests/fixtures/test_key.pem` (a throwaway P-256 test
key, not a real credential) and verifies the token against its public key.
