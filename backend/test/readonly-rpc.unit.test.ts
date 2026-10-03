import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { BitcoinRpc, RpcError } from '../src/rpc.js';
import { ChainService } from '../src/service.js';
import { MainnetService } from '../src/timeline/mainnet.js';
import { TimelineService } from '../src/timeline/service.js';
import { WalletStore } from '../src/store.js';
import { ChainRefused, READ_ONLY_METHODS, ReadOnlyRpc, ReadOnlyViolation, TestChainRpc, rpcWhitelistConf, rpcauthLine } from '../src/readonly-rpc.js';

/** A fake bitcoind that records every request that actually left the client. */
function fakeNode(chain = 'main', height = 900_000) {
  const sent: { method: string; params: unknown; user: string; password: string; url: string }[] = [];
  const hash = '00'.repeat(32);
  const header = '00'.repeat(80);
  const answer = (m: string, p: unknown[]) => {
    switch (m) {
      case 'getblockchaininfo': return { chain, blocks: height, headers: height, bestblockhash: hash, difficulty: 1, verificationprogress: 1, initialblockdownload: false, size_on_disk: 1, pruned: false };
      case 'getmempoolinfo': return { size: 3, bytes: 900, usage: 1000, total_fee: 0.0001 };
      case 'getnetworkinfo': return { version: 290300, subversion: '/Satoshi:29.3.0/', connections: 10 };
      case 'getblockcount': return height;
      case 'getblockhash': return hash;
      case 'getblock': return { height: p[0] === hash ? height : 0, hash, time: 1, nTx: 1, size: 1, weight: 4, difficulty: 1 };
      case 'getblockheader': return header;
      default: return null;
    }
  };
  const make = (c: ConstructorParameters<typeof BitcoinRpc>[0]) => ({
    call: async (method: string, params: unknown[] = []) => { sent.push({ method, params, user: c.rpcUser, password: c.rpcPassword, url: `${c.rpcHost}:${c.rpcPort}` }); return answer(method, params); },
  }) as unknown as BitcoinRpc;
  return { sent, make };
}
const node = { host: 'mynode.local', port: 8332, user: 'btctrust', password: 'pw' };

/** Methods that move money, touch keys/wallets, change node state, or leak more than chain data. */
const FORBIDDEN = [
  'sendrawtransaction', 'sendtoaddress', 'sendmany', 'send', 'sendall', 'submitpackage', 'submitblock', 'submitheader',
  'createwallet', 'loadwallet', 'unloadwallet', 'restorewallet', 'backupwallet', 'dumpwallet', 'dumpprivkey', 'importwallet',
  'importdescriptors', 'importprivkey', 'importaddress', 'importpubkey', 'importmulti', 'listdescriptors', 'getnewaddress',
  'getwalletinfo', 'getbalance', 'listunspent', 'listwallets', 'walletpassphrase', 'encryptwallet', 'walletprocesspsbt',
  'walletcreatefundedpsbt', 'signrawtransactionwithkey', 'signrawtransactionwithwallet', 'signmessage', 'signmessagewithprivkey',
  'generatetoaddress', 'generatetodescriptor', 'generateblock', 'stop', 'setban', 'clearbanned', 'addnode', 'disconnectnode',
  'setnetworkactive', 'invalidateblock', 'reconsiderblock', 'preciousblock', 'pruneblockchain', 'savemempool', 'importmempool',
  'dumptxoutset', 'loadtxoutset', 'scantxoutset', 'scanblocks', 'logging', 'setmocktime', 'echo', 'help',
  'getrawtransaction', 'createrawtransaction', 'combinepsbt', 'finalizepsbt', 'utxoupdatepsbt', 'abandontransaction', 'bumpfee', 'psbtbumpfee',
  // tricks
  'GetBlockchainInfo', ' getblockcount', 'getblockcount ', 'getblock\u0000', '__proto__', 'constructor', 'toString', 'hasOwnProperty', '',
];

