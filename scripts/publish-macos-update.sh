#!/bin/zsh

set -euo pipefail

ROOT="${0:A:h:h}"
INFO_PLIST="$ROOT/packaging/Info.plist"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INFO_PLIST")"
BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$INFO_PLIST")"
RELEASE_DIR="$ROOT/releases"
DMG="$RELEASE_DIR/Vidmark-$VERSION.dmg"
APPCAST="$RELEASE_DIR/appcast.xml"
NOTES="$RELEASE_DIR/Vidmark-$VERSION.md"
DOWNLOAD_PREFIX="https://vidmark-159-223-136-163.sslip.io/updates/"
SPARKLE_HOME="$(/bin/zsh "$ROOT/scripts/prepare-sparkle.sh")"
STAGING="$(/usr/bin/mktemp -d)"

cleanup() {
  case "$STAGING" in
    /var/folders/*|/tmp/*) /bin/rm -rf "$STAGING" ;;
  esac
}
trap cleanup EXIT

[[ -f "$NOTES" ]] || { print "Release notes are missing at $NOTES"; exit 1; }

/bin/zsh "$ROOT/scripts/build-macos-dmg.sh"
/usr/bin/ditto "$DMG" "$STAGING/$(basename "$DMG")"
/usr/bin/ditto "$NOTES" "$STAGING/Vidmark-$VERSION.md"
[[ ! -f "$APPCAST" ]] || /usr/bin/ditto "$APPCAST" "$STAGING/appcast.xml"

"$SPARKLE_HOME/bin/generate_appcast" \
  --account vidmark \
  --download-url-prefix "$DOWNLOAD_PREFIX" \
  --embed-release-notes \
  --maximum-versions 3 \
  --versions "$BUILD" \
  "$STAGING"

/usr/bin/ditto "$STAGING/appcast.xml" "$APPCAST"

print "Generated signed update feed: $APPCAST"
print "To publish it, upload $(basename "$DMG") and appcast.xml to the relay's /opt/vidmark-relay/updates directory."
