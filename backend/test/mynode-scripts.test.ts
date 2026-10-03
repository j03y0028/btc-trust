// Stage 8: myNode install/uninstall scripts, run.sh and the bundled test node guard (simulation mode, temp roots).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { READ_ONLY_METHODS, rpcWhitelistConf } from '../src/readonly-rpc.js';

const REPO = resolve(__dirname, '../..');
const ARCH = execFileSync('uname', ['-m'], { encoding: 'utf8' }).trim();
let tmp: string, pkg: string, root: string;

function makePackage() {
  pkg = join(tmp, 'pkg'); mkdirSync(pkg);
  cpSync(join(REPO, 'mynode/install-mynode.sh'), join(pkg, 'install-mynode.sh'));
  cpSync(join(REPO, 'mynode/uninstall-mynode.sh'), join(pkg, 'uninstall-mynode.sh'));
  cpSync(join(REPO, 'mynode/btctrust'), join(pkg, 'btctrust'), { recursive: true, filter: (s) => !/\.tar\.gz(\.sha256)?$/.test(s) });
  const img = join(pkg, 'btctrust/app_data', `btctrust-image-${ARCH}.tar.gz`);
  writeFileSync(img, 'fake image');
  writeFileSync(`${img}.sha256`, `${createHash('sha256').update('fake image').digest('hex')}  btctrust-image-${ARCH}.tar.gz\n`);
}
const run = (script: string, args: string[] = [], extra: Record<string, string> = {}) =>
  spawnSync('bash', [join(pkg, script), ...args], { encoding: 'utf8', env: { ...process.env, MYNODE_ROOT: root, MYNODE_SIM: '1', ...extra } });
const S = () => join(root, 'mnt/hdd/mynode/settings');

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'btctrust-mynode-')); root = join(tmp, 'root'); mkdirSync(join(root, 'mnt/hdd/mynode/settings'), { recursive: true }); makePackage(); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('install-mynode.sh', () => {
  it('whitelists exactly the methods the code allows', () => {
    const src = readFileSync(join(REPO, 'mynode/install-mynode.sh'), 'utf8');
    const list = /^RO_METHODS="([^"]+)"/m.exec(src)![1].split(',');
    expect(list).toEqual([...READ_ONLY_METHODS]);
    expect(rpcWhitelistConf('btctrust')).toContain(`rpcwhitelist=btctrust:${list.join(',')}`);
  });

  it('creates the read-only RPC user in an includeconf file, keeps user config, is idempotent', () => {
    writeFileSync(join(S(), 'bitcoin_post_config.conf'), '# mine\nmaxconnections=20');   // no trailing newline
    for (let i = 0; i < 2; i++) { const r = run('install-mynode.sh', ['--yes']); expect(r.status, r.stderr + r.stdout).toBe(0); }
    const post = readFileSync(join(S(), 'bitcoin_post_config.conf'), 'utf8');
    expect(post.startsWith('# mine\nmaxconnections=20\n')).toBe(true);
    expect(post.match(/^includeconf=/gm)).toHaveLength(1);
    expect(post).toContain(`includeconf=${join(S(), 'btctrust_bitcoin.conf')}`);
    const inc = readFileSync(join(S(), 'btctrust_bitcoin.conf'), 'utf8');
    expect(inc).toMatch(/^rpcauth=btctrust:[0-9a-f]{32}\$[0-9a-f]{64}$/m);
    expect(inc).toContain(`rpcwhitelist=btctrust:${READ_ONLY_METHODS.join(',')}`);
    expect(inc).toMatch(/^rpcwhitelistdefault=0$/m);
    expect(inc).not.toMatch(/rpcauth=mynode/);
    expect(statSync(join(S(), 'btctrust_bitcoin.conf')).mode & 0o777).toBe(0o640);
    const envPath = join(root, 'mnt/hdd/mynode/btctrust/btctrust.env');
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    const env = readFileSync(envPath, 'utf8');
    expect(env).toMatch(/^MAINNET_RPC_USER=btctrust$/m);
    expect(env).toMatch(/^MAINNET_RPC_EXPECT_CHAIN=main$/m);
    expect(env).toMatch(/^WALLET_CHAIN=regtest$/m);
    // rpcauth hash matches the stored password (Bitcoin Core's rpcauth.py algorithm)
    const pw = /^MAINNET_RPC_PASSWORD=(.+)$/m.exec(env)![1];
    const [, salt, hash] = /rpcauth=btctrust:([0-9a-f]+)\$([0-9a-f]+)/.exec(inc)!;
    expect(createHmac('sha256', salt).update(pw).digest('hex')).toBe(hash);
    // re-install keeps the password (bitcoind + app stay in sync)
    expect(existsSync(join(root, 'usr/share/mynode_apps/btctrust/btctrust.json'))).toBe(true);
  });

  it('never edits bitcoin_custom.conf, and prints the line to add instead', () => {
    writeFileSync(join(S(), 'bitcoin_custom.conf'), 'server=1\n');
    const r = run('install-mynode.sh', ['--yes']);
    expect(r.status).toBe(0);
    expect(readFileSync(join(S(), 'bitcoin_custom.conf'), 'utf8')).toBe('server=1\n');
    expect(r.stderr).toMatch(/bitcoin_custom\.conf exists/);
    expect(r.stdout).toContain('includeconf=/mnt/hdd/mynode/settings/btctrust_bitcoin.conf');
  });

  it('refuses mainnet wallets, bad images and unknown options', () => {
    expect(run('install-mynode.sh', ['--yes', '--wallets=main']).status).toBe(2);
    expect(run('install-mynode.sh', ['--yes', '--bogus']).status).toBe(2);
    writeFileSync(join(pkg, 'btctrust/app_data', `btctrust-image-${ARCH}.tar.gz`), 'tampered');
    const r = run('install-mynode.sh', ['--yes']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/checksum mismatch/);
  });

  it('--wallets=off disables wallet features', () => {
    expect(run('install-mynode.sh', ['--yes', '--wallets=off']).status).toBe(0);
    expect(readFileSync(join(root, 'mnt/hdd/mynode/btctrust/btctrust.env'), 'utf8')).toMatch(/^WALLET_FEATURES=off$/m);
  });
});

