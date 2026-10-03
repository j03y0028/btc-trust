#!/bin/bash
# Runs as the "btctrust" user inside /opt/mynode/btctrust (app_data/ already copied there by mynode-manage-apps).

source /usr/share/mynode/mynode_device_info.sh
source /usr/share/mynode/mynode_app_versions.sh
source /usr/share/mynode/mynode_functions.sh

set -x
set -e

echo "==================== INSTALLING APP ===================="

ARCH=$(uname -m)                       # aarch64 (Raspberry Pi / RockPro64) or x86_64
IMG_TAR="app_data/btctrust-image-${ARCH}.tar.gz"
VERSION_TAG="${VERSION:-v0.8.2}"

mkdir -p /mnt/hdd/mynode/btctrust/app /mnt/hdd/mynode/btctrust/testnode
chmod 700 /mnt/hdd/mynode/btctrust /mnt/hdd/mynode/btctrust/app /mnt/hdd/mynode/btctrust/testnode

# This app is not on a registry: the image ships inside the app package (built by scripts/package-mynode.sh).
if [ ! -f "$IMG_TAR" ]; then
    echo "Missing $IMG_TAR - rebuild the package for $ARCH (scripts/package-mynode.sh)"; exit 1
fi
if [ -f "$IMG_TAR.sha256" ]; then
    (cd app_data && sha256sum -c "$(basename "$IMG_TAR").sha256")
fi
remove_docker_images_by_name 'btctrust:' || true
LOADED=$(docker load -i "$IMG_TAR" | sed -n 's/^Loaded image: //p' | tail -1)
[ -n "$LOADED" ] || { echo "docker load did not report an image"; exit 1; }
docker tag "$LOADED" btctrust:latest
docker tag "$LOADED" "btctrust:${VERSION_TAG#v}"

echo "================== DONE INSTALLING APP ================="
