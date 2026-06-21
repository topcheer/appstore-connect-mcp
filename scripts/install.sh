#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# install.sh — Install appstore-connect-mcp globally via npm
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/topcheer/appstore-connect-mcp/main/scripts/install.sh | bash
#
# Or clone and run locally:
#   ./scripts/install.sh
#
# After installation, configure your MCP client (Claude Desktop, etc.)
# with your App Store Connect credentials.
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
NC='\033[0m'

info()  { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}!${NC} $1"; }
error() { echo -e "${RED}✗${NC} $1"; }

echo -e "${BOLD}=== App Store Connect MCP — Installer ===${NC}"
echo ""

# ── Check Node.js ────────────────────────────────────────────────
if ! command -v node &>/dev/null; then
  error "Node.js is not installed."
  echo ""
  echo "Install Node.js 18+ from https://nodejs.org/"
  echo "Or use a version manager:"
  echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash"
  echo "  nvm install --lts"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  error "Node.js 18+ required (you have $(node -v))."
  exit 1
fi
info "Node.js $(node -v) detected"

# ── Install the package ──────────────────────────────────────────
echo ""
echo "Installing appstore-connect-mcp globally..."
if npm install -g appstore-connect-mcp 2>/dev/null; then
  info "Installed via npm registry"
else
  warn "npm registry install failed, building from source..."
  
  # Clone and build from source
  TMPDIR_INSTALL=$(mktemp -d)
  git clone --depth 1 https://github.com/topcheer/appstore-connect-mcp.git "$TMPDIR_INSTALL/appstore-connect-mcp"
  cd "$TMPDIR_INSTALL/appstore-connect-mcp"
  npm install
  npm run build
  npm install -g .
  cd - >/dev/null
  rm -rf "$TMPDIR_INSTALL"
  info "Installed from source"
fi

# ── Verify installation ──────────────────────────────────────────
if ! command -v appstore-connect-mcp &>/dev/null; then
  error "Installation verification failed — 'appstore-connect-mcp' not in PATH."
  echo "Try: npm install -g appstore-connect-mcp"
  exit 1
fi
info "appstore-connect-mcp is available"

# ── Collect credentials ──────────────────────────────────────────
echo ""
echo -e "${BOLD}=== Configure App Store Connect API Credentials ===${NC}"
echo ""
echo "You need an App Store Connect API key. Get one at:"
echo "  https://appstoreconnect.apple.com/access/api"
echo ""
echo "Required:"
echo "  1. Issuer ID    (shown at top of the Keys page)"
echo "  2. Key ID       (shown after creating a key)"
echo "  3. Private Key   (.p8 file downloaded when creating the key)"
echo ""

read -rp "Issuer ID: " ISSUER_ID </dev/tty 2>/dev/null || true
read -rp "Key ID: " KEY_ID </dev/tty 2>/dev/null || true
read -rp "Path to .p8 private key file: " P8_PATH </dev/tty 2>/dev/null || true

if [ -z "$ISSUER_ID" ] || [ -z "$KEY_ID" ] || [ -z "$P8_PATH" ]; then
  warn "Skipping credential setup. You can configure manually later."
  echo ""
  echo "Set these environment variables or MCP client config:"
  echo "  APP_STORE_CONNECT_ISSUER_ID=<issuer-id>"
  echo "  APP_STORE_CONNECT_KEY_ID=<key-id>"
  echo "  APP_STORE_CONNECT_P8_FILE=/path/to/AuthKey_XXXXXXXXXX.p8"
  echo ""
  exit 0
fi

if [ ! -f "$P8_PATH" ]; then
  error "File not found: $P8_PATH"
  exit 1
fi

PRIVATE_KEY=$(cat "$P8_PATH")

# ── Generate MCP client configs ──────────────────────────────────
echo ""
echo -e "${BOLD}=== MCP Client Configuration ===${NC}"
echo ""

# Claude Desktop config
CLAUDE_CONFIG_DIR="$HOME/Library/Application Support/Claude"
CLAUDE_CONFIG="$CLAUDE_CONFIG_DIR/claude_desktop_config.json"

echo "For ${BOLD}Claude Desktop${NC}, add this to your config"
echo "(${CLAUDE_CONFIG}):"
echo ""
cat << 'HEREDOC' | sed \
  -e "s|__ISSUER_ID__|$ISSUER_ID|g" \
  -e "s|__KEY_ID__|$KEY_ID|g" \
  -e "s|__P8_FILE__|$P8_PATH|g"
{
  "mcpServers": {
    "appstore-connect": {
      "command": "appstore-connect-mcp",
      "env": {
        "APP_STORE_CONNECT_ISSUER_ID": "__ISSUER_ID__",
        "APP_STORE_CONNECT_KEY_ID": "__KEY_ID__",
        "APP_STORE_CONNECT_P8_FILE": "__P8_FILE__"
      }
    }
  }
}
HEREDOC
echo ""

# Cursor config
echo "For ${BOLD}Cursor${NC}, add this to your MCP settings:"
echo ""
cat << 'HEREDOC' | sed \
  -e "s|__ISSUER_ID__|$ISSUER_ID|g" \
  -e "s|__KEY_ID__|$KEY_ID|g" \
  -e "s|__P8_FILE__|$P8_PATH|g"
{
  "mcpServers": {
    "appstore-connect": {
      "command": "appstore-connect-mcp",
      "env": {
        "APP_STORE_CONNECT_ISSUER_ID": "__ISSUER_ID__",
        "APP_STORE_CONNECT_KEY_ID": "__KEY_ID__",
        "APP_STORE_CONNECT_P8_FILE": "__P8_FILE__"
      }
    }
  }
}
HEREDOC
echo ""

echo -e "${GREEN}${BOLD}=== Installation Complete ===${NC}"
echo ""
echo "Restart your MCP client to pick up the new server."
echo ""
echo "Verify it works:"
echo "  appstore-connect-mcp --help"
echo ""
