#!/usr/bin/env python3
"""Load an app folder through myNode's REAL dynamic-app loader (var/pynode/application_info.py) the way
`mynode-manage-apps init` and `install` do, inside a throwaway container (real absolute paths, as root).
Usage: harness.py <mynode_rootfs_standard> <app_dir>     Prints a "MYNODE_LOADER_RESULT {json}" line; exit 0 = loaded cleanly."""
import json, os, shutil, sys, types, logging, subprocess
ref, app_src = sys.argv[1], sys.argv[2].rstrip("/")
name = os.path.basename(app_src)
here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
import stubs
# modules application_info / utilities import that we replace (hardware, daemons, flask/requests)
for m in ["bitcoin_info", "lightning_info", "electrum_info", "dojo_info", "device_info", "drive_info",
          "systemctl_info", "enable_disable_functions"]:
    mod = types.ModuleType(m); mod.__dict__.update({k: v for k, v in vars(stubs).items() if not k.startswith("__")})
    sys.modules[m] = mod
flask = types.ModuleType("flask"); flask.send_from_directory = lambda *a, **k: None; sys.modules["flask"] = flask
sys.modules.setdefault("requests", types.ModuleType("requests"))
sys.path.insert(0, os.path.join(ref, "var/pynode"))
import application_info as ai

logs, cmds = [], []
class H(logging.Handler):
    def emit(self, r): logs.append(r.getMessage())
lg = logging.getLogger("mynode"); lg.addHandler(H()); lg.setLevel(logging.INFO); ai.set_logger(lg)
real_run = ai.run_linux_cmd
def run(cmd, ignore_failure=False, print_command=False):
    cmds.append(cmd)
    if cmd.startswith("wget "):     # never touch the network; a wget means the loader wanted to download
        raise Exception("wget attempted: " + cmd)
    return real_run(cmd, ignore_failure, print_command)
ai.run_linux_cmd = run

# myNode filesystem layout the loader copies into
for d in ["/usr/share/mynode_apps", "/usr/share/mynode", "/etc/systemd/system", "/usr/bin/service_scripts",
          "/etc/nginx/sites-enabled", "/var/www/mynode/static/images/app_icons", "/var/www/mynode/app",
          "/var/www/mynode/templates", "/home/bitcoin/.mynode", "/mnt/hdd/mynode/settings", "/opt/mynode", "/var/lib/tor"]:
    os.makedirs(d, exist_ok=True)
# myNode system scripts the loader shells out to (tor config regen, version files): no-ops here
for sh in ["/usr/bin/mynode_gen_tor_config.sh", "/usr/bin/mynode_update_latest_version_files.sh"]:
    with open(sh, "w") as f: f.write("#!/bin/sh\nexit 0\n")
    os.chmod(sh, 0o755)
shutil.copy(os.path.join(ref, "usr/share/mynode/application_info.json"), "/usr/share/mynode/application_info.json")
subprocess.call(["groupadd", "-f", "docker"])
subprocess.call(["useradd", "-m", "-U", "bitcoin"], stderr=subprocess.DEVNULL)   # exists on every myNode
shutil.rmtree(f"/usr/share/mynode_apps/{name}", ignore_errors=True)
shutil.copytree(app_src, f"/usr/share/mynode_apps/{name}")

res = {"app": name, "errors": [], "checks": {}}
# 1) `mynode-manage-apps init`
ai.init_dynamic_apps(name)
res["init_log"] = [l for l in logs]
res["errors"] += [l for l in logs if "ERROR" in l]
for f in [f"/etc/systemd/system/{name}.service", f"/usr/bin/service_scripts/install_{name}.sh",
          f"/usr/bin/service_scripts/uninstall_{name}.sh", f"/etc/nginx/sites-enabled/https_{name}.conf",
          f"/var/www/mynode/app/{name}/{name}.py", f"/var/www/mynode/static/images/app_icons/{name}.png"]:
    res["checks"][f] = os.path.isfile(f)
# 2) app list as the web UI / installer sees it (initialize_applications)
logs.clear()
ai.clear_application_cache()
app = ai.get_application(name)
res["errors"] += [l for l in logs if "ERROR" in l]
if app is None:
    res["errors"].append("app not in get_all_applications()")