// The app-manager steps (mynode-manage-apps init/install) with a fake manager, driven by MYNODE_MANAGE_APPS.
// v0.8.1 regression: myNode's loader printed an ERROR for btctrust but exited 0, the installer carried on, and
// ended with "Unit btctrust.service not found".
const JOEY_INIT_OUTPUT = [
  'Found Application: albyhub', ' Loading albyhub...', ' Done.',
  'Found Application: btctrust', "  ERROR: Error loading btctrust.json file ('NoneType' object has no attribute 'replace')",
].join('\n');
function fakeManager(opts: { initOutput?: string; initUnit?: boolean; version?: string; initExit?: number }) {
  const f = join(tmp, 'fake-mynode-manage-apps');
  writeFileSync(f, `#!/bin/bash
echo "$*" >> "${tmp}/manage.calls"
case "$1" in
  init) cat <<'OUT'
${opts.initOutput ?? 'Found Application: btctrust\n Loading btctrust...\n Done.'}
OUT
        ${opts.initUnit === false ? '' : 'mkdir -p "$MYNODE_ROOT/etc/systemd/system" && touch "$MYNODE_ROOT/etc/systemd/system/btctrust.service"'}
        exit ${opts.initExit ?? 0} ;;
  install|reinstall) mkdir -p "$MYNODE_ROOT/home/bitcoin/.mynode"; touch "$MYNODE_ROOT/home/bitcoin/.mynode/install_btctrust"
        printf '%s' '${opts.version ?? '__LATEST__'}' > "$MYNODE_ROOT/home/bitcoin/.mynode/btctrust_version" ;;
esac
`.replace('__LATEST__', JSON.parse(readFileSync(join(REPO, 'mynode/btctrust/btctrust.json'), 'utf8')).latest_version));
  chmod(f);
  return { MYNODE_MANAGE_APPS: f, TMPDIR: tmp };
}
const chmod = (f: string) => chmodSync(f, 0o755);
const calls = () => (existsSync(join(tmp, 'manage.calls')) ? readFileSync(join(tmp, 'manage.calls'), 'utf8').trim().split('\n') : []);

