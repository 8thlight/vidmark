#!/bin/zsh
set -euo pipefail

ROOT_DIR="${0:A:h:h}"
IMAGE="vidmark-relay:local"
NAME="vidmark-relay"
VOLUME="vidmark-relay-data"
RUNTIME_SOURCE="/tmp/vidmark-relay-${UID}"

case "${1:-start}" in
  build)
    container build --tag "$IMAGE" --file "$ROOT_DIR/relay/Containerfile" "$ROOT_DIR/relay"
    ;;
  start)
    container system start >/dev/null
    container stop "$NAME" >/dev/null 2>&1 || true
    container delete "$NAME" >/dev/null 2>&1 || true
    container volume create "$VOLUME" >/dev/null 2>&1 || true
    mkdir -p "$RUNTIME_SOURCE"
    cp "$ROOT_DIR/relay/server.ts" "$RUNTIME_SOURCE/server.ts"
    container run --name "$NAME" --detach --arch arm64 --cpus 1 --memory 256m --publish 127.0.0.1:31800:31800 --volume "$RUNTIME_SOURCE:/app:ro" --volume "$VOLUME:/data" docker.io/oven/bun:1-alpine bun run /app/server.ts
    echo "Vidmark relay: ws://127.0.0.1:31800/ws"
    ;;
  stop)
    container stop "$NAME"
    ;;
  logs)
    container logs --follow "$NAME"
    ;;
  status)
    container list --all
    curl --fail --silent http://127.0.0.1:31800/health
    echo
    ;;
  *)
    echo "Usage: $0 {build|start|stop|logs|status}" >&2
    exit 2
    ;;
esac
