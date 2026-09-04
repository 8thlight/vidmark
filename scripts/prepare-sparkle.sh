#!/bin/zsh

set -euo pipefail

ROOT="${0:A:h:h}"
SPARKLE_VERSION="2.9.6"
SPARKLE_SHA256="52bf9e88cdd972fc0c81501377a880e90d47031bd8ca5462488f843e2609e192"
SPARKLE_HOME="$ROOT/.tools/sparkle/$SPARKLE_VERSION"
SPARKLE_URL="https://github.com/sparkle-project/Sparkle/releases/download/$SPARKLE_VERSION/Sparkle-$SPARKLE_VERSION.tar.xz"

if [[ -d "$SPARKLE_HOME/Sparkle.framework" && -x "$SPARKLE_HOME/bin/generate_appcast" ]]; then
  print "$SPARKLE_HOME"
  exit 0
fi

/bin/mkdir -p "$ROOT/.tools/sparkle"
STAGING="$(/usr/bin/mktemp -d "$ROOT/.tools/sparkle/.download.XXXXXX")"

cleanup() {
  case "$STAGING" in
    "$ROOT/.tools/sparkle/"*) /bin/rm -rf "$STAGING" ;;
  esac
}
trap cleanup EXIT

print -u2 "Downloading Sparkle $SPARKLE_VERSION…"
/usr/bin/curl -fsSL "$SPARKLE_URL" -o "$STAGING/Sparkle.tar.xz"
ACTUAL_SHA256="$(/usr/bin/shasum -a 256 "$STAGING/Sparkle.tar.xz" | /usr/bin/awk '{print $1}')"
if [[ "$ACTUAL_SHA256" != "$SPARKLE_SHA256" ]]; then
  print -u2 "Sparkle checksum mismatch. Expected $SPARKLE_SHA256 but received $ACTUAL_SHA256."
  exit 1
fi

/usr/bin/tar -xf "$STAGING/Sparkle.tar.xz" -C "$STAGING"
/bin/mv "$STAGING" "$SPARKLE_HOME"
trap - EXIT
print "$SPARKLE_HOME"
