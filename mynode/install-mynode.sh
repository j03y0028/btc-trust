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
#      (skipped when bitcoind already has the same read-only user loaded, e.g. when re-running)
#   5. enables + starts the btctrust service
# Stops with a clear error if myNode's app manager reports an error for btctrust (nothing half-started).
#
# Options:  --yes                 don't ask (restart bitcoind without prompting)
#           --no-bitcoin-restart  skip step 4 (restart bitcoind yourself later: sudo systemctl restart bitcoin)
#           --wallets=regtest|signet|off   chain for the TEST-ONLY wallet features (default regtest)
#           --port=N              HTTP port (default 9330; https via myNode nginx on 9331)
# Simulation/testing (scripts/mynode-sim.sh):  MYNODE_ROOT=/tmp/fake-root MYNODE_SIM=1
#           [MYNODE_MANAGE_APPS=/path/to/fake-mynode-manage-apps  also runs the app-manager steps in simulation]
set -euo pipefail

APP=btctrust
ROOT="${MYNODE_ROOT:-}"
SIM="${MYNODE_SIM:-0}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANAGE="${MYNODE_MANAGE_APPS:-mynode-manage-apps}"
USE_MANAGE=1; [ "$SIM" = 1 ] && [ -z "${MYNODE_MANAGE_APPS:-}" ] && USE_MANAGE=0
YES=0; RESTART=1; WALLETS=regtest; PORT=9330
for a in "$@"; do
    case "$a" in
        --yes|-y) YES=1 ;;
        --no-bitcoin-restart) RESTART=0 ;;
        --wallets=*) WALLETS="${a#*=}" ;;
        --port=*) PORT="${a#*=}" ;;
        -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
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
UNIT="$ROOT/etc/systemd/system/$APP.service"
VERSION_FILE="$ROOT/home/bitcoin/.mynode/${APP}_version"
LOG_DIR="${TMPDIR:-/tmp}"
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
# myNode's loader (var/pynode/application_info.py) runs str.replace() on these manifest fields: a null there makes
# `mynode-manage-apps init` skip the whole app (v0.8.1 bug). Refuse such a manifest before touching anything.
LATEST="$(python3 - "$HERE/$APP/$APP.json" <<'PY'
import json, sys
try: a = json.load(open(sys.argv[1]))
except Exception as e: sys.exit(f"cannot parse {sys.argv[1]}: {e}")
bad = [k for k in ("short_name", "latest_version", "download_source_url") if k in a and not isinstance(a[k], str)]
bad += [f"download_binary_url.{k}" for k, v in (a.get("download_binary_url") or {}).items() if not isinstance(v, str)]
bad += [f"install_env_vars.{k}" for k, v in (a.get("install_env_vars") or {}).items() if not isinstance(v, str)]
bad += ["app_page_content" for s in a.get("app_page_content", []) for l in s.get("content", []) if not isinstance(l, str)][:1]
if bad: sys.exit("fields that must be strings for myNode's app loader: " + ", ".join(bad))
if a.get("download_skip") is not True: sys.exit("download_skip must be true (the docker image ships in app_data)")
print(a["latest_version"])
PY
)" || die "app manifest $APP/$APP.json is not loadable by myNode - re-download the package"

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
# Runs myNode's app manager and stops on any error it reports for this app (it often exits 0 even then).
manage() {   # $1 = what (for messages), rest = mynode-manage-apps args
    local what="$1"; shift
    local log="$LOG_DIR/btctrust-mynode-manage-apps-$1.log" rc=0
    "$MANAGE" "$@" 2>&1 | tee "$log" || rc=$?
    # lines that are errors for btctrust: ERROR/FAILED lines inside our "Found Application: btctrust" block,
    # or any ERROR/FAILED line naming btctrust
    local errs; errs="$(awk -v app="$APP" '/Found Application: /{cur=$NF} /ERROR|FAILED|Traceback/ && (cur==app || index($0, app)) {print}' "$log")"
    if [ -n "$errs" ] || [ "$rc" != 0 ]; then
        printf '\n' >&2
        [ -n "$errs" ] && printf '%s\n' "$errs" >&2
        # a broken definition would be re-loaded (and fail) on every myNode boot: take it out again
        [ "$what" = init ] && rm -rf "${APPS_DIR:?}/$APP" && echo "Removed ${APPS_DIR#$ROOT}/$APP again." >&2
        die "myNode's app manager failed during '$what' (mynode-manage-apps $*, exit $rc). The app was not started.
       Full output: $log
       If you are on BTC Trust v0.8.1 or older, download the latest release (see docs/mynode-install.md) and run this installer again."
    fi
    local other; other="$(grep -E 'ERROR' "$log" | grep -v "$APP" || true)"
    [ -z "$other" ] || warn "myNode reported errors for OTHER apps (not BTC Trust, ignored):
$other"
}
if [ "$USE_MANAGE" = 1 ]; then
    say "Registering the app with myNode (mynode-manage-apps init)"
    manage "init" init      # creates linux user btctrust (+docker group), service, nginx, scripts
    [ -f "$UNIT" ] || die "mynode-manage-apps init finished but did not install ${UNIT#$ROOT} - see $LOG_DIR/btctrust-mynode-manage-apps-init.log"
    echo "OK: myNode loaded the app (${UNIT#$ROOT} installed)"
fi

