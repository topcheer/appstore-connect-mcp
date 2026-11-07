# GGCODE.md

> Project memory for `@ggaiteam/appstore-connect-mcp`. Edit when architecture, tooling, or conventions change.

## What this project is

A [Model Context Protocol](https://modelcontextprotocol.io/) server that exposes the entire **Apple App Store Connect API** (1,216 operations) via only **4 MCP tools**. Query apps, manage builds, handle submissions, read analytics, manage users, and more — all from an AI assistant.

- **Package**: `@ggaiteam/appstore-connect-mcp` (npm, scoped, public)
- **Repo**: `topcheer/appstore-connect-mcp` on GitHub
- **License**: MIT
- **Node**: `>=18.0.0` (CI uses Node 20/24; Docker runtime uses node:20-slim)
- **Language**: TypeScript (ESM, `target`/`module` `ES2022`, `moduleResolution: bundler`, `strict: true`)

### Why only 4 tools?

Registering 1,216 tools would consume ~140K tokens of LLM context. Instead, the LLM uses a discovery workflow:
`search_apis` → `get_tool_details` → `call_api` (+ `list_categories`). Full API coverage with tiny context.

## Architecture

```
src/
├── index.ts       # Entry point + CLI arg parsing + config loading
├── server.ts      # MCP Server (low-level SDK Server class) — registers exactly 4 tools
├── tools.ts       # Loads tools.json, builds JSON schemas, dispatches call_api → client
├── client.ts      # HTTP client for api.appstoreconnect.apple.com (JWT auth, JSON:API)
├── auth.ts        # ES256 JWT generation + 20-min in-memory token cache
├── transport.ts   # StdioServerTransport (local) + StreamableHTTPServerTransport (remote)
├── types.ts       # Shared interfaces (ToolDef, ToolsData, ASCCredentials, ServerConfig)
└── tools.json     # GENERATED — 1,216 operations + deduped bodySchemas/resourceSchemas from Apple's spec
```

### Data flow (data-driven design)

1. **Generate** (offline): `scripts/generate-tools.py` reads Apple's `openapi.oas.json` → emits `src/tools.json`.
2. **Build**: `tsc` compiles `src/*.ts` → `dist/`; a separate step copies `tools.json` to `dist/` (tsc does not copy non-imported JSON).
3. **Runtime**: `loadTools()` reads `dist/tools.json` once at startup; `server.ts` registers 4 MCP tools; `call_api` dispatches via `executeTool` → `callApi`.

### Key implementation details

- **MCP SDK**: `@modelcontextprotocol/sdk` (package.json declares `^1.12.1`, lock file resolves to **1.29.0**) — uses the **low-level `Server` class** (not `McpServer`), with `ListToolsRequestSchema` / `CallToolRequestSchema` request handlers. Always use the latest version (`npm install @modelcontextprotocol/sdk@latest`).
- **Path params are at PATH-ITEM level** in Apple's OpenAPI spec (not operation level) — `generate-tools.py` merges path-level + operation-level params per location (`merge_params`).
- **Summaries are derived** from `operationId` suffix patterns (`getCollection` → "List Xs", `createInstance` → "Create X", etc.) in `derive_summary()` because the spec lacks them.
- **JWT**: ES256 via `jsonwebtoken`, 20-min TTL (Apple max), cached in memory, refreshed when <60s life remains.
- **HTTP transport**: each session needs its own `Server` instance (SDK `Server` supports only one transport). `index.ts` passes a `createServer` factory; `transport.ts` stores sessions in a `Map` keyed by `mcp-session-id`. Endpoints: `POST /mcp` (initialize + requests), `GET /mcp` (SSE stream), `DELETE /mcp` (terminate), `GET /health`.
- **HTTP client gotcha**: MCP clients connecting to `/mcp` must send `Accept: application/json, text/event-stream` — the SDK's `StreamableHTTPServerTransport` rejects requests without it. This is a consumer requirement, not something our code enforces.
- **Response truncation**: `call_api` results are capped at 25KB to protect LLM context (`MAX = 25000` in `server.ts`).
- **Request/response schemas**: `tools.json` carries `bodySchemas` (deduped by Apple spec schema name) and `resourceSchemas` (deduped resource payloads). `get_tool_details` joins `bodySchemaRef` / `responseSchema.resourceRef` against these maps so the LLM gets the exact JSON:API body structure (attributes, relationships with target resource types) and the response shape (`data[]` fields, `included` types). The generator resolves `$ref`s (JSON:API-aware extractor in `generate-tools.py`); props/params are capped at 40 properties / 40 enum values, param descriptions at 500 chars, and the payload is emitted as compact JSON.
- **`_body` examples are schema-derived**: `buildExample()` in `server.ts` generates realistic examples from the resolved body schema (real `data.type`, attribute names, relationship targets) instead of a generic `{type: "resourceType"}` stub.
- **JSON:API convention**: POST/PATCH bodies go under the `_body` key in tool arguments; path params are top-level keys; query params (including bracketed ones like `filter[app]`) are top-level keys.

## Build & validation commands

```bash
npm run build        # tsc + copy tools.json to dist/
npm run typecheck    # tsc --noEmit (type-check only, no emit)
npm run lint         # eslint src/ --ext .ts
npm run dev          # tsc --watch
npm run generate     # python3 scripts/generate-tools.py → src/tools.json (regenerate from spec)
npm start            # node dist/index.js (stdio by default)
npm run start:http   # node dist/index.js --transport http
```

CI (`ci.yml`) runs: `npm ci` → `typecheck` → `build` → verify `dist/tools.json` exists and has 1000+ tools → `docker build` smoke test. **Always run `npm run typecheck` and `npm run build` before committing.**

## Regenerating tools.json

When Apple updates their API spec:

```bash
# Replace openapi.oas.json with the latest spec from Apple
python3 scripts/generate-tools.py openapi.oas.json src/tools.json
npm run build
git add src/tools.json
```

The generator (`scripts/generate-tools.py`) is pure-Python stdlib (no deps). It: slugifies operationIds, merges path/operation params, derives summaries from operationId suffixes, simplifies schemas, sorts tools by (category, name), and writes compact JSON (no whitespace).

## Environment variables & credentials

Required at runtime:

| Variable | Purpose |
|----------|---------|
| `APP_STORE_CONNECT_ISSUER_ID` | Issuer ID from App Store Connect → Keys |
| `APP_STORE_CONNECT_KEY_ID` | API Key ID |
| `APP_STORE_CONNECT_PRIVATE_KEY` | PEM private key content (inline) |
| `APP_STORE_CONNECT_P8_FILE` | Path to .p8 file (alternative to the inline key) |

Optional: `MCP_TRANSPORT` (`stdio`\|`http`), `MCP_PORT` (default 3000), `MCP_HOST` (default 0.0.0.0), `MCP_VERBOSE` (`1`). Legacy aliases: `ASC_PRIVATE_KEY`, `APPSTORE_CONNECT_PRIVATE_KEY`.

CLI flags mirror these (`--transport`, `--port`, `--host`, `--issuer-id`, `--key-id`, `--p8-file`, `--verbose`). Never commit `.p8` files, `.env`, or key material.

## Deployment

- **Docker**: multi-stage Dockerfile (node:20-slim), defaults to `MCP_TRANSPORT=http`, exposes 3000, has a health check at `/health`.
- **docker-compose.yml**: reads `.env` for credentials, same HTTP defaults.
- **Registry**: `ghcr.io/topcheer/appstore-connect-mcp` (GitHub Container Registry), published by `docker.yml`.
- **npm publish contents**: controlled by `package.json` `files` whitelist (`dist`, `README.md`, `LICENSE`). The `.npmignore` further excludes `src/`, `scripts/`, `openapi.oas.json`, `.github/`. Only `dist/` ships.

## Release & npm publish

Fully automated via GitHub Actions **OIDC trusted publishing** (no `NPM_TOKEN`):

```bash
git tag v1.2.3
git push origin v1.2.3
```

`npm-publish.yml` then: extracts version from tag → checks if version exists on npm → `npm ci` → `npm run build` → verifies `dist/tools.json` → `npm publish --access public --provenance=false` → creates GitHub Release.

**Important publish rules (verified):**
- Must use `--provenance=false` (NOT `--provenance=true`) — `--provenance=true` causes E404 for scoped `@ggaiteam/*` packages.
- Version is read from the git tag; no manual `package.json` bump needed (workflow syncs it).
- Package must already exist on npm — the first publish is manual via `npm publish --access public`.
- Always check whether the version already exists on npm before publishing (the workflow does this).
- `npm view <pkg>@<ver>` may return 404 due to CDN caching even after a successful publish — verify via `curl https://registry.npmjs.org/@ggaiteam%2Fappstore-connect-mcp` instead.
- **Release staging**: when committing a release, use `git add -A` to stage ALL changes (not just version files) — the CI build needs the complete working tree. See global rule `release-must-full-stage`.

## Conventions for agents working in this repo

- **Always read before editing** — source files are small and interdependent.
- **Do not edit `src/tools.json` by hand** — it is auto-generated; regenerate from the OpenAPI spec instead.
- **Do not hand-write summaries** — they are derived in `generate-tools.py` via `derive_summary()`.
- **After touching `src/*.ts`**, run `npm run typecheck` then `npm run build`; confirm `dist/tools.json` is present.
- **Keep only 4 MCP tools registered** — the 4-tool design is the core value proposition; never expand to per-operation registration.
- **ESM project**: use `.js` extensions in relative imports (e.g. `import { x } from "./server.js"`), and `node:` prefixes for built-ins.
- **No test framework is configured** — validation is via `typecheck`, `build`, and the CI build-output assertions.
- **Secrets**: never log private keys or JWT tokens. The `--verbose` flag logs tool-call names only.
