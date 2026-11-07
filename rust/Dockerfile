# ─────────────────────────────────────────────────────────────────
# Dockerfile for the Rust port (rust/)
# Multi-stage build: compile static binary → ship minimal runtime
#
# NOTE: build context is the REPO ROOT (not rust/), because the crate
# embeds ../src/tools.json at compile time:
#   docker build -f rust/Dockerfile -t appstore-connect-mcp-rust .
# ─────────────────────────────────────────────────────────────────

# ── Stage 1: Build ───────────────────────────────────────────────
# Pin to bookworm to match the runtime stage (rust:1-slim now ships trixie glibc 2.41)
FROM rust:1-slim-bookworm AS builder

# build-essential (cc for aws-lc-rs), cmake + perl (aws-lc-sys build)
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential cmake perl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Manifest first for better cache behavior, then sources
COPY rust/Cargo.toml rust/Cargo.lock ./
COPY rust/src ./src
# The crate embeds the shared generated catalog via include_str!("../../src/tools.json")
COPY src/tools.json /src/tools.json

# BuildKit cache mounts keep the cargo registry/target across builds
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/build/target \
    cargo build --release --locked \
    && cp target/release/appstore-connect-mcp /usr/local/bin/

# ── Stage 2: Runtime ─────────────────────────────────────────────
FROM debian:bookworm-slim AS runtime

LABEL org.opencontainers.image.title="appstore-connect-mcp-rust" \
      org.opencontainers.image.description="Rust MCP server for Apple App Store Connect API (4 tools, 1216 operations)" \
      org.opencontainers.image.source="https://github.com/topcheer/appstore-connect-mcp" \
      org.opencontainers.image.licenses="MIT"

# Non-root runtime user
RUN groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --no-create-home app

COPY --from=builder /usr/local/bin/appstore-connect-mcp /usr/local/bin/appstore-connect-mcp

# Default to HTTP transport in Docker (parity with the TypeScript image)
ENV MCP_TRANSPORT=http \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=3000

USER app

EXPOSE 3000

# bash ships with bookworm-slim; /dev/tcp probe avoids installing curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD bash -c 'exec 3<>/dev/tcp/127.0.0.1/3000 && printf "GET /health HTTP/1.0\r\n\r\n" >&3 && grep -q "\"ok\"" <&3'

ENTRYPOINT ["appstore-connect-mcp"]
