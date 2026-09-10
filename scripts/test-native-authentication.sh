#!/bin/zsh
set -euo pipefail
ROOT="${0:A:h:h}"
TEST_DIR="$(mktemp -d -t vidmark-native-tests)"
trap 'rm -f "$TEST_DIR/authentication-tests"; rmdir "$TEST_DIR"' EXIT
xcrun swiftc "$ROOT/packaging/VidmarkAccessSession.swift" \
  "$ROOT/packaging/VidmarkAuthentication.swift" "$ROOT/tests/native-authentication.swift" \
  -framework AppKit -framework LocalAuthentication -framework Security \
  -o "$TEST_DIR/authentication-tests"
"$TEST_DIR/authentication-tests"
