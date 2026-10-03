import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { BitcoinRpc } from '../src/rpc.js';
import { ChainService } from '../src/service.js';
import { READ_ONLY_METHODS, ReadOnlyRpc, ReadOnlyViolation, TestChainRpc, rpcWhitelistConf, rpcauthLine } from '../src/readonly-rpc.js';

/**
 * A real bitcoind (regtest) configured the way install-mynode.sh configures myNode's bitcoind:
 * a dedicated "btctrust" rpcauth user + rpcwhitelist in a separate includeconf file, rpcwhitelistdefault=0,
 * and an unrestricted "mynode" user standing in for myNode's own RPC user.
 */
const BITCOIND = process.env.BITCOIND ?? '/usr/local/bin/bitcoind';
const freePort = () => new Promise<number>((res) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });

async function startNode(opts: { whitelistDefault0: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), 'btctrust-ro-node-'));
  const rpcPort = await freePort();
  const include = join(dir, 'btctrust_rpc.conf');
  writeFileSync(include, `${await rpcauthLine('btctrust', 'ro-secret')}\n${opts.whitelistDefault0 ? rpcWhitelistConf('btctrust') : `rpcwhitelist=btctrust:${READ_ONLY_METHODS.join(',')}\n`}`);
  writeFileSync(join(dir, 'bitcoin.conf'), [
    'regtest=1', 'server=1', 'listen=0', 'disablewallet=0', 'fallbackfee=0.0001',
    await rpcauthLine('mynode', 'mynode-secret'),
    `includeconf=${include}`,
    '[regtest]', `rpcport=${rpcPort}`, 'rpcbind=127.0.0.1', 'rpcallowip=127.0.0.1', '',
  ].join('\n'));
  const proc = spawn(BITCOIND, [`-datadir=${dir}`, '-printtoconsole=0'], { stdio: 'ignore' });
  const mynode = new BitcoinRpc({ rpcHost: '127.0.0.1', rpcPort, rpcUser: 'mynode', rpcPassword: 'mynode-secret', rpcTimeoutMs: 5000 });
  const btctrust = new BitcoinRpc({ rpcHost: '127.0.0.1', rpcPort, rpcUser: 'btctrust', rpcPassword: 'ro-secret', rpcTimeoutMs: 5000 });
  for (let i = 0; i < 100; i++) {
    try { await btctrust.call('getblockcount'); break; } catch (e) { if (i === 99) throw e; await new Promise((r) => setTimeout(r, 150)); }
  }
  return { dir, rpcPort, proc, mynode, btctrust };
}
async function stopNode(n: { proc: ChildProcess; dir: string }) {
  await new Promise<void>((res) => { n.proc.once('exit', () => res()); n.proc.kill('SIGTERM'); setTimeout(res, 8000); });
  rmSync(n.dir, { recursive: true, force: true });
}
const status403 = async (p: Promise<unknown>) => (await p.then(() => 'allowed', (e: Error) => e.message));

describe.skipIf(!existsSync(BITCOIND))('read-only mainnet node: app allowlist + bitcoind rpcwhitelist (real bitcoind)', () => {
  let n: Awaited<ReturnType<typeof startNode>>;
  beforeAll(async () => {
    n = await startNode({ whitelistDefault0: true });
    const { descriptor } = await n.mynode.call<{ descriptor: string }>('getdescriptorinfo', ['raw(51)']);
    await n.mynode.call('generatetodescriptor', [7, descriptor]);
  }, 30_000);
  afterAll(async () => { if (n) await stopNode(n); }, 15_000);

  it('the dashboard works entirely through the allowlisted client', async () => {
    const ro = new ReadOnlyRpc({ host: '127.0.0.1', port: n.rpcPort, user: 'btctrust', password: 'ro-secret', expectChain: 'regtest' });
    expect(await ro.chain()).toBe('regtest');
    const chain = new ChainService(ro);
    const s = await chain.summary();
    expect(s.height).toBe(7);
    expect((await chain.recentBlocks(3)).map((b) => b.height)).toEqual([7, 6, 5]);
    for (const m of ['getdifficulty', 'getchaintips', 'getbestblockhash', 'getconnectioncount', 'uptime', 'getchaintxstats', 'getblockheader']) {
      await ro.call(m, m === 'getblockheader' ? [s.bestBlockHash] : []);
    }
    expect(ro.refused).toHaveLength(0);
  });

  it('the app refuses wallet/send/sign/mining calls before they reach bitcoind', async () => {
    const ro = new ReadOnlyRpc({ host: '127.0.0.1', port: n.rpcPort, user: 'mynode', password: 'mynode-secret' }); // even with full-access creds
    for (const m of ['createwallet', 'sendrawtransaction', 'generatetodescriptor', 'stop', 'importdescriptors', 'walletprocesspsbt']) {
      await expect(ro.call(m, ['x'])).rejects.toBeInstanceOf(ReadOnlyViolation);
    }
    expect(await n.mynode.call<string[]>('listwallets')).toEqual([]); // nothing was created
    expect(await n.mynode.call('getblockcount')).toBe(7);           // nothing was mined, node still up
  });

  it('bitcoind itself rejects anything outside the whitelist for the btctrust user (HTTP 403)', async () => {
    for (const [m, p] of [['getwalletinfo', []], ['createwallet', ['evil']], ['sendrawtransaction', ['00']], ['generatetodescriptor', [1, 'raw(51)']], ['stop', []], ['getrawtransaction', ['00'.repeat(32)]], ['help', []]] as const) {
      expect(await status403(n.btctrust.call(m, [...p])), m).toMatch(/HTTP 403/);
    }
    expect(await n.btctrust.call('getblockcount')).toBe(7);
    expect(await n.mynode.call<string[]>('listwallets')).toEqual([]);
  });

  it('rpcwhitelistdefault=0 keeps the node\'s own users (myNode, other apps) unrestricted', async () => {
    await n.mynode.call('createwallet', ['other-app']);
    expect(await n.mynode.call<string[]>('listwallets')).toEqual(['other-app']);
  });

  it('the wallet-side guard accepts this test chain', async () => {
    const rpc = new TestChainRpc({ rpcHost: '127.0.0.1', rpcPort: n.rpcPort, rpcUser: 'mynode', rpcPassword: 'mynode-secret', rpcTimeoutMs: 5000 });
    expect(await rpc.call('getblockcount')).toBe(7);
  });
});

describe.skipIf(!existsSync(BITCOIND))('why install-mynode.sh writes rpcwhitelistdefault=0 (real bitcoind)', () => {
  it('without it, a single rpcwhitelist locks every other RPC user out', async () => {
    const n = await startNode({ whitelistDefault0: false });
    try {
      expect(await status403(n.mynode.call('getblockcount'))).toMatch(/HTTP 403/);
      expect(await n.btctrust.call('getblockcount')).toBe(0);
    } finally { await stopNode(n); }
  }, 30_000);
});
