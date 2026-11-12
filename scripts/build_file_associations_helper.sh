#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$ROOT_DIR/native/file-associations.m"
PROCESS_SOURCE="$ROOT_DIR/native/process-monitor.c"
TEMPERATURE_SOURCE="$ROOT_DIR/native/system-temperature.c"
OUTPUT_DIR="$ROOT_DIR/server/bin"
OUTPUT="$OUTPUT_DIR/file-associations"
PROCESS_OUTPUT="$OUTPUT_DIR/process-monitor"
TEMPERATURE_OUTPUT="$OUTPUT_DIR/system-temperature"

mkdir -p "$OUTPUT_DIR"
xcrun clang \
  -fobjc-arc \
  -framework Foundation \
  -framework CoreServices \
  -framework UniformTypeIdentifiers \
  "$SOURCE" \
  -o "$OUTPUT"
chmod +x "$OUTPUT"

xcrun clang \
  -Wall \
  -Wextra \
  "$PROCESS_SOURCE" \
  -o "$PROCESS_OUTPUT"
chmod +x "$PROCESS_OUTPUT"

xcrun clang \
  -Wall \
  -Wextra \
  -framework CoreFoundation \
  -framework IOKit \
  "$TEMPERATURE_SOURCE" \
  -o "$TEMPERATURE_OUTPUT"
chmod +x "$TEMPERATURE_OUTPUT"