else:
    if "error" in app: res["errors"].append(app["error"])
    res["app_fields"] = {k: app.get(k) for k in ["name", "latest_version", "linux_user", "download_skip", "download_type",
                         "download_source_url", "download_binary_url", "http_port", "https_port", "supported_archs",
                         "requires_docker_image_installation", "is_supported", "not_supported_reason"]}
    if app.get("is_supported") is False: res["errors"].append("not supported: " + str(app.get("not_supported_reason")))
    # 3) the download/extract step of `mynode-manage-apps install` (install_application_tarball)
    logs.clear(); cmds.clear()
    try:
        subprocess.call(["useradd", "-m", app["linux_user"]], stderr=subprocess.DEVNULL)
        ai.create_application_folders(app)
        ai.install_application_tarball(app)
    except Exception as e:
        res["errors"].append("install_application_tarball: " + str(e))
    res["install_cmds"] = cmds[:]
    if any(c.startswith("wget ") for c in cmds): res["errors"].append("loader tried to download: " + [c for c in cmds if c.startswith("wget ")][0])
    for f in (os.listdir(f"{app_src}/app_data") if os.path.isdir(f"{app_src}/app_data") else []):
        res["checks"][f"/opt/mynode/{name}/app_data/{f}"] = os.path.exists(f"/opt/mynode/{name}/app_data/{f}")
# 4) the full `mynode-manage-apps install <app>` path: mark installed + upgrade_dynamic_apps, which runs the app's
#    scripts/install_<app>.sh as its linux user (docker is a recorder here; sudo -u maps to setpriv).
if app is not None and os.environ.get("LOADER_SKIP_INSTALL") != "1":
    fake = "/usr/local/bin"
    with open(f"{fake}/docker", "w") as f:
        f.write('#!/bin/sh\necho "$(id -un): docker $*" >> /tmp/docker.log\n'
                'case "$1" in load) echo "Loaded image: %s:fake";; images) ;; esac\nexit 0\n' % name)
    with open(f"{fake}/sudo", "w") as f:   # sudo -u USER --preserve-env HOME=X cmd...  ->  setpriv as USER
        f.write('#!/bin/bash\n[ "$1" = -u ] || exit 97\nu=$2; shift 2; [ "$1" = --preserve-env ] && shift\n'
                'exec setpriv --reuid "$u" --regid "$(id -g "$u")" --init-groups env "$@"\n')
    for sh in ["mynode_device_info.sh", "mynode_app_versions.sh"]:
        open(f"/usr/share/mynode/{sh}", "w").write("# stub\n")
    open("/usr/share/mynode/mynode_functions.sh", "w").write(
        "remove_docker_images_by_name() { docker images --format '{{.Repository}}:{{.Tag}}' | grep \"^$1\" | xargs -r docker rmi || true; }\n")
    for f in os.listdir(fake): os.chmod(f"{fake}/{f}", 0o755)
    # CI checkouts have no image tarballs (built by package-mynode.sh): use a small stand-in so the script's sha256 check runs
    import platform, hashlib
    ad = f"/usr/share/mynode_apps/{name}/app_data"
    img = f"{ad}/{name}-image-{platform.machine()}.tar.gz"
    if os.path.isdir(ad) and name == "btctrust" and not os.path.isfile(img):
        open(img, "wb").write(b"stand-in image")
        open(img + ".sha256", "w").write(hashlib.sha256(b"stand-in image").hexdigest() + "  " + os.path.basename(img) + "\n")
    logs.clear()
    ai.clear_application_cache(); ai.mark_app_installed(name); ai.upgrade_dynamic_apps(name)
    res["install_log"] = logs[:]
    vf = f"/home/bitcoin/.mynode/{name}_version"
    ver = ai.to_string(ai.get_file_contents(vf)).strip() if os.path.isfile(vf) else "missing"
    res["installed_version"] = ver
    res["docker_calls"] = open("/tmp/docker.log").read().splitlines() if os.path.isfile("/tmp/docker.log") else []
    if ver != app["latest_version"]:
        res["errors"].append(f"install failed: {name}_version={ver!r} (expected {app['latest_version']}); " + " | ".join(l for l in logs if "FAIL" in l or "ERROR" in l))
missing = [f for f, ok in res["checks"].items() if not ok]
if missing: res["errors"].append("missing after init/install: " + ", ".join(missing))
res["ok"] = not res["errors"]
print("MYNODE_LOADER_RESULT " + json.dumps(res))
sys.exit(0 if res["ok"] else 1)
