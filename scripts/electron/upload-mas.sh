#!/usr/bin/env bash
# Upload a signed Mac App Store .pkg to App Store Connect.
# Requires an existing App Store Connect app record for the bundle ID.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PKG="${1:-$ROOT_DIR/release-mas/mas-arm64/My-macOS-0.1.0-arm64.pkg}"
KEY_ID="${ASC_KEY_ID:-6J4GWL5B22}"
ISSUER_ID="${ASC_ISSUER_ID:-e2009713-f7ae-4256-8245-a783e7917488}"

xcrun altool --upload-app -f "$PKG" -t macos --apiKey "$KEY_ID" --apiIssuer "$ISSUER_ID"
