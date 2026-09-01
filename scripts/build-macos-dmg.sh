#!/bin/zsh

set -euo pipefail

ROOT="${0:A:h:h}"
APP="$ROOT/build/Vidmark.app"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ROOT/packaging/Info.plist")"
RELEASE_DIR="$ROOT/releases"
DMG="$RELEASE_DIR/Vidmark-$VERSION.dmg"
STAGING_ROOT="$(/usr/bin/mktemp -d)"
STAGING="$STAGING_ROOT/Vidmark"

cleanup() {
  case "$STAGING_ROOT" in
    /var/folders/*|/tmp/*) /bin/rm -rf "$STAGING_ROOT" ;;
  esac
}
trap cleanup EXIT

print "Building Vidmark $VERSION…"
/bin/zsh "$ROOT/scripts/build-macos-app.sh"

print "Verifying the signed app bundle…"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP"

print "Creating the drag-to-Applications disk image…"
/bin/mkdir -p "$STAGING" "$RELEASE_DIR"
/usr/bin/ditto "$APP" "$STAGING/Vidmark.app"
/bin/ln -s /Applications "$STAGING/Applications"

/usr/bin/hdiutil create \
  -volname "Vidmark" \
  -srcfolder "$STAGING" \
  -ov \
  -format UDZO \
  "$DMG"

print "Verifying the disk image…"
/usr/bin/hdiutil verify "$DMG"

print ""
print "Packaged DMG: $DMG"
/usr/bin/shasum -a 256 "$DMG"
