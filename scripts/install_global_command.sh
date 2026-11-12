#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$HOME/.local/bin"
COMMAND_PATH="$BIN_DIR/open-feishu-android"

mkdir -p "$BIN_DIR"
chmod +x "$REPO_DIR/scripts/open_feishu_android.sh"

cat > "$COMMAND_PATH" <<EOF
#!/usr/bin/env bash
exec "$REPO_DIR/scripts/open_feishu_android.sh" "\$@"
EOF

chmod +x "$COMMAND_PATH"

echo "Installed global command:"
echo "$COMMAND_PATH"
echo
echo "Try:"
echo "open-feishu-android --no-random"
