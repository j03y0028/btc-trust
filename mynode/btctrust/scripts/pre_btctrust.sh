#!/bin/bash
# Runs before the service starts. First run: create a one-time setup token and show it on the myNode app page
# ("App Default Credentials"); once the app passphrase is set the page just says it is user-managed.
source /usr/share/mynode/mynode_functions.sh

DATA=/mnt/hdd/mynode/btctrust
mkdir -p "$DATA/app" "$DATA/testnode"
if [ -f "$DATA/app/auth.json" ]; then
    save_app_password_user_set btctrust
else
    if [ ! -s "$DATA/app/setup-token" ]; then
        (umask 077; head -c 15 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n' > "$DATA/app/setup-token")
    fi
    save_app_default_password btctrust "$(cat "$DATA/app/setup-token")"
fi
if [ ! -f "$DATA/btctrust.env" ]; then
    echo "pre_btctrust: $DATA/btctrust.env is missing - run install-mynode.sh (it sets up the read-only RPC user)" >&2
    exit 1
fi
