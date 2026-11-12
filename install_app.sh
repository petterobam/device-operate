#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="我的macOS"
OLD_APP_NAME="系统任务"
APP_BUNDLE="$APP_NAME.app"
APPLICATIONS_DIR="/Applications"
TARGET_APP="$APPLICATIONS_DIR/$APP_BUNDLE"

cd "$ROOT_DIR"

export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export CSC_IDENTITY_AUTO_DISCOVERY=false

echo "==> Installing dependencies"
npm install

echo "==> Preparing Claude Agent SDK venv"
AGENT_VENV="$HOME/.config/device-operate/agent-venv"
mkdir -p "$(dirname "$AGENT_VENV")"
if [[ ! -x "$AGENT_VENV/bin/python" ]]; then
  python3 -m venv "$AGENT_VENV"
fi
if find "$AGENT_VENV/lib" -type d -path "*/site-packages/claude_agent_sdk" -print -quit | grep -q .; then
  echo "Claude Agent SDK already available"
else
  "$AGENT_VENV/bin/python" -m pip install --disable-pip-version-check 'claude-agent-sdk>=0.1.59'
fi

echo "==> Building web assets"
npm run build

echo "==> Generating app icon"
bash scripts/generate_icon.sh

echo "==> Packaging macOS app"
npm run package:mac

SOURCE_APP=""
for candidate in \
  "$ROOT_DIR/release/mac-arm64/$APP_BUNDLE" \
  "$ROOT_DIR/release/mac/$APP_BUNDLE" \
  "$ROOT_DIR/release/mac-universal/$APP_BUNDLE"; do
  if [[ -d "$candidate" ]]; then
    SOURCE_APP="$candidate"
    break
  fi
done

if [[ -z "$SOURCE_APP" ]]; then
  echo "Could not find packaged app under $ROOT_DIR/release" >&2
  exit 1
fi

SIGNING_IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null | awk -F '"' '/Developer ID Application:/{print $2; exit}')"
ENTITLEMENTS="$ROOT_DIR/node_modules/app-builder-lib/templates/entitlements.mac.plist"

sign_app() {
  local app_path="$1"
  if [[ -n "$SIGNING_IDENTITY" && -f "$ENTITLEMENTS" ]]; then
    echo "==> Signing packaged app with $SIGNING_IDENTITY"
    codesign --deep --force --timestamp --options runtime \
      --entitlements "$ENTITLEMENTS" --sign "$SIGNING_IDENTITY" "$app_path"
  else
    echo "==> Signing packaged app (ad-hoc)"
    codesign --deep --force --sign - "$app_path"
  fi
  codesign --verify --deep --strict --verbose=2 "$app_path" >/dev/null
}

sign_app "$SOURCE_APP"

LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

echo "==> Closing any running $APP_NAME app"
osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1 || true
osascript -e "tell application \"$OLD_APP_NAME\" to quit" >/dev/null 2>&1 || true
pkill -TERM -f "$TARGET_APP/Contents/MacOS/$APP_NAME" >/dev/null 2>&1 || true
sleep 1
pkill -KILL -f "$TARGET_APP/Contents/MacOS/$APP_NAME" >/dev/null 2>&1 || true
pkill -f "$APPLICATIONS_DIR/$OLD_APP_NAME.app/Contents/MacOS/$OLD_APP_NAME" >/dev/null 2>&1 || true

if [[ -x "$LSREGISTER" ]]; then
  "$LSREGISTER" -u "$TARGET_APP" >/dev/null 2>&1 || true
fi

echo "==> Replacing $TARGET_APP"
rm -rf "$TARGET_APP"
ditto --norsrc "$SOURCE_APP" "$TARGET_APP"
codesign --verify --deep --strict --verbose=2 "$TARGET_APP" >/dev/null
if [[ -d "$APPLICATIONS_DIR/$OLD_APP_NAME.app" ]]; then
  echo "==> Removing old app $APPLICATIONS_DIR/$OLD_APP_NAME.app"
  rm -rf "$APPLICATIONS_DIR/$OLD_APP_NAME.app"
fi

if [[ -x "$LSREGISTER" ]]; then
  "$LSREGISTER" -f "$TARGET_APP" >/dev/null 2>&1 || true
fi

echo "==> Starting $APP_NAME"
open "$TARGET_APP"
sleep 2
if ! pgrep -f "$TARGET_APP/Contents/MacOS/$APP_NAME" >/dev/null 2>&1; then
  echo "Warning: macOS did not keep $APP_NAME running. A restart may be required if syspolicyd reports file descriptor exhaustion." >&2
fi

echo "Installed and launched:"
echo "$TARGET_APP"
