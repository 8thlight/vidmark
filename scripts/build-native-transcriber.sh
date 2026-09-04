#!/bin/zsh

set -euo pipefail

ROOT="${0:A:h:h}"
OUTPUT="${1:-$ROOT/build/VidmarkTranscriber}"

if [[ -z "${DEVELOPER_DIR:-}" && -d /Applications/Xcode.app/Contents/Developer ]]; then
  export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi

/bin/mkdir -p "${OUTPUT:h}"
/usr/bin/xcrun swiftc "$ROOT/packaging/VidmarkTranscriber.swift" \
  -parse-as-library \
  -O \
  -target arm64-apple-macos13.0 \
  -framework AVFoundation \
  -framework Speech \
  -o "$OUTPUT"
