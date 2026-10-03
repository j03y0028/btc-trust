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
