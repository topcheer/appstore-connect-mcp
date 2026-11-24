#!/usr/bin/env bash
# install.sh -- install a prebuilt appstore-connect-mcp Rust binary
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/topcheer/appstore-connect-mcp/main/install.sh | bash
#   bash install.sh v1.1.0        # pin a specific version
#
# Installs to ~/.local/bin/appstore-connect-mcp (override with PREFIX).
set -euo pipefail

REPO="topcheer/appstore-connect-mcp"
VERSION="${1:-}"
PREFIX="${PREFIX:-$HOME/.local/bin}"

# --- detect platform -------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) os_asset="darwin" ;;
  Linux) os_asset="linux" ;;
  *) echo "Unsupported OS: $os (use 'cargo install --path rust' or the Docker image)" >&2; exit 1 ;;
esac
case "$arch" in
  arm64|aarch64) arch_asset="arm64" ;;
  x86_64) arch_asset="x86_64" ;;
  *) echo "Unsupported arch: $arch" >&2; exit 1 ;;
esac
# Linux builds are glibc-based (built on ubuntu-22.04)
if [ "$os_asset" = "linux" ] && ! command -v ldd >/dev/null 2>&1; then
  echo "Linux build requires glibc; musl/static builds are not provided yet." >&2
  exit 1
fi

ASSET="appstore-connect-mcp-${os_asset}-${arch_asset}"

# --- resolve version -------------------------------------------------
if [ -z "$VERSION" ]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')"
  [ -n "$VERSION" ] || { echo "Could not resolve latest release" >&2; exit 1; }
fi
echo "Installing $REPO $VERSION ($ASSET) -> $PREFIX"

# --- download & verify -----------------------------------------------
BASE="https://github.com/$REPO/releases/download/$VERSION"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

curl -fsSL "$BASE/$ASSET.tar.gz" -o "$TMP/$ASSET.tar.gz"
curl -fsSL "$BASE/$ASSET.tar.gz.sha256" -o "$TMP/$ASSET.tar.gz.sha256"
(
  cd "$TMP"
  # BSD shasum and GNU sha256sum both print "<hash>  <file>"
  echo "$(cut -d' ' -f1 "$ASSET.tar.gz.sha256")  $ASSET.tar.gz" | shasum -a 256 -c - >/dev/null
)
echo "Checksum OK"

# --- install ---------------------------------------------------------
mkdir -p "$PREFIX"
tar xzf "$TMP/$ASSET.tar.gz" -C "$TMP"
mv "$TMP/appstore-connect-mcp" "$PREFIX/appstore-connect-mcp"
chmod +x "$PREFIX/appstore-connect-mcp"

# macOS: ad-hoc re-sign, else Gatekeeper kills the binary with SIGKILL (exit 137)
if [ "$os_asset" = "darwin" ]; then
  codesign --force --sign - "$PREFIX/appstore-connect-mcp" 2>/dev/null || true
fi

# --- verify ----------------------------------------------------------
"$PREFIX/appstore-connect-mcp" --help >/dev/null 2>&1 || true

cat <<EOF

Installed: $PREFIX/appstore-connect-mcp

Configure your MCP client (stdio):
  command: $PREFIX/appstore-connect-mcp
  env:
    APP_STORE_CONNECT_ISSUER_ID: <uuid>
    APP_STORE_CONNECT_KEY_ID: <key id>
    APP_STORE_CONNECT_P8_FILE: /path/to/AuthKey_<key id>.p8

Make sure $PREFIX is on your PATH:  export PATH="$PREFIX:\$PATH"
EOF
