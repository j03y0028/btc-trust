#!/bin/bash
# BTC Trust container runner (used by btctrust.service on myNode, and by scripts/mynode-sim.sh).
#   run.sh start   start the TEST wallet node (detached) and the app (foreground)
#   run.sh stop    stop both
# Settings come from $DATA/btctrust.env (written by install-mynode.sh, mode 600).
set -euo pipefail
ACTION="${1:-start}"
DATA="${BTCTRUST_DATA:-/mnt/hdd/mynode/btctrust}"
IMAGE="${BTCTRUST_IMAGE:-btctrust:latest}"
APP="${BTCTRUST_NAME:-btctrust}"
TEST="${APP}-testnode"
NET="${APP}-internal"
ENV_FILE="$DATA/btctrust.env"
# explicit environment wins over btctrust.env
OVR_PORT="${BTCTRUST_PORT:-}"; OVR_BIND="${BTCTRUST_BIND:-}"

stop() {
    docker stop -t 10 "$APP" >/dev/null 2>&1 || true
    docker stop -t 30 "$TEST" >/dev/null 2>&1 || true
    docker rm -f "$APP" "$TEST" >/dev/null 2>&1 || true
}

if [ "$ACTION" = stop ]; then stop; exit 0; fi
[ "$ACTION" = start ] || { echo "usage: run.sh start|stop" >&2; exit 2; }
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE (run install-mynode.sh)" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a
WALLET_FEATURES="${WALLET_FEATURES:-on}"
WALLET_CHAIN="${WALLET_CHAIN:-regtest}"
case "$WALLET_CHAIN" in regtest|signet) ;; *) echo "WALLET_CHAIN must be regtest or signet" >&2; exit 1 ;; esac
PORT="${OVR_PORT:-${BTCTRUST_PORT:-9330}}"
BIND="${OVR_BIND:-${BTCTRUST_BIND:-0.0.0.0}}"
USERSPEC="$(id -u):$(id -g)"

stop
mkdir -p "$DATA/app" "$DATA/testnode"
# Internal network: the test node has no published ports; on regtest it also has no internet or host access.
docker network inspect "$NET" >/dev/null 2>&1 || docker network create --internal "$NET" >/dev/null

WALLET_ENV=(-e WALLET_FEATURES=off)
if [ "$WALLET_FEATURES" != off ]; then
    docker run -d --name "$TEST" --network "$NET" --user "$USERSPEC" \
        -v "$DATA/testnode:/bitcoin" \
        -e TESTNODE_CHAIN="$WALLET_CHAIN" -e TESTNODE_RPC_USER=btctrust -e TESTNODE_RPC_PASSWORD="$TESTNODE_RPC_PASSWORD" \
        --health-cmd "btctrust-testnode health" --health-interval 30s --health-start-period 60s \
        "$IMAGE" btctrust-testnode >/dev/null
    # signet has to sync from public peers: give the test node outbound internet (still no published ports).
    if [ "$WALLET_CHAIN" = signet ]; then docker network connect bridge "$TEST"; fi
    WALLET_ENV=(-e WALLET_FEATURES=on -e BITCOIN_NETWORK="$WALLET_CHAIN" -e BITCOIN_RPC_HOST="$TEST"
                -e BITCOIN_RPC_USER=btctrust -e BITCOIN_RPC_PASSWORD="$TESTNODE_RPC_PASSWORD")
fi

# The app reaches myNode's bitcoind through the Docker host gateway (myNode's bitcoin.conf allows 172.16.0.0/12).
docker create --name "$APP" --user "$USERSPEC" \
    -p "$BIND:$PORT:9330" \
    --add-host host.docker.internal:host-gateway \
    -v "$DATA/app:/data" \
    -e APP_MODE=split -e AUTH_MODE=on \
    -e MAINNET_RPC_HOST="${MAINNET_RPC_HOST:-host.docker.internal}" -e MAINNET_RPC_PORT="${MAINNET_RPC_PORT:-8332}" \
    -e MAINNET_RPC_USER="${MAINNET_RPC_USER:-btctrust}" -e MAINNET_RPC_PASSWORD="${MAINNET_RPC_PASSWORD:-}" \
    -e MAINNET_RPC_EXPECT_CHAIN="${MAINNET_RPC_EXPECT_CHAIN:-main}" \
    -e API_ALLOWED_HOSTS="${API_ALLOWED_HOSTS:-mynode.local,mynode}" \
    -e SNAPSHOT_TZ="${SNAPSHOT_TZ:-}" -e MAINNET_SNAPSHOTS="${MAINNET_SNAPSHOTS:-true}" \
    -e PRICE_FEED="${PRICE_FEED:-on}" \
    "${WALLET_ENV[@]}" \
    "$IMAGE" >/dev/null
if [ "$WALLET_FEATURES" != off ]; then docker network connect "$NET" "$APP"; fi
exec docker start -a "$APP"
