#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUILDER_BIN="$ROOT_DIR/node_modules/app-builder-bin/mac/app-builder_arm64"

# macOS can leave provenance metadata on an older native binary in a state
# where dyld blocks before the process starts. Replacing the inode refreshes it.
if [[ -x "$APP_BUILDER_BIN" ]] && command -v ditto >/dev/null 2>&1; then
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  ditto --norsrc "$APP_BUILDER_BIN" "$TMP_DIR/app-builder_arm64"
  ditto --norsrc "$TMP_DIR/app-builder_arm64" "$APP_BUILDER_BIN"
fi

exec node "$ROOT_DIR/node_modules/electron-builder/out/cli/cli.js" "$@"
