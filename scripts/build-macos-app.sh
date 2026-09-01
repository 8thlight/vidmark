#!/bin/zsh

set -euo pipefail

ROOT="${0:A:h:h}"
APP="$ROOT/build/Vidmark.app"
BUN="$ROOT/.tools/bun/bin/bun"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ROOT/packaging/Info.plist")"
MCPB="$ROOT/releases/Vidmark-$VERSION.mcpb"
ICON_SOURCE="$ROOT/public/vidmark-mark.png"
ICONSET="$ROOT/build/Vidmark.iconset"

[[ -f "$ICON_SOURCE" ]] || { print "App mark is missing at $ICON_SOURCE"; exit 1; }

if [[ ! -x "$BUN" ]]; then
  print "Installing Bun into the project-local .tools directory…"
  mkdir -p "$ROOT/.tools/bun"
  /usr/bin/curl -fsSL https://bun.sh/install | BUN_INSTALL="$ROOT/.tools/bun" SHELL=/bin/false /bin/bash
fi

if /usr/bin/curl -fsS --max-time 1 http://localhost:3010/ >/dev/null 2>&1; then
  print "Vidmark is currently running. Quit it before rebuilding the app bundle."
  exit 1
fi

print "[1/7] Building the bundled Claude Desktop extension…"
/bin/zsh "$ROOT/scripts/build-dxt.sh"

print "[2/7] Building optimized Vinext assets with Bun…"
cd "$ROOT"
WRANGLER_LOG_PATH=.wrangler/wrangler.log "$BUN" "$ROOT/node_modules/vinext/dist/cli.js" build

case "$APP" in
  "$ROOT/build/Vidmark.app") ;;
  *) print "Refusing to replace unexpected app path: $APP"; exit 1 ;;
esac

rm -rf "$APP" "$ICONSET"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$ICONSET"

print "[3/7] Compiling the standalone Bun server…"
"$BUN" build "$ROOT/scripts/packaged-server.ts" --compile --target=bun-darwin-arm64 --minify --sourcemap --outfile "$APP/Contents/MacOS/VidmarkServer"

print "[4/7] Compiling the native Swift + WKWebView shell…"
/usr/bin/xcrun swiftc "$ROOT/packaging/VidmarkApp.swift" -O -target arm64-apple-macos13.0 -framework AppKit -framework WebKit -o "$APP/Contents/MacOS/Vidmark"

print "[5/7] Packaging production assets, the Claude extension, and local transcription support…"
/usr/bin/ditto "$ROOT/dist" "$APP/Contents/Resources/dist"
/bin/mkdir -p "$APP/Contents/Resources/ClaudeDesktop"
/usr/bin/ditto "$MCPB" "$APP/Contents/Resources/ClaudeDesktop/Vidmark.mcpb"
/bin/cp "$ROOT/scripts/whisper-worker.py" "$APP/Contents/Resources/whisper-worker.py"
/bin/cp "$ROOT/packaging/Info.plist" "$APP/Contents/Info.plist"
print -r -- "$ROOT" > "$APP/Contents/Resources/vidmark-project-path"
/bin/chmod +x "$APP/Contents/MacOS/Vidmark" "$APP/Contents/MacOS/VidmarkServer"

print "[6/7] Creating the macOS icon…"
for size in 16 32 128 256 512; do
  /usr/bin/sips -z "$size" "$size" "$ICON_SOURCE" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  /usr/bin/sips -z "$double" "$double" "$ICON_SOURCE" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
/usr/bin/iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Vidmark.icns"
rm -rf "$ICONSET"

print "[7/7] Ad-hoc signing the local app bundle…"
/usr/bin/codesign --force --deep --sign - "$APP"

print ""
print "Packaged app: $APP"
print "Double-click Vidmark.app to run the Bun production server locally."
