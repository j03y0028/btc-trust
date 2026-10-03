#!/bin/sh
# Bundled TEST wallet node (regtest or signet) for BTC Trust. Never mainnet.
#   TESTNODE_CHAIN=regtest|signet   TESTNODE_RPC_USER / TESTNODE_RPC_PASSWORD (hashed into -rpcauth here)
set -eu
CHAIN="${TESTNODE_CHAIN:-regtest}"
case "$CHAIN" in regtest|signet) ;; *) echo "btctrust-testnode: refusing chain '$CHAIN' (only regtest or signet)" >&2; exit 1 ;; esac
: "${TESTNODE_RPC_USER:?}" "${TESTNODE_RPC_PASSWORD:?}"
DIR="${TESTNODE_DATADIR:-/bitcoin}"
mkdir -p "$DIR"
# rpcauth = user:salt$HMAC-SHA256(salt, password), as Bitcoin Core's share/rpcauth/rpcauth.py
RPCAUTH=$(node -e 'const c=require("crypto");const s=c.randomBytes(16).toString("hex");process.stdout.write(`${process.argv[1]}:${s}$${c.createHmac("sha256",s).update(process.argv[2]).digest("hex")}`)' "$TESTNODE_RPC_USER" "$TESTNODE_RPC_PASSWORD")
PORT=18443; [ "$CHAIN" = signet ] && PORT=38332
if [ "${1:-}" = health ]; then   # docker healthcheck: RPC answers with our credentials
  printf '%s\n' "$TESTNODE_RPC_PASSWORD" | bitcoin-cli -chain="$CHAIN" -datadir="$DIR" -rpcport=$PORT -rpcuser="$TESTNODE_RPC_USER" -stdinrpcpass getblockcount >/dev/null
  exit $?
fi
exec bitcoind -chain="$CHAIN" -datadir="$DIR" -server=1 -listen=0 -txindex=0 -fallbackfee=0.0001 \
  -rpcauth="$RPCAUTH" -rpcbind=0.0.0.0 -rpcport=$PORT -rpcallowip=0.0.0.0/0 -printtoconsole=1 -dbcache=50 -maxmempool=50 "$@"
