#!/bin/bash
# Simulated myNode for Stage 8 (no real myNode needed). Uses myNode's REAL bitcoin.conf generator + templates
# (pinned commit), install-mynode.sh in simulation mode, and run.sh (what btctrust.service runs).
#   scripts/mynode-sim.sh up     build fake root, install, start stand-in "mainnet" node + app (background)
#   scripts/mynode-sim.sh down   stop everything (keeps $SIM for inspection)
# The stand-in "mainnet" node is a REGTEST bitcoind (MAINNET_RPC_EXPECT_CHAIN=regtest) - no mainnet involved.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$PWD"
SIM="${SIM:-/tmp/mynode-sim}"
# myNode code under test: current mynodebtc/mynode master (override: MYNODE_COMMIT=<full 40-char sha>)
MYNODE_COMMIT="${MYNODE_COMMIT:-$(git ls-remote https://github.com/mynodebtc/mynode.git refs/heads/master | cut -f1)}"
[ -n "$MYNODE_COMMIT" ] || { echo "cannot resolve mynodebtc/mynode master" >&2; exit 1; }
REF="$REPO/build/mynode-ref-$MYNODE_COMMIT"
BITCOIND="${BITCOIND:-bitcoind}"; CLI="${BITCOIN_CLI:-bitcoin-cli}"
RPCPORT=18643; P2P=18644; APPPORT="${APPPORT:-19330}"
IMAGE="${IMAGE:-btctrust:0.8.4}"
NAME=btctrust-sim
GW="$(ip -4 addr show docker0 | awk '/inet /{sub(/\/.*/,"",$2);print $2}')"   # = host.docker.internal
DATADIR="$SIM/mnt/hdd/mynode/bitcoin"
MYNODE_PW_FILE="$SIM/mnt/hdd/mynode/settings/.btcrpcpw"
D() { if docker info >/dev/null 2>&1; then docker "$@"; else sg docker -c "docker $(printf '%q ' "$@")"; fi; }
mcli() { "$CLI" -regtest -datadir="$DATADIR" -rpcport=$RPCPORT -rpcuser=mynode -rpcpassword="$(cat "$MYNODE_PW_FILE")" "$@"; }

# Box quirk: a leftover iptables-legacy FORWARD DROP policy (next to docker's nftables rules) drops traffic between
# containers on the same user bridge. Allow intra-bridge forwarding for the sim network only (removed on down).
legacy_fix() {  # $1 = -I | -D
    local ipt; ipt="$(PATH="$PATH:/usr/sbin:/sbin" command -v iptables-legacy)" || return 0
    sudo -n "$ipt" -S FORWARD 2>/dev/null | grep -q -- '-P FORWARD DROP' || return 0
    local br; br="br-$(D network inspect -f '{{printf "%.12s" .Id}}' "$NAME-internal" 2>/dev/null)" || return 0
    [ "$br" = br- ] && return 0
    if [ "$1" = -I ]; then sudo -n "$ipt" -C FORWARD -i "$br" -o "$br" -j ACCEPT 2>/dev/null || sudo -n "$ipt" -I FORWARD -i "$br" -o "$br" -j ACCEPT
    else while sudo -n "$ipt" -D FORWARD -i "$br" -o "$br" -j ACCEPT 2>/dev/null; do :; done; fi
}

down() {
    legacy_fix -D || true
    D rm -f "$NAME" "$NAME-testnode" >/dev/null 2>&1 || true
    D network rm "$NAME-internal" >/dev/null 2>&1 || true
    [ -f "$DATADIR/regtest/bitcoind.pid" ] && kill "$(cat "$DATADIR/regtest/bitcoind.pid")" 2>/dev/null || true
    for _ in $(seq 1 30); do [ -f "$DATADIR/regtest/bitcoind.pid" ] || break; sleep 1; done
}