# ---------- 3. read-only RPC user ----------
say "Creating read-only RPC user '$RPC_USER'"
mkdir -p "$SETTINGS" "$DATA/app" "$DATA/testnode"
MAIN_PW="$(envget MAINNET_RPC_PASSWORD)"; [ -n "$MAIN_PW" ] || MAIN_PW="$(rand)"
TEST_PW="$(envget TESTNODE_RPC_PASSWORD)"; [ -n "$TEST_PW" ] || TEST_PW="$(rand)"
OLD_INCLUDE="$(cat "$INCLUDE" 2>/dev/null || true)"
RPCAUTH="$(RPC_PW="$MAIN_PW" OLD="$OLD_INCLUDE" python3 - "$RPC_USER" <<'PY'
import hmac, os, re, secrets, sys
user, pw = sys.argv[1], os.environ["RPC_PW"].encode()
# keep the existing line if it still matches the password (re-runs leave the file unchanged)
m = re.search(r"^rpcauth=" + re.escape(user) + r":([0-9a-f]+)\$([0-9a-f]{64})$", os.environ.get("OLD", ""), re.M)
if m and hmac.compare_digest(hmac.new(m.group(1).encode(), pw, "SHA256").hexdigest(), m.group(2)):
    print(m.group(0)); sys.exit()
salt = secrets.token_hex(16)
print(f"rpcauth={user}:{salt}${hmac.new(salt.encode(), pw, 'SHA256').hexdigest()}")
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
[ "$OLD_INCLUDE" = "$(cat "$INCLUDE")" ] && INCLUDE_CHANGED=0 || INCLUDE_CHANGED=1

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
if [ "$USE_MANAGE" = 1 ]; then
    say "Installing app (loading docker image, this takes a minute)"
    if [ -f "$ROOT/mnt/hdd/mynode/settings/install_$APP" ] || [ -f "$ROOT/home/bitcoin/.mynode/install_$APP" ]; then
        manage "install" reinstall "$APP"
    else
        manage "install" install "$APP"
    fi
    # myNode records the result in <app>_version: the version on success, "error" on failure
    GOT="$(cat "$VERSION_FILE" 2>/dev/null || echo missing)"
    [ "$GOT" = "$LATEST" ] || die "myNode's install step failed (${VERSION_FILE#$ROOT} = '$GOT', expected '$LATEST').
       Details: sudo journalctl -t mynode_manage_apps -n 100   and   $LOG_DIR/btctrust-mynode-manage-apps-install.log"
    echo "OK: myNode installed $APP $GOT"
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
RPC_OK=0
rpc_selfcheck() {
    [ "$(check_rpc getblockcount)" = 200 ] || return 1
    [ "$(check_rpc getwalletinfo)" = 403 ] || die "SAFETY CHECK FAILED: bitcoind did not refuse getwalletinfo for btctrust - not starting the app"
    echo "OK: btctrust can read the chain (getblockcount 200) and bitcoind refuses wallet calls (getwalletinfo 403)"
    RPC_OK=1
}
if [ "$SIM" != 1 ] && [ "$INCLUDE_CHANGED" = 0 ] && rpc_selfcheck; then
    echo "bitcoind already has this read-only user loaded - no bitcoind restart needed"
elif [ "$SIM" != 1 ] && [ "$RESTART" = 1 ]; then
    if ask "Restart bitcoind now to load the read-only user? (takes 1-10 min; Lightning apps reconnect afterwards)"; then
        systemctl restart bitcoin
        say "Waiting for bitcoind RPC"
        for _ in $(seq 1 120); do [ "$(check_rpc getblockcount)" = 200 ] && break; sleep 5; done
        rpc_selfcheck || die "bitcoind did not accept the btctrust user - see docs/mynode-install.md (Troubleshooting)"
    else
        RESTART=0
    fi
fi

# ---------- 7. enable + start ----------
if [ "$USE_MANAGE" = 1 ]; then
    say "Enabling and starting $APP"
    if [ ! -f "$UNIT" ] || { [ "$SIM" != 1 ] && ! systemctl cat "$APP.service" >/dev/null 2>&1; }; then
        die "${UNIT#$ROOT} is missing, so the app cannot be started. myNode did not register the app - re-run this installer and check its first error."
    fi
    if [ "$SIM" != 1 ]; then
        systemctl daemon-reload
        systemctl enable "$APP" >/dev/null 2>&1 || true
        touch "/mnt/hdd/mynode/settings/${APP}_enabled"
        if [ "$RPC_OK" = 1 ]; then
            systemctl restart "$APP"
            printf 'Waiting for the app to answer on port %s' "$PORT"
            for _ in $(seq 1 60); do curl -fs "http://127.0.0.1:$PORT/api/healthz" >/dev/null 2>&1 && break; printf .; sleep 3; done; echo
            if curl -fs "http://127.0.0.1:$PORT/api/healthz" >/dev/null 2>&1; then echo "OK: app is up"
            else warn "the app is not answering yet. Check: sudo systemctl status $APP   and   sudo journalctl -u $APP -n 50"; fi
        else
            echo "Not starting yet: the read-only RPC user is not active until bitcoind restarts."
        fi
    fi
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<DONE

Done.
  Open:   http://mynode.local:$PORT   (or http://${IP:-<mynode-ip>}:$PORT, or https://mynode.local:9331)
  First visit asks for the one-time SETUP TOKEN. It is shown on the myNode app page (Apps > BTC Trust >
  "App Default Credentials") or:  sudo cat ${DATA#$ROOT}/app/setup-token
  Then choose an app passphrase (12+ characters).
DONE
[ "$RPC_OK" = 0 ] && [ "$SIM" != 1 ] && warn "bitcoind was NOT restarted: run 'sudo systemctl restart bitcoin' then 'sudo systemctl restart $APP'."
exit 0
