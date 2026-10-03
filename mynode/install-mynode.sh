#!/bin/bash
# BTC Trust - myNode installer.  Run ON the myNode as root:   sudo ./install-mynode.sh
#
# What it does (each step is idempotent, re-running is safe):
#   1. copies the app folder to /usr/share/mynode_apps/btctrust and registers it (mynode-manage-apps init/install)
#   2. creates a READ-ONLY bitcoind RPC user "btctrust" in its own file
#        /mnt/hdd/mynode/settings/btctrust_bitcoin.conf   (rpcauth + rpcwhitelist + rpcwhitelistdefault=0)
#      and includes it from /mnt/hdd/mynode/settings/bitcoin_post_config.conf
#      (myNode rewrites every "rpcauth=" line in bitcoin.conf on each start, so the user must live in an includeconf file)
#   3. writes /mnt/hdd/mynode/btctrust/btctrust.env (mode 600) with the generated passwords
#   4. restarts bitcoind (asks first) so the new RPC user exists, then self-checks it is read-only
#   5. enables + starts the btctrust service
#
# Options:  --yes                 don't ask (restart bitcoind without prompting)
#           --no-bitcoin-restart  skip step 4 (restart bitcoind yourself later: sudo systemctl restart bitcoin)
#           --wallets=regtest|signet|off   chain for the TEST-ONLY wallet features (default regtest)
#           --port=N              HTTP port (default 9330; https via myNode nginx on 9331)
# Simulation/testing (scripts/mynode-sim.sh):  MYNODE_ROOT=/tmp/fake-root MYNODE_SIM=1
set -euo pipefail

APP=btctrust
ROOT="${MYNODE_ROOT:-}"
SIM="${MYNODE_SIM:-0}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
YES=0; RESTART=1; WALLETS=regtest; PORT=9330
for a in "$@"; do
    case "$a" in
        --yes|-y) YES=1 ;;
        --no-bitcoin-restart) RESTART=0 ;;
        --wallets=*) WALLETS="${a#*=}" ;;
        --port=*) PORT="${a#*=}" ;;
        -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
        *) echo "unknown option: $a" >&2; exit 2 ;;
    esac
done
case "$WALLETS" in regtest|signet|off) ;; *) echo "--wallets must be regtest, signet or off (never mainnet)" >&2; exit 2 ;; esac
[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "--port must be a number" >&2; exit 2; }

APPS_DIR="$ROOT/usr/share/mynode_apps"
SETTINGS="$ROOT/mnt/hdd/mynode/settings"
DATA="$ROOT/mnt/hdd/mynode/$APP"
INCLUDE="$SETTINGS/${APP}_bitcoin.conf"
POST="$SETTINGS/bitcoin_post_config.conf"
CUSTOM="$SETTINGS/bitcoin_custom.conf"
ENV_FILE="$DATA/$APP.env"
RPC_USER=btctrust
# Must match READ_ONLY_METHODS in backend/src/readonly-rpc.ts (a test enforces this).
RO_METHODS="getblockchaininfo,getblockcount,getbestblockhash,getblockhash,getblockheader,getblock,getblockstats,getchaintips,getchaintxstats,getdifficulty,getmempoolinfo,getnetworkinfo,getconnectioncount,estimatesmartfee,uptime"
MARK_BEGIN="# >>> btctrust read-only RPC user (managed by install-mynode.sh) >>>"
MARK_END="# <<< btctrust <<<"

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
warn() { printf '\033[33mWARNING:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }
ask()  { [ "$YES" = 1 ] && return 0; read -r -p "$1 [y/N] " r; [[ "$r" =~ ^[Yy] ]]; }
rand() { python3 -c 'import secrets;print(secrets.token_urlsafe(32))'; }
envget() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 || true; }

# ---------- 1. preflight ----------
[ "$SIM" = 1 ] || [ "$(id -u)" = 0 ] || die "run as root: sudo $0"
if [ "$SIM" != 1 ]; then
    [ -f /usr/share/mynode/mynode_device_info.sh ] || die "this does not look like a myNode (no /usr/share/mynode)"
    command -v mynode-manage-apps >/dev/null || die "mynode-manage-apps not found - update myNode first"
    command -v docker >/dev/null || die "docker not found - enable Docker on myNode first"
    [ -d /mnt/hdd/mynode ] || die "/mnt/hdd/mynode is missing (is the drive mounted?)"
