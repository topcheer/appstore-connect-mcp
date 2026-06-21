# ─────────────────────────────────────────────────────────────────
# Dockerfile for appstore-connect-mcp
# Multi-stage build: build TypeScript → ship minimal runtime image
# ─────────────────────────────────────────────────────────────────

# ── Stage 1: Build ───────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

# Copy package files and install ALL deps (including devDeps for tsc)
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Prune dev dependencies for the runtime image
RUN npm prune --production

# ── Stage 2: Runtime ─────────────────────────────────────────────
FROM node:20-slim AS runtime

LABEL org.opencontainers.image.title="appstore-connect-mcp" \
      org.opencontainers.image.description="MCP server for Apple App Store Connect API" \
      org.opencontainers.image.source="https://github.com/topcheer/appstore-connect-mcp" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Copy built dist (includes tools.json) and production node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Default to HTTP transport in Docker
ENV MCP_TRANSPORT=http
ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{process.exit(r.ok?0:1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
