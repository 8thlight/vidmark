#!/bin/zsh

set -euo pipefail

ROOT="${0:A:h:h}"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ROOT/packaging/Info.plist")"
RELEASE_DIR="$ROOT/releases"
STAGING_ROOT="$(/usr/bin/mktemp -d)"
STAGING="$STAGING_ROOT/vidmark"
MCPB="$RELEASE_DIR/Vidmark-$VERSION.mcpb"
DXT="$RELEASE_DIR/Vidmark-$VERSION.dxt"

cleanup() {
  case "$STAGING_ROOT" in
    /var/folders/*|/tmp/*) /bin/rm -rf "$STAGING_ROOT" ;;
  esac
}
trap cleanup EXIT

/bin/mkdir -p "$STAGING/server" "$RELEASE_DIR"
/usr/bin/ditto "$ROOT/dxt/manifest.json" "$STAGING/manifest.json"
/usr/bin/ditto "$ROOT/dxt/server/index.mjs" "$STAGING/server/index.mjs"
/usr/bin/sips -z 512 512 "$ROOT/assets/vidmark-app-icon.png" --out "$STAGING/icon.png" >/dev/null

print "Validating Vidmark's MCP Bundle manifest…"
"$ROOT/.tools/bun/bin/bun" x --bun @anthropic-ai/mcpb@2.1.2 validate "$STAGING"

print "Packing Claude Desktop extension…"
"$ROOT/.tools/bun/bin/bun" x --bun @anthropic-ai/mcpb@2.1.2 pack "$STAGING" "$MCPB"
/bin/cp "$MCPB" "$DXT"

print "Verifying archive contents…"
/usr/bin/unzip -t "$MCPB"

print ""
print "Packaged MCP Bundle: $MCPB"
print "DXT compatibility copy: $DXT"
/usr/bin/shasum -a 256 "$MCPB" "$DXT"
