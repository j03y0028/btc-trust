#!/bin/bash
# Run myNode's real dynamic-app loader (current mynodebtc/mynode master by default) against an app folder.
#   scripts/mynode-loader/run.sh [app_dir]          default: mynode/btctrust
#   MYNODE_REF=<branch|sha>  (default master)    MYNODE_REF_DIR=<existing rootfs/standard>  (offline)
# Needs docker. Prints the harness JSON; exit 0 = the app loads/installs cleanly under myNode's code.
set -euo pipefail
cd "$(dirname "$0")/../.."
APP="$(cd "${1:-mynode/btctrust}" && pwd)"
REF="${MYNODE_REF:-master}"
IMAGE="${LOADER_IMAGE:-python:3.11-slim-bookworm}"
if [ -n "${MYNODE_REF_DIR:-}" ]; then ROOTFS="$(cd "$MYNODE_REF_DIR" && pwd)"; SHA=local
else
    SRC=build/mynode-src
    if [ ! -d "$SRC/.git" ]; then rm -rf "$SRC"; git clone -q --filter=blob:none --no-checkout https://github.com/mynodebtc/mynode.git "$SRC"; fi
    git -C "$SRC" fetch -q --depth 1 origin "$REF"
    git -C "$SRC" -c advice.detachedHead=false checkout -q FETCH_HEAD -- rootfs/standard/var/pynode rootfs/standard/usr/share/mynode/application_info.json rootfs/standard/usr/share/mynode_apps/albyhub
    SHA="$(git -C "$SRC" rev-parse FETCH_HEAD)"; ROOTFS="$PWD/$SRC/rootfs/standard"
fi
D() { if docker info >/dev/null 2>&1; then docker "$@"; else sg docker -c "docker $(printf '%q ' "$@")"; fi; }
echo "myNode loader: mynodebtc/mynode $REF @ $SHA" >&2
D run --rm --network none -e LOADER_SKIP_INSTALL="${LOADER_SKIP_INSTALL:-0}" -v "$ROOTFS:/ref:ro" -v "$APP:/src/$(basename "$APP"):ro" -v "$PWD/scripts/mynode-loader:/h:ro" \
    "$IMAGE" python3 /h/harness.py /ref "/src/$(basename "$APP")"