fi
ARCH="$(uname -m)"
case "$ARCH" in x86_64|aarch64) ;; *) die "unsupported CPU $ARCH (need x86_64 or aarch64)";; esac
IMG="$HERE/$APP/app_data/$APP-image-$ARCH.tar.gz"
[ -f "$IMG" ] || die "missing $IMG - this package was not built for $ARCH"
if [ -f "$IMG.sha256" ]; then (cd "$(dirname "$IMG")" && sha256sum -c --quiet "$(basename "$IMG").sha256") || die "image checksum mismatch"; fi

cat <<MSG

BTC Trust for myNode
  * Mainnet: READ-ONLY. The app gets its own bitcoind RPC user that bitcoind itself limits to:
      $RO_METHODS
    and the app refuses every other RPC method in code. No mainnet keys, wallets or transactions.
  * Wallets / vaults / PSBT / messaging: TEST ONLY, on a separate bundled $WALLETS node (no real bitcoin).
    Do not send real bitcoin to any address shown in this app.
MSG
[ "$WALLETS" = off ] && echo "  * Wallet features: DISABLED (--wallets=off)."
ask "Continue?" || die "aborted"

# ---------- 2. app folder + registration ----------
say "Installing app definition to $APPS_DIR/$APP"
mkdir -p "$APPS_DIR"
rm -rf "${APPS_DIR:?}/$APP"
cp -r "$HERE/$APP" "$APPS_DIR/$APP"
chmod -R a+rX "$APPS_DIR/$APP"
[ "$SIM" = 1 ] || mynode-manage-apps init      # creates linux user btctrust (+docker group), service, nginx, scripts

# ---------- 3. read-only RPC user ----------
say "Creating read-only RPC user '$RPC_USER'"
mkdir -p "$SETTINGS" "$DATA/app" "$DATA/testnode"
MAIN_PW="$(envget MAINNET_RPC_PASSWORD)"; [ -n "$MAIN_PW" ] || MAIN_PW="$(rand)"
TEST_PW="$(envget TESTNODE_RPC_PASSWORD)"; [ -n "$TEST_PW" ] || TEST_PW="$(rand)"
RPCAUTH="$(RPC_PW="$MAIN_PW" python3 - "$RPC_USER" <<'PY'
import hmac, os, secrets, sys
salt = secrets.token_hex(16)
h = hmac.new(salt.encode(), os.environ["RPC_PW"].encode(), "SHA256").hexdigest()
print(f"rpcauth={sys.argv[1]}:{salt}${h}")
PY
)"
umask 027
cat > "$INCLUDE" <<CONF
# BTC Trust: read-only RPC user. Written by install-mynode.sh, removed by uninstall-mynode.sh.
# rpcwhitelistdefault=0 keeps every OTHER rpc user (myNode's own "mynode" user) unrestricted.
$RPCAUTH
rpcwhitelist=$RPC_USER:$RO_METHODS
rpcwhitelistdefault=0
CONF
umask 022
if id bitcoin >/dev/null 2>&1; then chown root:bitcoin "$INCLUDE"; fi
chmod 640 "$INCLUDE"

if [ -f "$CUSTOM" ]; then
    warn "$CUSTOM exists, so myNode uses it as bitcoin.conf and ignores bitcoin_post_config.conf."
    warn "Add this line to your custom config yourself (myNode UI: Bitcoin > Bitcoin Config):"
    echo "    includeconf=${INCLUDE#$ROOT}"
elif grep -qF "$MARK_BEGIN" "$POST" 2>/dev/null; then
    echo "includeconf already present in $POST"
else
    [ -f "$POST" ] && [ -n "$(tail -c1 "$POST")" ] && echo >> "$POST"
    printf '%s\nincludeconf=%s\n%s\n' "$MARK_BEGIN" "${INCLUDE#$ROOT}" "$MARK_END" >> "$POST"
    [ -n "$ROOT" ] && sed -i "s#^includeconf=${INCLUDE#$ROOT}\$#includeconf=$INCLUDE#" "$POST"   # sim: real path
    echo "added includeconf to $POST"
fi

