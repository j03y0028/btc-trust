#!/usr/bin/env bash
# Manage the local regtest bitcoind used for development. REGTEST ONLY.
set -euo pipefail
BIN=${BITCOIN_BIN:-/workspace/bitcoin/bin}
DATADIR=${BITCOIN_DATADIR:-/workspace/bitcoin/data}
case "${1:-start}" in
  start)
    if "$BIN/bitcoin-cli" -datadir="$DATADIR" getblockcount >/dev/null 2>&1; then echo "bitcoind already running"; exit 0; fi
    "$BIN/bitcoind" -datadir="$DATADIR" -regtest -daemon
    for _ in $(seq 30); do "$BIN/bitcoin-cli" -datadir="$DATADIR" getblockcount >/dev/null 2>&1 && break; sleep 1; done
    echo "bitcoind (regtest) height: $("$BIN/bitcoin-cli" -datadir="$DATADIR" getblockcount)";;
  stop) "$BIN/bitcoin-cli" -datadir="$DATADIR" stop;;
  cli) shift; "$BIN/bitcoin-cli" -datadir="$DATADIR" "$@";;
  *) echo "usage: $0 start|stop|cli <args>"; exit 1;;
esac
