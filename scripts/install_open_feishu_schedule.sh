#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST_SRC="$REPO_DIR/launchd/com.device-operate.open-feishu.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.device-operate.open-feishu.plist"

if [[ ! -f "$PLIST_SRC" ]]; then
  echo "Missing plist template: $PLIST_SRC" >&2
  exit 1
fi

chmod +x "$REPO_DIR/scripts/open_feishu_android.sh"
mkdir -p "$HOME/Library/LaunchAgents"

sed "s#__REPO_DIR__#$REPO_DIR#g" "$PLIST_SRC" > "$PLIST_DST"

launchctl unload "$PLIST_DST" >/dev/null 2>&1 || true
launchctl load "$PLIST_DST"

echo "Installed daily 09:00 and 18:30 Feishu launcher:"
echo "$PLIST_DST"
echo
echo "Test now with:"
echo "$REPO_DIR/scripts/open_feishu_android.sh"
echo
echo "View logs with:"
echo "tail -f \"$HOME/Library/Logs/device-operate/open-feishu.log\""
