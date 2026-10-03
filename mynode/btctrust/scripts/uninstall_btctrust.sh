#!/bin/bash
source /usr/share/mynode/mynode_device_info.sh
source /usr/share/mynode/mynode_app_versions.sh
source /usr/share/mynode/mynode_functions.sh

echo "==================== UNINSTALLING APP ===================="
# Containers, network and images. Data on /mnt/hdd/mynode/btctrust is kept (uninstall-mynode.sh --purge removes it).
bash /opt/mynode/btctrust/app_data/run.sh stop || true
docker network rm btctrust-internal 2>/dev/null || true
remove_docker_images_by_name 'btctrust' || true
echo "================== DONE UNINSTALLING APP ================="