fetch_ref() {
    [ -f "$REF/.complete" ] && return 0
    mkdir -p "$REF/usr/bin" "$REF/usr/share/mynode"
    B="https://raw.githubusercontent.com/mynodebtc/mynode/$MYNODE_COMMIT/rootfs/standard"
    for f in usr/bin/gen_rpcauth.py usr/bin/mynode_gen_bitcoin_config.sh usr/share/mynode/bitcoin.conf \
             usr/share/mynode/bitcoin_ipv4.conf usr/share/mynode/bitcoin_no_ipv4.conf usr/share/mynode/bitcoin_tor.conf \
             usr/share/mynode/bitcoin_i2p.conf usr/share/mynode/bitcoin_testnet.conf; do
        curl -fsSL "$B/$f" -o "$REF/$f"
    done
    touch "$REF/.complete"
}

up() {
    [ -n "$GW" ] || { echo "no docker0 bridge" >&2; exit 1; }
    down; rm -rf "$SIM"; fetch_ref
    echo "== fake myNode root at $SIM"
    S="$SIM/mnt/hdd/mynode/settings"
    mkdir -p "$S" "$DATADIR" "$SIM/usr/share/mynode" "$SIM/usr/bin" "$SIM/home/bitcoin/.mynode"
    cp "$REF"/usr/share/mynode/*.conf "$SIM/usr/share/mynode/"
    cp "$REF/usr/bin/gen_rpcauth.py" "$SIM/usr/bin/"; chmod +x "$SIM/usr/bin/gen_rpcauth.py"
    # myNode's generator with its absolute paths re-rooted (logic unchanged)
    sed -e "s#/mnt/hdd/#$SIM/mnt/hdd/#g" -e "s#/home/bitcoin/#$SIM/home/bitcoin/#g" -e "s#/usr/share/mynode/#$SIM/usr/share/mynode/#g" \
        "$REF/usr/bin/mynode_gen_bitcoin_config.sh" > "$SIM/usr/bin/mynode_gen_bitcoin_config.sh"
    # sandbox-only tweak: keep the template's ZMQ listeners on loopback on this shared box
    sed -i 's#tcp://0.0.0.0:#tcp://127.0.0.1:#' "$SIM/usr/share/mynode/bitcoin.conf"
    python3 -c 'import secrets;print(secrets.token_hex(16))' > "$MYNODE_PW_FILE"
    echo 29.3 > "$SIM/home/bitcoin/.mynode/bitcoin_version"   # myNode BTC_VERSION (mynode_app_versions.sh)
    touch "$S/btc_network_settings_defaulted" "$S/btc_ipv4_enabled" "$SIM/mnt/hdd/mynode/.mynode_bitcoin_synced_at_least_once"
    printf '# my own tweaks\nmaxconnections=20\n' > "$S/bitcoin_post_config.conf"   # pre-existing user content must survive

    echo "== myNode's real app loader ($MYNODE_COMMIT): mynode-manage-apps init + install paths for mynode/btctrust"
    MYNODE_REF="$MYNODE_COMMIT" bash scripts/mynode-loader/run.sh mynode/btctrust >"$SIM/loader.log" 2>&1 \
        && grep -q '^MYNODE_LOADER_RESULT {.*"ok": true' "$SIM/loader.log" || { tail -40 "$SIM/loader.log"; echo "myNode's loader rejected the app" >&2; exit 1; }

    echo "== install-mynode.sh (simulation mode, run twice to prove idempotence)"
    for i in 1 2; do
        MYNODE_ROOT="$SIM" MYNODE_SIM=1 BTCTRUST_EXPECT_CHAIN=regtest BTCTRUST_MAINNET_PORT=$RPCPORT \
            bash mynode/install-mynode.sh --yes >"$SIM/install-$i.log" 2>&1 || { cat "$SIM/install-$i.log"; exit 1; }
    done
    [ "$(grep -c '^includeconf=' "$S/bitcoin_post_config.conf")" = 1 ] || { echo "includeconf duplicated" >&2; exit 1; }

    echo "== myNode's mynode_gen_bitcoin_config.sh (twice: rpcauth sed must not clobber the btctrust user)"
    PATH="$SIM/usr/bin:$PATH" bash "$SIM/usr/bin/mynode_gen_bitcoin_config.sh" >/dev/null 2>&1 || true   # last step chown bitcoin:bitcoin fails here (no bitcoin user)
    PATH="$SIM/usr/bin:$PATH" bash "$SIM/usr/bin/mynode_gen_bitcoin_config.sh" >/dev/null 2>&1 || true   # last step chown bitcoin:bitcoin fails here (no bitcoin user)
    grep -q '^includeconf=' "$DATADIR/bitcoin.conf" || { echo "includeconf missing from generated bitcoin.conf" >&2; exit 1; }

    echo "== stand-in 'mainnet' node (regtest) with the generated conf; RPC on 127.0.0.1 + docker bridge $GW:$RPCPORT"
    "$BITCOIND" -regtest -conf="$DATADIR/bitcoin.conf" -datadir="$DATADIR" -daemon=1 \
        -rpcport=$RPCPORT -rpcbind=127.0.0.1 -rpcbind="$GW" -port=$P2P -bind=127.0.0.1 -fallbackfee=0.0002 \
        >"$SIM/bitcoind-start.log" 2>&1 || { cat "$SIM/bitcoind-start.log"; tail -20 "$DATADIR/regtest/debug.log" 2>/dev/null; exit 1; }
    for _ in $(seq 1 60); do mcli getblockcount >/dev/null 2>&1 && break; sleep 1; done
    # Like a real myNode: the node has a loaded hot wallet (bitcoin.conf main.wallet=wallet.dat) the app must never touch.
    mcli -named createwallet wallet_name=mynode_hot >/dev/null
    mcli -rpcwallet=mynode_hot generatetoaddress 150 "$(mcli -rpcwallet=mynode_hot getnewaddress)" >/dev/null
    echo "stand-in height: $(mcli getblockcount)"

    echo "== app via run.sh (what btctrust.service runs) on 127.0.0.1:$APPPORT"
    ENVF="$SIM/mnt/hdd/mynode/btctrust/btctrust.env"
    sed -i "s#^MAINNET_RPC_HOST=.*#MAINNET_RPC_HOST=host.docker.internal#; s#^API_ALLOWED_HOSTS=.*#&,localhost#" "$ENVF"
    RUN=(env BTCTRUST_DATA="$SIM/mnt/hdd/mynode/btctrust" BTCTRUST_IMAGE="$IMAGE" BTCTRUST_NAME=$NAME
         BTCTRUST_PORT=$APPPORT BTCTRUST_BIND=127.0.0.1 bash mynode/btctrust/app_data/run.sh start)
    if docker info >/dev/null 2>&1; then nohup "${RUN[@]}" >"$SIM/app.log" 2>&1 &
    else nohup sg docker -c "$(printf '%q ' "${RUN[@]}")" >"$SIM/app.log" 2>&1 & fi
    for _ in $(seq 1 60); do D network inspect "$NAME-internal" >/dev/null 2>&1 && break; sleep 1; done
    legacy_fix -I
    for _ in $(seq 1 60); do curl -fs "http://127.0.0.1:$APPPORT/api/healthz" >/dev/null 2>&1 && break; sleep 1; done
    curl -fs "http://127.0.0.1:$APPPORT/api/healthz" >/dev/null || { cat "$SIM/app.log"; exit 1; }
    echo "app up: http://127.0.0.1:$APPPORT  (setup token: $SIM/mnt/hdd/mynode/btctrust/app/setup-token)"
}

case "${1:-up}" in up) up ;; down) down ;; *) echo "usage: $0 up|down" >&2; exit 2 ;; esac