describe('install-mynode.sh with myNode app manager', () => {
  it('stops at init when myNode reports an ERROR for btctrust (exit 0), removes the broken definition, touches nothing else', () => {
    const r = run('install-mynode.sh', ['--yes'], fakeManager({ initOutput: JOEY_INIT_OUTPUT, initUnit: false }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("myNode's app manager failed during 'init'");
    expect(r.stderr).toContain("'NoneType' object has no attribute 'replace'");
    expect(calls()).toEqual(['init']);                                     // never got to install
    expect(existsSync(join(root, 'usr/share/mynode_apps/btctrust'))).toBe(false);
    expect(existsSync(join(S(), 'btctrust_bitcoin.conf'))).toBe(false);    // no RPC user, no bitcoind change
  });
  it('stops when init exits non-zero', () => {
    const r = run('install-mynode.sh', ['--yes'], fakeManager({ initExit: 3 }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('exit 3');
  });
  it('only warns about ERRORs that belong to other apps', () => {
    const r = run('install-mynode.sh', ['--yes'], fakeManager({ initOutput: 'Found Application: lndg\n  ERROR: Error loading lndg.json file (x)\nFound Application: btctrust\n Loading btctrust...\n Done.' }));
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(r.stderr).toContain('OTHER apps');
  });
  it('stops when init does not install btctrust.service', () => {
    const r = run('install-mynode.sh', ['--yes'], fakeManager({ initUnit: false }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/did not install \/etc\/systemd\/system\/btctrust\.service/);
  });
  it('stops when myNode records the install as failed', () => {
    const r = run('install-mynode.sh', ['--yes'], fakeManager({ version: 'error' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("install step failed");
    expect(r.stderr).toContain("= 'error'");
  });
  it('installs, then a re-run uses reinstall and leaves the RPC user file byte-identical (no bitcoind restart needed)', () => {
    const env = fakeManager({});
    const a = run('install-mynode.sh', ['--yes'], env);
    expect(a.status, a.stderr + a.stdout).toBe(0);
    const inc1 = readFileSync(join(S(), 'btctrust_bitcoin.conf'), 'utf8');
    const b = run('install-mynode.sh', ['--yes', '--no-bitcoin-restart'], env);
    expect(b.status, b.stderr + b.stdout).toBe(0);
    expect(readFileSync(join(S(), 'btctrust_bitcoin.conf'), 'utf8')).toBe(inc1);
    expect(calls()).toEqual(['init', 'install btctrust', 'init', 'reinstall btctrust']);
    expect(readFileSync(join(S(), 'bitcoin_post_config.conf'), 'utf8').match(/^includeconf=/gm)).toHaveLength(1);
  });
  it('refuses a manifest myNode cannot load (null download_source_url, as in v0.8.1) before changing anything', () => {
    const j = join(pkg, 'btctrust/btctrust.json');
    writeFileSync(j, readFileSync(j, 'utf8').replace(/"download_source_url": "[^"]*"/, '"download_source_url": null'));
    const r = run('install-mynode.sh', ['--yes'], fakeManager({}));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not loadable by myNode');
    expect(r.stderr).toContain('download_source_url');
    expect(calls()).toEqual([]);
  });
});

describe('recovery from the v0.8.1 half-install (Joey\'s myNode)', () => {
  it('v0.8.1 left RPC user + env + broken app definition: the new installer finishes with no bitcoind change', () => {
    // 1. what v0.8.1's installer had already done (its RPC/env steps worked): run the real v0.8.1 script from git
    const old = join(tmp, 'old'); mkdirSync(old);
    const show = (path: string) => execFileSync('git', ['-C', REPO, 'show', `v0.8.1:${path}`], { encoding: 'utf8' });
    writeFileSync(join(old, 'install-mynode.sh'), show('mynode/install-mynode.sh'));
    cpSync(join(pkg, 'btctrust'), join(old, 'btctrust'), { recursive: true });
    writeFileSync(join(old, 'btctrust/btctrust.json'), show('mynode/btctrust/btctrust.json'));
    const o = spawnSync('bash', [join(old, 'install-mynode.sh'), '--yes'], { encoding: 'utf8', env: { ...process.env, MYNODE_ROOT: root, MYNODE_SIM: '1' } });
    expect(o.status, o.stderr).toBe(0);
    // 2. what myNode's failed init/install left behind
    const mn = join(root, 'home/bitcoin/.mynode'); mkdirSync(mn, { recursive: true });
    writeFileSync(join(mn, 'install_btctrust'), ''); writeFileSync(join(mn, 'btctrust_version'), 'error');
    mkdirSync(join(root, 'opt/mynode/btctrust'), { recursive: true });
    const inc = readFileSync(join(S(), 'btctrust_bitcoin.conf'), 'utf8');
    const env = readFileSync(join(root, 'mnt/hdd/mynode/btctrust/btctrust.env'), 'utf8');
    expect(readFileSync(join(root, 'usr/share/mynode_apps/btctrust/btctrust.json'), 'utf8')).toContain('"download_source_url": null');
    // 3. the recovery command
    const r = run('install-mynode.sh', ['--no-bitcoin-restart', '--yes'], fakeManager({}));
    expect(r.status, r.stderr + r.stdout).toBe(0);
    expect(calls()).toEqual(['init', 'reinstall btctrust']);      // install marker present -> reinstall
    expect(readFileSync(join(S(), 'btctrust_bitcoin.conf'), 'utf8')).toBe(inc);   // same rpcauth: bitcoind's loaded user still valid
    expect(readFileSync(join(root, 'mnt/hdd/mynode/btctrust/btctrust.env'), 'utf8')).toBe(env);
    expect(readFileSync(join(S(), 'bitcoin_post_config.conf'), 'utf8').match(/^includeconf=/gm)).toHaveLength(1);
    expect(readFileSync(join(root, 'usr/share/mynode_apps/btctrust/btctrust.json'), 'utf8')).not.toContain('null');
  });
});

describe('uninstall-mynode.sh', () => {
  it('removes the RPC user and app folder, keeps data unless --purge', () => {
    writeFileSync(join(S(), 'bitcoin_post_config.conf'), '# mine\n');
    expect(run('install-mynode.sh', ['--yes']).status).toBe(0);
    let r = run('uninstall-mynode.sh', ['--yes']);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(S(), 'bitcoin_post_config.conf'), 'utf8')).toBe('# mine\n');
    expect(existsSync(join(S(), 'btctrust_bitcoin.conf'))).toBe(false);
    expect(existsSync(join(root, 'usr/share/mynode_apps/btctrust'))).toBe(false);
    expect(existsSync(join(root, 'mnt/hdd/mynode/btctrust/btctrust.env'))).toBe(true);
    r = run('uninstall-mynode.sh', ['--yes', '--purge']);
    expect(r.status).toBe(0);
    expect(existsSync(join(root, 'mnt/hdd/mynode/btctrust'))).toBe(false);
  });
});

describe('run.sh / btctrust-testnode guards', () => {
  it('run.sh refuses a mainnet wallet chain before touching docker', () => {
    const data = join(tmp, 'data'); mkdirSync(data);
    writeFileSync(join(data, 'btctrust.env'), 'WALLET_CHAIN=main\nTESTNODE_RPC_PASSWORD=x\n');
    const bin = join(tmp, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\necho "$@" >> ${join(tmp, 'docker-calls')}\n`); chmodSync(join(bin, 'docker'), 0o755);
    const r = spawnSync('bash', [join(REPO, 'mynode/btctrust/app_data/run.sh'), 'start'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, BTCTRUST_DATA: data } });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/regtest or signet/);
    expect(existsSync(join(tmp, 'docker-calls'))).toBe(false);
  });

  it.each(['main', 'mainnet', 'test', 'bogus'])('btctrust-testnode refuses chain %j', (chain) => {
    const bin = join(tmp, 'bin'); mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'bitcoind'), `#!/bin/sh\ntouch ${join(tmp, 'bitcoind-ran')}\n`); chmodSync(join(bin, 'bitcoind'), 0o755);
    const r = spawnSync('sh', [join(REPO, 'docker/testnode.sh')], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TESTNODE_CHAIN: chain, TESTNODE_RPC_USER: 'u', TESTNODE_RPC_PASSWORD: 'p', TESTNODE_DATADIR: join(tmp, 'tn') } });
    expect(r.status).toBe(1);
    expect(existsSync(join(tmp, 'bitcoind-ran'))).toBe(false);
  });
});
