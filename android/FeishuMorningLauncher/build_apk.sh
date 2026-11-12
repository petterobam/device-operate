#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BUILD_TOOLS="${BUILD_TOOLS:-$SDK/build-tools/36.0.0}"
PLATFORM="${PLATFORM:-$SDK/platforms/android-35/android.jar}"
OUT="$PROJECT_DIR/build"
PKG="com.deviceoperate.feishumorning"
APK_UNSIGNED="$OUT/FeishuMorningLauncher-unsigned.apk"
APK_ALIGNED="$OUT/FeishuMorningLauncher-aligned.apk"
APK_SIGNED="$OUT/FeishuMorningLauncher.apk"
KEYSTORE="$PROJECT_DIR/debug.keystore"

rm -rf "$OUT"
mkdir -p "$OUT/classes" "$OUT/dex"

"$BUILD_TOOLS/aapt2" compile --dir "$PROJECT_DIR/res" -o "$OUT/compiled.zip"
"$BUILD_TOOLS/aapt2" link \
  -I "$PLATFORM" \
  --manifest "$PROJECT_DIR/AndroidManifest.xml" \
  --java "$OUT/generated" \
  -o "$OUT/resources.apk" \
  "$OUT/compiled.zip"

find "$PROJECT_DIR/src" "$OUT/generated" -name '*.java' > "$OUT/sources.list"
javac -source 8 -target 8 \
  -bootclasspath "$PLATFORM" \
  -d "$OUT/classes" \
  @"$OUT/sources.list"

"$BUILD_TOOLS/d8" \
  --lib "$PLATFORM" \
  --output "$OUT/dex" \
  $(find "$OUT/classes" -name '*.class')

cp "$OUT/resources.apk" "$APK_UNSIGNED"
cd "$OUT/dex"
zip -q "$APK_UNSIGNED" classes.dex
cd "$PROJECT_DIR"

"$BUILD_TOOLS/zipalign" -f 4 "$APK_UNSIGNED" "$APK_ALIGNED"

if [[ ! -f "$KEYSTORE" ]]; then
  keytool -genkeypair \
    -keystore "$KEYSTORE" \
    -storepass android \
    -keypass android \
    -alias androiddebugkey \
    -keyalg RSA \
    -keysize 2048 \
    -validity 10000 \
    -dname "CN=Android Debug,O=Device Operate,C=US" >/dev/null
fi

"$BUILD_TOOLS/apksigner" sign \
  --ks "$KEYSTORE" \
  --ks-key-alias androiddebugkey \
  --ks-pass pass:android \
  --key-pass pass:android \
  --out "$APK_SIGNED" \
  "$APK_ALIGNED"

"$BUILD_TOOLS/apksigner" verify "$APK_SIGNED"
echo "$APK_SIGNED"
