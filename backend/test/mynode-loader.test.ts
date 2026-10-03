// Loads mynode/btctrust through myNode's REAL dynamic-app loader (var/pynode/application_info.py from the current
// mynodebtc/mynode master, or MYNODE_REF) in a throwaway container: `mynode-manage-apps init` + `install` paths.
// v0.8.1 shipped "download_source_url": null, which this loader cannot handle (None.replace at application_info.py:270).
// Needs docker + network for the first fetch; skipped without docker unless REQUIRE_MYNODE_LOADER=1 (set in CI).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(__dirname, '../..');
const dockerOk = () => spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
  || spawnSync('sg', ['docker', '-c', 'docker info'], { stdio: 'ignore' }).status === 0;
const HAVE = dockerOk();
if (!HAVE && process.env.REQUIRE_MYNODE_LOADER === '1') throw new Error('REQUIRE_MYNODE_LOADER=1 but docker is not available');

type Result = { ok: boolean; errors: string[]; checks: Record<string, boolean>; app_fields?: Record<string, unknown>;
  install_cmds?: string[]; installed_version?: string; docker_calls?: string[] };
function load(appDir: string, env: Record<string, string> = {}): Result {
  const r = spawnSync('bash', [join(REPO, 'scripts/mynode-loader/run.sh'), appDir], { encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 64 << 20 });
  const line = r.stdout.split('\n').reverse().find((l) => l.startsWith('MYNODE_LOADER_RESULT '));
  if (!line) throw new Error(`no loader result (exit ${r.status}):\n${r.stderr}\n${r.stdout.slice(-3000)}`);
  return JSON.parse(line.slice('MYNODE_LOADER_RESULT '.length));
}
// copy of the app folder without the (large, optional) image tarballs
function appCopy(tmp: string, edit?: (json: string) => string) {
  const dst = join(tmp, 'btctrust');
  cpSync(join(REPO, 'mynode/btctrust'), dst, { recursive: true, filter: (s) => !/\.tar\.gz(\.sha256)?$/.test(s) });
  if (edit) writeFileSync(join(dst, 'btctrust.json'), edit(readFileSync(join(dst, 'btctrust.json'), 'utf8')));
  return dst;
}

describe.skipIf(!HAVE)("myNode's real app loader (mynodebtc/mynode master)", () => {
  let tmp: string;
  beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), "btctrust-loader-")); });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('loads btctrust.json, installs the service/scripts/nginx, skips the download and installs v-latest', () => {
    const r = load(appCopy(join(tmp)));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    const manifest = JSON.parse(readFileSync(join(REPO, 'mynode/btctrust/btctrust.json'), 'utf8'));
    expect(r.app_fields).toMatchObject({ name: 'BTC Trust', linux_user: 'btctrust', download_skip: true, is_supported: true, latest_version: manifest.latest_version });
    expect(r.checks['/etc/systemd/system/btctrust.service']).toBe(true);
    expect(r.install_cmds!.some((c) => c.startsWith('wget '))).toBe(false);
    expect(r.install_cmds).toContain('cp -r -f /usr/share/mynode_apps/btctrust/app_data /opt/mynode/btctrust/app_data');
    // myNode ran scripts/install_btctrust.sh as the app user and recorded success
    expect(r.installed_version).toBe(manifest.latest_version);
    expect(r.docker_calls!.some((c) => /^btctrust: docker load -i app_data\/btctrust-image-(x86_64|aarch64)\.tar\.gz$/.test(c))).toBe(true);
  }, 600_000);

  it('reproduces the v0.8.1 failure: download_source_url null -> NoneType.replace, wget not_specified, no service', () => {
    const r = load(appCopy(join(tmp, 'v081'), (j) => j.replace(/"download_source_url": "[^"]*"/, '"download_source_url": null')));
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toContain("Error loading btctrust.json file ('NoneType' object has no attribute 'replace')");
    expect(r.errors.join('\n')).toContain('wget -O /tmp/mynode_dynamic_app_download/app.tar.gz not_specified');
    expect(r.checks['/etc/systemd/system/btctrust.service']).toBe(false);
  }, 600_000);

  it("control: myNode's own albyhub app loads cleanly with the same harness", () => {
    const r = load(join(REPO, 'build/mynode-src/rootfs/standard/usr/share/mynode_apps/albyhub'), { LOADER_SKIP_INSTALL: '1' });
    expect(r.errors).toEqual([]);
  }, 600_000);
});
