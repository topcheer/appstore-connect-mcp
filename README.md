# App Store Connect MCP

A [Model Context Protocol](https://modelcontextprotocol.io/) server that exposes the entire **Apple App Store Connect API** (1,200+ operations) as MCP tools. Query apps, manage builds, handle submissions, read analytics, manage users, and more — all from your AI assistant.

[![npm version](https://img.shields.io/npm/v/@ggaiteam/appstore-connect-mcp.svg)](https://www.npmjs.com/package/@ggaiteam/appstore-connect-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)

## Features

- **Complete API coverage** — all 1,216 operations from the App Store Connect API v4.4
- **Tool search** — `search_apis` meta-tool to find the right operation among 1,200+
- **Two transports** — `stdio` for local use (Claude Desktop, Cursor), `HTTP` for remote deployment
- **JWT authentication** — automatic ES256 token generation and caching
- **Docker ready** — multi-stage Dockerfile with health checks
- **Auto-publish** — GitHub Actions workflow for npm publishing on release

## Quick Start

### 1. Get API Credentials

1. Go to [App Store Connect → Users and Access → Keys](https://appstoreconnect.apple.com/access/api)
2. Click **Generate API Key** (or use an existing one)
3. Note down:
   - **Issuer ID** — shown at the top of the Keys page
   - **Key ID** — shown in the key list
   - **Private Key (.p8 file)** — download it (only available once)

> The key needs at least **App Manager** or **Admin** role for full functionality.

### 2. Install

#### Option A: npm (recommended)

```bash
npm install -g @ggaiteam/appstore-connect-mcp
```

#### Option B: One-line installer

```bash
curl -fsSL https://raw.githubusercontent.com/topcheer/appstore-connect-mcp/main/scripts/install.sh | bash
```

#### Option C: Docker

```bash
docker pull ghcr.io/topcheer/appstore-connect-mcp:latest
```

### 3. Configure Your MCP Client

#### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "appstore-connect": {
      "command": "appstore-connect-mcp",
      "env": {
        "APP_STORE_CONNECT_ISSUER_ID": "your-issuer-id",
        "APP_STORE_CONNECT_KEY_ID": "your-key-id",
        "APP_STORE_CONNECT_P8_FILE": "/path/to/AuthKey_XXXXXXXXXX.p8"
      }
    }
  }
}
```

#### Cursor

Add to your Cursor MCP settings:

```json
{
  "mcpServers": {
    "appstore-connect": {
      "command": "npx",
      "args": ["@ggaiteam/appstore-connect-mcp"],
      "env": {
        "APP_STORE_CONNECT_ISSUER_ID": "your-issuer-id",
        "APP_STORE_CONNECT_KEY_ID": "your-key-id",
        "APP_STORE_CONNECT_P8_FILE": "/path/to/AuthKey_XXXXXXXXXX.p8"
      }
    }
  }
}
```

> **Alternatively**, inline the private key instead of a file path:
> ```json
> "APP_STORE_CONNECT_PRIVATE_KEY": "-----BEGIN PRIVATE KEY-----\nMIGTAg...\n-----END PRIVATE KEY-----"
> ```

Restart your client. You should now have access to all App Store Connect API tools.

## Usage Examples

Once connected, ask your AI assistant:

> "List all my apps on App Store Connect"

> "Show me the latest build for bundle ID com.example.myapp"

> "Get all pending app review submissions"

> "Search for subscription-related API operations"

The AI uses the `search_apis` meta-tool to discover available operations, then calls them.

### Meta-Tools

| Tool | Description |
|------|-------------|
| `search_apis` | Search API operations by keyword, category, or HTTP method |
| `list_categories` | List all 192 API resource categories |
| `get_tool_details` | Get full parameter details for a specific operation |

### Example Tool Calls

The AI can call tools like:
- `apps_getCollection` — list all apps
- `builds_getCollection` — list builds with filters
- `appStoreVersions_getCollection` — get app versions
- `betaTesters_getCollection` — list beta testers
- `salesReports_getCollection` — download sales reports
- `userInvitations_createInstance` — invite a new team member

## Remote Deployment (HTTP Mode)

### Docker Compose

```bash
# 1. Create .env file
cp .env.example .env
# Edit .env with your credentials

# 2. Start
docker compose up -d
```

The server is available at `http://localhost:3000/mcp`.

### Docker (manual)

```bash
docker run -d \
  --name appstore-connect-mcp \
  -p 3000:3000 \
  -e APP_STORE_CONNECT_ISSUER_ID=your-issuer-id \
  -e APP_STORE_CONNECT_KEY_ID=your-key-id \
  -e APP_STORE_CONNECT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----" \
  ghcr.io/topcheer/appstore-connect-mcp:latest
```

### Health Check

```bash
curl http://localhost:3000/health
# {"status":"ok","server":"appstore-connect-mcp","version":"1.0.0"}
```

### Connect Remote MCP to Claude Desktop

```json
{
  "mcpServers": {
    "appstore-connect": {
      "url": "http://your-server:3000/mcp"
    }
  }
}
```

## CLI Usage

```bash
# Stdio mode (default — for local MCP clients)
appstore-connect-mcp

# HTTP mode (for remote deployment)
appstore-connect-mcp --transport http --port 3000 --host 0.0.0.0

# With verbose logging
appstore-connect-mcp --verbose
```

### CLI Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--transport` | `stdio` | Transport mode: `stdio` or `http` |
| `--port` | `3000` | HTTP port (HTTP mode only) |
| `--host` | `0.0.0.0` | HTTP bind host |
| `--issuer-id` | env | App Store Connect issuer ID |
| `--key-id` | env | API key ID |
| `--p8-file` | env | Path to .p8 private key file |
| `--verbose` | off | Enable verbose logging |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `APP_STORE_CONNECT_ISSUER_ID` | Issuer ID from App Store Connect |
| `APP_STORE_CONNECT_KEY_ID` | Key ID |
| `APP_STORE_CONNECT_PRIVATE_KEY` | PEM private key content (inline) |
| `APP_STORE_CONNECT_P8_FILE` | Path to .p8 file (alternative to above) |
| `MCP_TRANSPORT` | `stdio` or `http` |
| `MCP_PORT` | HTTP port |
| `MCP_HOST` | HTTP host |
| `MCP_VERBOSE` | `1` to enable verbose logging |

## Architecture

```
┌──────────────────┐     ┌──────────────────┐
│  MCP Client      │     │  MCP Server      │
│  (Claude, etc.)  │◄───►│                  │
└──────────────────┘     │  ┌────────────┐  │     ┌─────────────────┐
                         │  │ Tool       │  │     │ App Store       │
   stdio or HTTP/SSE     │  │ Registry   │──┼────►│ Connect API     │
                         │  │ (1,216     │  │     │ api.appstore    │
                         │  │  tools)    │  │     │ connect.apple   │
                         │  └────────────┘  │     │ .com            │
                         │       │          │     └─────────────────┘
                         │  ┌────▼─────┐    │            ▲
                         │  │ JWT Auth │    │            │
                         │  │ (ES256)  │────┼────────────┘
                         │  └──────────┘    │
                         └──────────────────┘
```

- **Tool data** is generated from Apple's OpenAPI spec (`scripts/generate-tools.py`)
- **Runtime** loads `tools.json` and registers all tools dynamically
- **JWT tokens** are cached and auto-refreshed (20-minute TTL)
- **Responses** are truncated at 50KB to fit LLM context windows

### Regenerating Tools

When Apple updates their API:

```bash
# Download the latest OpenAPI spec
# https://developer.apple.com/app-store-connect/

# Generate updated tools.json
python3 scripts/generate-tools.py openapi.oas.json src/tools.json

# Rebuild
npm run build
```

## Development

```bash
# Clone
git clone https://github.com/topcheer/appstore-connect-mcp.git
cd appstore-connect-mcp

# Install
npm install

# Generate tools from OpenAPI spec
npm run generate

# Build
npm run build

# Run locally
APP_STORE_CONNECT_ISSUER_ID=... \
APP_STORE_CONNECT_KEY_ID=... \
APP_STORE_CONNECT_P8_FILE=... \
npm start
```

### Project Structure

```
├── scripts/
│   ├── generate-tools.py     # OpenAPI → tools.json generator
│   └── install.sh            # One-line installer
├── src/
│   ├── index.ts              # Entry point + CLI
│   ├── server.ts             # MCP server (tool registry + dispatch)
│   ├── transport.ts          # stdio + HTTP transports
│   ├── auth.ts               # JWT (ES256) token generation
│   ├── client.ts             # App Store Connect API client
│   ├── tools.ts              # Tool schema builder + executor
│   ├── types.ts              # TypeScript type definitions
│   └── tools.json            # Generated tool definitions (1,216 ops)
├── Dockerfile                # Multi-stage Docker build
├── docker-compose.yml        # Remote deployment config
├── .github/workflows/
│   ├── ci.yml                # Lint + build + test
│   ├── npm-publish.yml       # Auto-publish to npm on release
│   └── docker.yml            # Build + push Docker image
└── package.json
```

## npm Publishing

Publishing is automated via GitHub Actions:

1. **Create a release** on GitHub (tag format: `v1.0.0`)
2. The `npm-publish.yml` workflow automatically:
   - Builds the package
   - Publishes to npm
   - With [provenance](https://docs.npmjs.com/generating-provenance-statements)

### First-time Setup

1. Create an npm access token: https://www.npmjs.com/settings/~/tokens
2. Add it as a repository secret: `NPM_TOKEN`
3. Create a GitHub release — done!

### Manual Publishing

```bash
npm version patch  # or minor/major
npm run build
npm publish
```

## API Coverage

This server covers **all 1,216 operations** across the App Store Connect API:

| Method | Count |
|--------|-------|
| GET    | 768   |
| POST   | 168   |
| PATCH  | 153   |
| DELETE | 127   |

Including: Apps, Builds, App Store Versions, Beta Testing, Subscriptions, In-App Purchases, User Management, Sales Reports, Analytics, App Clips, Game Center, and more (192 categories total).

## Security

- Private keys are read from environment variables or files — never logged
- JWT tokens are short-lived (20 minutes max) and cached in memory only
- No data is stored or persisted between requests
- For remote deployment, use HTTPS/TLS termination at your reverse proxy

## License

MIT — see [LICENSE](LICENSE)

## Acknowledgments

- [Apple App Store Connect API](https://developer.apple.com/app-store-connect/) — API and OpenAPI specification
- [Model Context Protocol](https://modelcontextprotocol.io/) — Protocol specification