# ---------- 4. app settings ----------
say "Writing $ENV_FILE"
TZ_NAME="$(cat /etc/timezone 2>/dev/null || true)"; TZ_NAME="${TZ_NAME:-UTC}"
HOSTS="mynode.local,mynode"
H="$(hostname 2>/dev/null || true)"; [ -n "$H" ] && HOSTS="$HOSTS,$H,$H.local"
EXTRA_HOSTS="$(envget API_ALLOWED_HOSTS_EXTRA)"; [ -n "$EXTRA_HOSTS" ] && HOSTS="$HOSTS,$EXTRA_HOSTS"
umask 077
cat > "$ENV_FILE" <<ENV
# BTC Trust settings (secrets - keep mode 600). Re-running install-mynode.sh keeps the passwords.
MAINNET_RPC_HOST=${BTCTRUST_MAINNET_HOST:-host.docker.internal}
MAINNET_RPC_PORT=${BTCTRUST_MAINNET_PORT:-8332}
MAINNET_RPC_USER=$RPC_USER
MAINNET_RPC_PASSWORD=$MAIN_PW
MAINNET_RPC_EXPECT_CHAIN=${BTCTRUST_EXPECT_CHAIN:-main}
TESTNODE_RPC_PASSWORD=$TEST_PW
WALLET_CHAIN=$([ "$WALLETS" = off ] && echo regtest || echo "$WALLETS")
WALLET_FEATURES=$([ "$WALLETS" = off ] && echo off || echo on)
BTCTRUST_PORT=$PORT
API_ALLOWED_HOSTS=$HOSTS
API_ALLOWED_HOSTS_EXTRA=$EXTRA_HOSTS
SNAPSHOT_TZ=$TZ_NAME
ENV
umask 022
if id "$APP" >/dev/null 2>&1; then chown -R "$APP:$APP" "$DATA"; fi
chmod 700 "$DATA"; chmod 600 "$ENV_FILE"

# ---------- 5. install (loads the docker image) ----------
if [ "$SIM" != 1 ]; then
    say "Installing app (loading docker image, this takes a minute)"
    if [ -f "/mnt/hdd/mynode/settings/install_$APP" ] || [ -f "/home/bitcoin/.mynode/install_$APP" ]; then
        mynode-manage-apps reinstall "$APP"
    else
        mynode-manage-apps install "$APP"
    fi
fi

# ---------- 6. restart bitcoind + verify the RPC user ----------
check_rpc() {   # $1 = method -> prints HTTP status
    RPC_PW="$MAIN_PW" python3 - "$1" "${CHECK_RPC_PORT:-8332}" <<'PY'
import base64, json, os, sys, urllib.request, urllib.error
m, port = sys.argv[1], sys.argv[2]
req = urllib.request.Request(f"http://127.0.0.1:{port}/", data=json.dumps({"jsonrpc":"1.0","id":1,"method":m,"params":[]}).encode(),
      headers={"Authorization": "Basic " + base64.b64encode(f"btctrust:{os.environ['RPC_PW']}".encode()).decode(), "Content-Type": "application/json"})
try: print(urllib.request.urlopen(req, timeout=10).status)
except urllib.error.HTTPError as e: print(e.code)
except Exception: print(0)
PY
}
if [ "$SIM" != 1 ] && [ "$RESTART" = 1 ]; then
    if ask "Restart bitcoind now to load the read-only user? (takes 1-10 min; Lightning apps reconnect afterwards)"; then
        systemctl restart bitcoin
        say "Waiting for bitcoind RPC"
        for _ in $(seq 1 120); do [ "$(check_rpc getblockcount)" = 200 ] && break; sleep 5; done
        [ "$(check_rpc getblockcount)" = 200 ] || die "bitcoind did not accept the btctrust user - see docs/mynode-install.md (Troubleshooting)"
        [ "$(check_rpc getwalletinfo)" = 403 ] || die "SAFETY CHECK FAILED: bitcoind did not refuse getwalletinfo for btctrust - not starting the app"
        echo "OK: btctrust can read the chain (getblockcount 200) and bitcoind refuses wallet calls (getwalletinfo 403)"
    else
        RESTART=0
    fi
fi

# ---------- 7. enable + start ----------
if [ "$SIM" != 1 ]; then
    say "Enabling and starting $APP"
    systemctl enable "$APP" >/dev/null 2>&1 || true
    touch "/mnt/hdd/mynode/settings/${APP}_enabled"
    systemctl restart "$APP"
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<DONE

Done.
  Open:   http://mynode.local:$PORT   (or http://${IP:-<mynode-ip>}:$PORT, or https://mynode.local:9331)
  First visit asks for the one-time SETUP TOKEN. It is shown on the myNode app page (Apps > BTC Trust >
  "App Default Credentials") or:  sudo cat ${DATA#$ROOT}/app/setup-token
  Then choose an app passphrase (12+ characters).
DONE
[ "$RESTART" = 0 ] && [ "$SIM" != 1 ] && warn "bitcoind was NOT restarted: run 'sudo systemctl restart bitcoin' then 'sudo systemctl restart $APP'."
exit 0
