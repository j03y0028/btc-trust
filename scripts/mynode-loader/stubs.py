# Stand-ins for myNode's hardware/daemon helper modules (bitcoin_info, device_info, systemctl_info, ...).
# application_info.py and utilities.py themselves are myNode's REAL code (fetched from mynodebtc/mynode).
import platform
def get_onion_url_for_service(short_name): return "NA"
def is_tor_remote_access_enabled(): return False
def get_local_ip(): return "192.168.1.50"
def get_debian_version(): return 12
def get_device_arch(): return platform.machine()
def is_service_enabled(name, force_refresh=False): return False
def clear_service_enabled_cache(): pass
def get_service_status_code(name): return 0
def get_service_status_color(name): return "gray"
def get_journalctl_log(name): return ""
def is_mynode_drive_mounted(): return True
def is_shutting_down(): return False
def is_testnet_enabled(): return False
def is_installing_docker_images(): return False
def is_upgrade_running(): return False
def get_bitcoin_log_file(): return ""
def disable_service(name): pass
def stop_service(name): pass
def start_service(name): pass
def restart_service(name): pass
