#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SVG_PATH="$ROOT_DIR/build/icon.svg"
ICONSET_DIR="$ROOT_DIR/build/icon.iconset"
ICNS_PATH="$ROOT_DIR/build/icon.icns"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

if [[ ! -f "$SVG_PATH" ]]; then
  echo "Missing SVG icon: $SVG_PATH" >&2
  exit 1
fi

rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"

if ! command -v magick >/dev/null 2>&1; then
  echo "ImageMagick is required to preserve the icon's transparent corners." >&2
  echo "Install it with: brew install imagemagick" >&2
  exit 1
fi

RAW_PNG="$TMP_DIR/$(basename "$SVG_PATH").png"
MASK_PNG="$TMP_DIR/icon-mask.png"
BASE_PNG="$TMP_DIR/icon.png"

qlmanage -t -s 1024 -o "$TMP_DIR" "$SVG_PATH" >/dev/null 2>&1

if [[ ! -f "$RAW_PNG" ]]; then
  echo "Failed to render SVG icon with qlmanage" >&2
  exit 1
fi

# Quick Look flattens SVG thumbnails onto white. Restore the alpha channel using
# the same rounded rectangle as the icon's outer background in icon.svg.
magick -size 1024x1024 xc:none \
  -fill white -draw "roundrectangle 72,72 951,951 220,220" \
  "$MASK_PNG"
magick "$RAW_PNG" "$MASK_PNG" \
  -alpha off -compose CopyOpacity -composite \
  "$BASE_PNG"

if [[ ! -f "$BASE_PNG" ]]; then
  echo "Failed to apply the transparent icon mask" >&2
  exit 1
fi

for corner in "+0+0" "+1023+0" "+0+1023" "+1023+1023"; do
  alpha="$(magick "$BASE_PNG" -crop "1x1${corner}" +repage -format "%[fx:a]" info:)"
  if [[ "$alpha" != "0" ]]; then
    echo "Icon corner ${corner} is not transparent (alpha=${alpha})" >&2
    exit 1
  fi
done

sips -z 16 16 "$BASE_PNG" --out "$ICONSET_DIR/icon_16x16.png" >/dev/null
sips -z 32 32 "$BASE_PNG" --out "$ICONSET_DIR/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$BASE_PNG" --out "$ICONSET_DIR/icon_32x32.png" >/dev/null
sips -z 64 64 "$BASE_PNG" --out "$ICONSET_DIR/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$BASE_PNG" --out "$ICONSET_DIR/icon_128x128.png" >/dev/null
sips -z 256 256 "$BASE_PNG" --out "$ICONSET_DIR/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$BASE_PNG" --out "$ICONSET_DIR/icon_256x256.png" >/dev/null
sips -z 512 512 "$BASE_PNG" --out "$ICONSET_DIR/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$BASE_PNG" --out "$ICONSET_DIR/icon_512x512.png" >/dev/null
sips -z 1024 1024 "$BASE_PNG" --out "$ICONSET_DIR/icon_512x512@2x.png" >/dev/null

iconutil -c icns "$ICONSET_DIR" -o "$ICNS_PATH"

echo "Generated:"
echo "$ICNS_PATH"