describe('read-only mainnet RPC client', () => {
  it('allowlist contains only chain/network reads', () => {
    expect([...READ_ONLY_METHODS].sort()).toEqual(['estimatesmartfee', 'getbestblockhash', 'getblock', 'getblockchaininfo', 'getblockcount', 'getblockhash', 'getblockheader', 'getblockstats', 'getchaintips', 'getchaintxstats', 'getconnectioncount', 'getdifficulty', 'getmempoolinfo', 'getnetworkinfo', 'uptime']);
    expect(Object.isFrozen(READ_ONLY_METHODS)).toBe(true);
    for (const m of READ_ONLY_METHODS) expect(m).toMatch(/^(get|estimate|uptime)/);
  });
  it.each(FORBIDDEN)('refuses %j before anything is sent', async (m) => {
    const f = fakeNode();
    const ro = new ReadOnlyRpc(node, 1000, f.make);
    await expect(ro.call(m, [])).rejects.toBeInstanceOf(ReadOnlyViolation);
    expect(f.sent).toHaveLength(0);
    expect(ro.refused.at(-1)?.method).toBe(m);
  });
  it('never uses a wallet endpoint, even for an allowed method', async () => {
    const f = fakeNode();
    const ro = new ReadOnlyRpc(node, 1000, f.make);
    await expect(ro.call('getblockcount', [], 'wallet.dat')).rejects.toThrow(/wallet endpoints are never used/);
    await expect(ro.call(undefined as unknown as string)).rejects.toBeInstanceOf(ReadOnlyViolation);
    expect(f.sent).toHaveLength(0);
  });
  it('maps refusals to HTTP 403', async () => {
    const { statusFor } = await import('../src/errors.js');
    expect(statusFor(new ReadOnlyViolation('stop', 'x'))).toBe(403);
    expect(statusFor(new ChainRefused('x'))).toBe(403);
    expect(statusFor(new RpcError('down'))).toBe(502);
  });
  it('serves the dashboard and daily snapshot using allowlisted calls only', async () => {
    const f = fakeNode('main', 912_345);
    const ro = new ReadOnlyRpc(node, 1000, f.make);
    const chain = new ChainService(ro);
    expect((await chain.summary()).height).toBe(912_345);
    expect(await chain.recentBlocks(3)).toHaveLength(3);
    const ms = new MainnetService({ dataDir: mkdtempSync(join(tmpdir(), 'ro-')), node: ro, fetch: async () => { throw new Error('offline'); }, attempts: 1 });
    expect((await (ms as unknown as { nodeTip(): Promise<{ name: string } | null> }).nodeTip())?.name).toBe('node');
    expect(ro.refused).toHaveLength(0);
    expect(new Set(f.sent.map((s) => s.method))).toEqual(new Set(['getblockchaininfo', 'getmempoolinfo', 'getnetworkinfo', 'getblockcount', 'getblockhash', 'getblock', 'getblockheader']));
    expect(await ro.chain()).toBe('main');
  });
  it('refuses a node on the wrong chain', async () => {
    const ro = new ReadOnlyRpc({ ...node, expectChain: 'main' }, 1000, fakeNode('regtest').make);
    await expect(ro.chain()).rejects.toThrow(/on "regtest", expected "main"/);
  });
  it('reads cookie credentials fresh on every call', async () => {
    const f = fakeNode();
    const cookie = join(mkdtempSync(join(tmpdir(), 'ck-')), '.cookie');
    writeFileSync(cookie, '__cookie__:aaa');
    const ro = new ReadOnlyRpc({ ...node, cookieFile: cookie }, 1000, f.make);
    await ro.call('getblockcount');
    writeFileSync(cookie, '__cookie__:bbb'); // bitcoind restarted
    await ro.call('getblockcount');
    expect(f.sent.map((s) => `${s.user}:${s.password}`)).toEqual(['__cookie__:aaa', '__cookie__:bbb']);
  });
  it('emits a matching bitcoind rpcwhitelist and an rpcauth line in rpcauth.py format', async () => {
    const conf = rpcWhitelistConf('btctrust');
    expect(conf).toContain(`rpcwhitelist=btctrust:${READ_ONLY_METHODS.join(',')}`);
    expect(conf).toContain('rpcwhitelistdefault=0');
    expect(() => rpcWhitelistConf('bad user')).toThrow();
    // Vector computed with Bitcoin Core's share/rpcauth/rpcauth.py algorithm (hmac.new(salt.encode(), pw.encode(), 'SHA256')).
    expect(await rpcauthLine('btctrust', 'secret', '0123456789abcdef0123456789abcdef')).toBe('rpcauth=btctrust:0123456789abcdef0123456789abcdef$0ad814968caefdecab8a6c0c55414688fdcad02f100ee7ac5def2352aaff36e5');
  });
});

