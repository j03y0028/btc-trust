#!/bin/bash
# BTC Trust - myNode uninstaller.  sudo ./uninstall-mynode.sh [--yes] [--purge] [--no-bitcoin-restart]
#   default : stops/uninstalls the app, removes its docker images, the app definition and the read-only RPC user
#             (includeconf line + btctrust_bitcoin.conf). App data in /mnt/hdd/mynode/btctrust is KEPT.
#   --purge : also deletes /mnt/hdd/mynode/btctrust (test wallets, vault metadata, snapshots, app login). Asks you to type DELETE.
set -euo pipefail
APP=btctrust
ROOT="${MYNODE_ROOT:-}"; SIM="${MYNODE_SIM:-0}"
YES=0; PURGE=0; RESTART=1
for a in "$@"; do
    case "$a" in
        --yes|-y) YES=1 ;; --purge) PURGE=1 ;; --no-bitcoin-restart) RESTART=0 ;;
        -h|--help) sed -n '2,6p' "$0"; exit 0 ;; *) echo "unknown option: $a" >&2; exit 2 ;;
    esac
done
SETTINGS="$ROOT/mnt/hdd/mynode/settings"
DATA="$ROOT/mnt/hdd/mynode/$APP"
INCLUDE="$SETTINGS/${APP}_bitcoin.conf"
POST="$SETTINGS/bitcoin_post_config.conf"
MARK_BEGIN="# >>> btctrust read-only RPC user (managed by install-mynode.sh) >>>"
MARK_END="# <<< btctrust <<<"
ask() { [ "$YES" = 1 ] && return 0; read -r -p "$1 [y/N] " r; [[ "$r" =~ ^[Yy] ]]; }
[ "$SIM" = 1 ] || [ "$(id -u)" = 0 ] || { echo "run as root: sudo $0" >&2; exit 1; }
ask "Uninstall BTC Trust?" || { echo aborted; exit 1; }

if [ "$SIM" != 1 ]; then
    echo "== Uninstalling app (stops containers, removes images)"
    mynode-manage-apps uninstall "$APP" || true          # runs scripts/uninstall_btctrust.sh, disables service
    systemctl stop "$APP" 2>/dev/null || true
    rm -f "/mnt/hdd/mynode/settings/${APP}_enabled"
    # Mirror myNode's remove_app(): drop the app definition and the files `mynode-manage-apps init` installed.
    rm -rf "/usr/share/mynode_apps/$APP" "/opt/mynode/$APP"
    rm -f "/etc/systemd/system/$APP.service" /usr/bin/service_scripts/*_"$APP".sh \
          "/etc/nginx/sites-enabled/https_$APP.conf"
    systemctl daemon-reload || true
    nginx -t >/dev/null 2>&1 && systemctl reload nginx || true
    docker rm -f "$APP" "$APP-testnode" >/dev/null 2>&1 || true
    docker network rm "$APP-internal" >/dev/null 2>&1 || true
    docker images --format '{{.Repository}}:{{.Tag}}' | grep "^$APP:" | xargs -r docker rmi >/dev/null 2>&1 || true
else
    rm -rf "$ROOT/usr/share/mynode_apps/$APP"
fi

echo "== Removing the read-only RPC user"
if [ -f "$POST" ]; then
    sed -i "\|^${MARK_BEGIN}\$|,\|^${MARK_END}\$|d" "$POST"
fi
rm -f "$INCLUDE"

if [ "$PURGE" = 1 ]; then
    echo "--purge deletes $DATA (test wallets, vault metadata, daily snapshots, app login)."
    if [ "$YES" = 1 ] || { read -r -p "Type DELETE to confirm: " r; [ "$r" = DELETE ]; }; then
        rm -rf "${DATA:?}"; echo "deleted $DATA"
    else
        echo "kept $DATA"
    fi
else
    echo "Kept app data in $DATA (re-run with --purge to delete it)."
fi

if [ "$SIM" != 1 ] && [ "$RESTART" = 1 ] && ask "Restart bitcoind now so the btctrust RPC user is gone?"; then
    systemctl restart bitcoin
else
    echo "The btctrust RPC user disappears at the next bitcoind restart (sudo systemctl restart bitcoin)."
fi
echo "BTC Trust uninstalled."