describe('test-chain guard for the wallet node (split mode)', () => {
  const fetchFor = (chain: string) => {
    const calls: string[] = [];
    const f = (async (_url: string, init: { body: string }) => {
      const { method, id } = JSON.parse(init.body);
      calls.push(method);
      const result = method === 'getblockchaininfo' ? { chain } : 42;
      return new Response(JSON.stringify({ result, error: null, id }), { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, f };
  };
  const rpcCfg = { rpcHost: '127.0.0.1', rpcPort: 1, rpcUser: 'u', rpcPassword: 'p', rpcTimeoutMs: 1000 };
  it('refuses every wallet call when the wallet node reports mainnet', async () => {
    const { calls, f } = fetchFor('main');
    const orig = globalThis.fetch; globalThis.fetch = f;
    try {
      const rpc = new TestChainRpc(rpcCfg);
      await expect(rpc.call('createwallet', ['x'])).rejects.toBeInstanceOf(ChainRefused);
      await expect(rpc.call('getbalance', [], 'x')).rejects.toThrow(/wallet node is on "main"/);
      expect(calls.filter((c) => c !== 'getblockchaininfo')).toEqual([]);
    } finally { globalThis.fetch = orig; }
  });
  it('passes calls through on regtest/signet', async () => {
    const { calls, f } = fetchFor('regtest');
    const orig = globalThis.fetch; globalThis.fetch = f;
    try {
      const rpc = new TestChainRpc(rpcCfg);
      expect(await rpc.call('getblockcount')).toBe(42);
      expect(await rpc.call('getblockcount')).toBe(42);
      expect(calls).toEqual(['getblockchaininfo', 'getblockcount', 'getblockcount']);
    } finally { globalThis.fetch = orig; }
  });
});

describe('split-mode config', () => {
  const myNode = { MAINNET_RPC_HOST: 'host.docker.internal', MAINNET_RPC_USER: 'btctrust', MAINNET_RPC_PASSWORD: 'x' };
  it('defaults to split when a mainnet node is configured and wallets are on a test chain', () => {
    const c = loadConfig({ ...myNode });
    expect(c.mode).toBe('split');
    expect(c.network).toBe('regtest');
    expect(c.mainnet.node).toMatchObject({ host: 'host.docker.internal', port: 8332, expectChain: 'main' });
    expect(loadConfig({}).mode).toBe('standalone');
  });
  it('never lets split mode put wallets on mainnet, even with ALLOW_MAINNET', () => {
    expect(() => loadConfig({ ...myNode, APP_MODE: 'split', BITCOIN_NETWORK: 'main', ALLOW_MAINNET: 'true' })).toThrow(/keeps wallets off mainnet/);
    expect(() => loadConfig({ APP_MODE: 'split' })).toThrow(/needs MAINNET_RPC_HOST/);
    expect(loadConfig({ ...myNode, BITCOIN_NETWORK: 'signet' }).mode).toBe('split');
  });
  it('supports cookie auth, wallet features off, and the simulation chain override', () => {
    const c = loadConfig({ ...myNode, MAINNET_RPC_COOKIEFILE: '/mnt/hdd/mynode/bitcoin/.cookie', WALLET_FEATURES: 'off', MAINNET_RPC_EXPECT_CHAIN: 'regtest' });
    expect(c.mainnet.node?.cookieFile).toBe('/mnt/hdd/mynode/bitcoin/.cookie');
    expect(c.mainnet.node?.expectChain).toBe('regtest');
    expect(c.walletFeatures).toBe(false);
  });
});

describe('split-mode API', () => {
  const mk = (over: Partial<AppConfig> = {}) => {
    const base = loadConfig();
    const cfg: AppConfig = { ...base, dataDir: mkdtempSync(join(tmpdir(), 'split-')), mode: 'split', mainnet: { node: { ...node, expectChain: 'main' }, snapshots: false }, ...over };
    const f = fakeNode('main', 912_345);
    const ro = new ReadOnlyRpc(cfg.mainnet.node!, 1000, f.make);
    const tl = new TimelineService(cfg, { node: ro, fetch: async () => { throw new Error('offline'); }, attempts: 1 });
    return { app: createApp(cfg, new BitcoinRpc(cfg), new WalletStore(cfg.dataDir, cfg.network), null, tl), f, ro };
  };
  it('serves mainnet chain data read-only and reports the split', async () => {
    const { app, f } = mk();
    const r = await request(app).get('/api/blockchain?source=mainnet');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ network: 'main', height: 912_345 });
    expect((await request(app).get('/api/blocks?source=mainnet&count=2')).body).toHaveLength(2);
    const mode = (await request(app).get('/api/mode')).body;
    expect(mode).toMatchObject({ mode: 'split', mainnet: { configured: true, readOnly: true, expectChain: 'main', auth: 'rpcauth', refused: 0 }, wallet: { enabled: true, network: 'regtest' } });
    expect(mode.mainnet.methods).toEqual([...READ_ONLY_METHODS]);
    expect(f.sent.every((s) => (READ_ONLY_METHODS as readonly string[]).includes(s.method))).toBe(true);
    expect((await request(app).get('/api/health')).body.mainnet).toMatchObject({ rpc: 'connected', chain: 'main', readOnly: true });
  });
  it('switches every wallet-side route off with WALLET_FEATURES=off', async () => {
    const { app } = mk({ walletFeatures: false });
    for (const p of ['/api/wallets', '/api/vaults/x/status', '/api/messaging/alerts', '/api/devices', '/api/regtest/mine']) {
      const r = p.includes('mine') ? await request(app).post(p) : await request(app).get(p);
      expect(r.status, p).toBe(503);
      expect(r.body.disabled).toBe(true);
    }
    expect((await request(app).get('/api/blockchain')).status).toBe(503);
    expect((await request(app).get('/api/blockchain?source=mainnet')).status).toBe(200);
    expect((await request(app).get('/api/mode')).body.wallet).toEqual({ enabled: false, network: null });
  });
  it('404s ?source=mainnet when no node is configured', async () => {
    const cfg = { ...loadConfig(), dataDir: mkdtempSync(join(tmpdir(), 'nomain-')) };
    const app = createApp(cfg, new BitcoinRpc(cfg), new WalletStore(cfg.dataDir, cfg.network), null, new TimelineService(cfg, { node: null }));
    expect((await request(app).get('/api/blockchain?source=mainnet')).status).toBe(404);
  });
});
