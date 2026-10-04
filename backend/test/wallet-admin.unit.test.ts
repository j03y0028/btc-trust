// Rename + delete for test wallets: validation, 404s, regtest-only deletion, references, CSRF and login.
import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type AppConfig, type Network } from '../src/config.js';
import { createApp } from '../src/app.js';
import { WalletStore, type WalletConfig } from '../src/store.js';
import { RpcError, type BitcoinRpc } from '../src/rpc.js';
import { TimelineService } from '../src/timeline/service.js';
import { AuthService, COOKIE } from '../src/auth.js';

const base = loadConfig();
type Call = { method: string; params: unknown; wallet?: string };

function fakeRpc(opts: { chain?: string; notLoaded?: string[] } = {}) {
  const calls: Call[] = [];
  const rpc = {
    calls,
    async call(method: string, params: unknown = [], wallet?: string) {
      calls.push({ method, params, wallet });
      if (method === 'getblockchaininfo') return { chain: opts.chain ?? 'regtest', blocks: 101 };
      if (method === 'getbalances') return { mine: { trusted: 1.5, untrusted_pending: 0, immature: 0 } };
      if (method === 'unloadwallet') {
        const name = (params as string[])[0];
        if (opts.notLoaded?.includes(name)) throw new RpcError(`Requested wallet does not exist or is not loaded`, -18);
        return { warning: '' };
      }
      return null;
    },
  };
  return rpc as unknown as BitcoinRpc & { calls: Call[] };
}

const wallet = (id: string, name: string, over: Partial<WalletConfig> = {}): WalletConfig => ({
  id, name, type: 'multisig', network: 'regtest', m: 2, n: 3, watchWallet: `btctrust-${id}`,
  descriptors: { receive: `wsh(sortedmulti(2,[aaaaaaaa/48h/1h/0h/2h]tpubA/0/*))#abcdefgh`, change: 'wsh(...)/1/*' },
  cosigners: [
    { label: 'Jordan', fingerprint: 'aaaaaaaa', key: 'k1', kind: 'software', signerWallet: `btctrust-${id}-key1` },
    { label: 'Avery Whitfield', fingerprint: 'bbbbbbbb', key: 'k2', kind: 'software', signerWallet: `btctrust-${id}-key2` },
    { label: 'Counsel', fingerprint: 'cccccccc', key: 'k3', kind: 'airgapped' },
  ],
  createdAt: '2026-10-01T00:00:00.000Z', ...over,
});

let cfg: AppConfig, store: WalletStore, rpc: ReturnType<typeof fakeRpc>;
function mk(over: Partial<AppConfig> = {}, rpcOpts: Parameters<typeof fakeRpc>[0] = {}, auth?: AuthService) {
  cfg = { ...base, network: 'regtest', dataDir: mkdtempSync(join(tmpdir(), 'btctrust-admin-')), ...over };
  store = new WalletStore(cfg.dataDir, cfg.network);
  rpc = fakeRpc(rpcOpts);
  const tl = new TimelineService(cfg, { node: null, fetch: async () => { throw new Error('offline'); }, attempts: 1 });
  return createApp(cfg, rpc, store, null, tl, auth);
}
let app: ReturnType<typeof mk>;
beforeEach(() => {
  app = mk();
  store.save(wallet('whitfield-family-aaaaaa', 'Whitfeild Family Trust'));   // the misspelling to fix
  store.save(wallet('other-bbbbbb', 'Other Trust'));
});
const unloads = () => rpc.calls.filter((c) => c.method === 'unloadwallet').map((c) => c.params);
const ID = 'whitfield-family-aaaaaa';

describe('PATCH /api/wallets/:id (rename)', () => {
  it('changes only the display name (trimmed); id, bitcoind wallets, descriptors and list order stay', async () => {
    const before = store.get(ID)!;
    const r = await request(app).patch(`/api/wallets/${ID}`).send({ name: '  Whitfield Family Trust  ' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: ID, name: 'Whitfield Family Trust', watchWallet: before.watchWallet, descriptors: before.descriptors });
    expect(r.body).not.toHaveProperty('cosigners.0.signerWallet');
    const after = store.get(ID)!;
    expect(after).toEqual({ ...before, name: 'Whitfield Family Trust' });
    expect(store.list().map((w) => w.id)).toEqual([ID, 'other-bbbbbb']);
    expect(rpc.calls.filter((c) => c.method !== 'getblockchaininfo')).toEqual([]);   // no bitcoind changes
  });
  it.each([
    ['empty', ''], ['whitespace only', '   '], ['65 characters', 'x'.repeat(65)], ['not a string', 42], ['missing', undefined],
    ['control characters', 'Bad\nName'],
  ])('rejects a name that is %s (400) and keeps the old one', async (_what, name) => {
    const r = await request(app).patch(`/api/wallets/${ID}`).send(name === undefined ? {} : { name });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/name/i);
    expect(store.get(ID)!.name).toBe('Whitfeild Family Trust');
  });
  it('accepts exactly 64 characters', async () => {
    const r = await request(app).patch(`/api/wallets/${ID}`).send({ name: 'y'.repeat(64) });
    expect(r.status).toBe(200);
  });
  it('refuses to change anything but the name', async () => {
    const r = await request(app).patch(`/api/wallets/${ID}`).send({ name: 'New', watchWallet: 'btctrust-evil', id: 'x' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Only the display name/);
    expect(store.get(ID)!).toMatchObject({ name: 'Whitfeild Family Trust', watchWallet: `btctrust-${ID}` });
  });
  it('refuses private keys in the name', async () => {
    const r = await request(app).patch(`/api/wallets/${ID}`).send({ name: 'tprv8ZgxMBicQKsPd7Uf69XL1XwhmjHopUGep8GuEiJDZmbQz6o58LninorQAfcKZWARbtRtfnLcJ5MQ2AtHcQJCCRUcMRvmDUjyEmNUWwx8UbK' });
    expect(r.status).toBe(400);
  });
  it('404 for an unknown wallet id', async () => {
    const r = await request(app).patch('/api/wallets/nope-000000').send({ name: 'X' });
    expect(r.status).toBe(404);
  });
});

describe('DELETE /api/wallets/:id', () => {
  it('previews the impact', async () => {
    const r = await request(app).get(`/api/wallets/${ID}/delete-check`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: ID, name: 'Whitfeild Family Trust', deletable: true, vault: false, openSigRequests: 0, needsAcknowledge: false,
      balance: { total: 1.5 }, bitcoindWallets: [`btctrust-${ID}`, `btctrust-${ID}-key1`, `btctrust-${ID}-key2`] });
  });
  it('requires the exact wallet name as confirmation', async () => {
    for (const confirmName of [undefined, '', 'whitfeild family trust', 'Whitfeild Family']) {
      const r = await request(app).delete(`/api/wallets/${ID}`).send({ confirmName });
      expect(r.status).toBe(400);
      expect(r.body.details.code).toBe('CONFIRM_NAME');
    }
    expect(store.get(ID)).toBeTruthy();
    expect(unloads()).toEqual([]);
  });
  it('removes the config, unloads its bitcoind wallets (load_on_startup=false), archives instead of erasing', async () => {
    const r = await request(app).delete(`/api/wallets/${ID}`).send({ confirmName: 'Whitfeild Family Trust' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ deleted: ID, unloaded: [`btctrust-${ID}`, `btctrust-${ID}-key1`, `btctrust-${ID}-key2`] });
    expect(unloads()).toEqual([[`btctrust-${ID}`, false], [`btctrust-${ID}-key1`, false], [`btctrust-${ID}-key2`, false]]);
    expect(store.get(ID)).toBeUndefined();
    expect(store.get('other-bbbbbb')).toBeTruthy();
    expect((await request(app).get(`/api/wallets/${ID}`)).status).toBe(404);
    const archived = JSON.parse(readFileSync(join(cfg.dataDir, r.body.archivedTo, 'wallet.json'), 'utf8'));
    expect(archived.wallet).toMatchObject({ id: ID, watchWallet: `btctrust-${ID}` });
    // the live chain check ran before any unload
    const i = rpc.calls.findIndex((c) => c.method === 'unloadwallet');
    expect(rpc.calls.slice(0, i).some((c) => c.method === 'getblockchaininfo')).toBe(true);
  });
  it('does not unload a bitcoind wallet that another wallet still uses, and tolerates already-unloaded ones', async () => {
    const shared = `btctrust-${ID}-key1`;
    store.save(wallet('shares-cccccc', 'Shares a key', { cosigners: [{ label: 'Jordan', fingerprint: 'aaaaaaaa', key: 'k1', kind: 'software', signerWallet: shared }] }));
    app = (() => { const a = createApp(cfg, fakeRpc({ notLoaded: [`btctrust-${ID}`] }), store, null, new TimelineService(cfg, { node: null, fetch: async () => { throw new Error('offline'); }, attempts: 1 })); return a; })();
    const r = await request(app).delete(`/api/wallets/${ID}`).send({ confirmName: 'Whitfeild Family Trust' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.unloaded).toEqual([`btctrust-${ID}-key2`]);
  });
  it('404 for an unknown wallet id', async () => {
    expect((await request(app).delete('/api/wallets/nope-000000').send({ confirmName: 'x' })).status).toBe(404);
    expect((await request(app).get('/api/wallets/nope-000000/delete-check')).status).toBe(404);
  });

  describe('never off regtest', () => {
    it('refuses when the app wallet network is not regtest (signet/main), before any RPC', async () => {
      for (const network of ['signet', 'main'] as Network[]) {
        app = mk({ network });
        store.save(wallet('w-dddddd', 'Signet Trust', { network }));
        const pre = await request(app).get('/api/wallets/w-dddddd/delete-check');
        expect(pre.body).toMatchObject({ deletable: false });
        const r = await request(app).delete('/api/wallets/w-dddddd').send({ confirmName: 'Signet Trust' });
        expect(r.status).toBe(403);
        expect(r.body.details.code).toBe('NOT_REGTEST');
        expect(unloads()).toEqual([]);
        expect(store.get('w-dddddd')).toBeTruthy();
      }
    });
    it('refuses a wallet whose stored network is mainnet even on a regtest app', async () => {
      store.save(wallet('main-eeeeee', 'Main Trust', { network: 'main' }));
      const r = await request(app).delete('/api/wallets/main-eeeeee').send({ confirmName: 'Main Trust' });
      expect(r.status).toBe(403);
      expect(unloads()).toEqual([]);
    });
    it('refuses when the wallet node itself reports mainnet (live check), and changes nothing', async () => {
      app = mk({}, { chain: 'main' });
      store.save(wallet(ID, 'Whitfeild Family Trust'));
      const r = await request(app).delete(`/api/wallets/${ID}`).send({ confirmName: 'Whitfeild Family Trust' });
      expect(r.status).toBe(403);
      expect(r.body.error).toMatch(/main/);
      expect(unloads()).toEqual([]);
      expect(store.get(ID)).toBeTruthy();
    });
  });

  describe('references (vault, pending signature requests, messaging, registrations)', () => {
    const seed = () => {
      mkdirSync(join(cfg.dataDir, 'vaults', ID), { recursive: true });
      writeFileSync(join(cfg.dataDir, 'vaults', `${ID}.vault.json`), JSON.stringify({ format: 'btctrust-vault', walletId: ID }));
      writeFileSync(join(cfg.dataDir, 'vaults', ID, 'att1.bin'), 'x');
      writeFileSync(join(cfg.dataDir, 'messaging', `${ID}.json`), JSON.stringify({ version: 1, seq: 2, identities: { aaaaaaaa: {} }, retired: [], receipts: [],
        messages: [{ seq: 1 }, { seq: 2 }], sigRequests: [{ id: 'r1', status: 'open' }, { id: 'r2', status: 'broadcast' }] }));
      writeFileSync(join(cfg.dataDir, `registrations.${cfg.network}.json`), JSON.stringify({ [ID]: [{ cosigner: 0, device: 'coldcard' }], 'other-bbbbbb': [{ cosigner: 1, device: 'ledger' }] }));
    };
    it('needs acknowledge when there is a vault or an open signature request (409), then archives all of it', async () => {
      seed();
      const pre = await request(app).get(`/api/wallets/${ID}/delete-check`);
      expect(pre.body).toMatchObject({ vault: true, messages: 2, trustees: 1, openSigRequests: 1, registrations: 1, needsAcknowledge: true });
      const no = await request(app).delete(`/api/wallets/${ID}`).send({ confirmName: 'Whitfeild Family Trust' });
      expect(no.status).toBe(409);
      expect(no.body.error).toMatch(/encrypted trust vault and 1 open signature request/);
      expect(store.get(ID)).toBeTruthy();
      expect(unloads()).toEqual([]);

      const r = await request(app).delete(`/api/wallets/${ID}`).send({ confirmName: 'Whitfeild Family Trust', acknowledge: true });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.archived).toEqual({ vault: true, messaging: true, registrations: true });
      const dest = join(cfg.dataDir, r.body.archivedTo);
      expect(readdirSync(dest).sort()).toEqual(['messaging.json', 'registrations.json', `${ID}.vault.json`, 'vault-attachments', 'wallet.json'].sort());
      expect(existsSync(join(dest, 'vault-attachments', 'att1.bin'))).toBe(true);
      expect(existsSync(join(cfg.dataDir, 'vaults', `${ID}.vault.json`))).toBe(false);
      expect(existsSync(join(cfg.dataDir, 'messaging', `${ID}.json`))).toBe(false);
      expect(JSON.parse(readFileSync(join(cfg.dataDir, `registrations.${cfg.network}.json`), 'utf8'))).toEqual({ 'other-bbbbbb': [{ cosigner: 1, device: 'ledger' }] });
      // vault and messaging routes now treat the wallet as gone
      expect((await request(app).get(`/api/vaults/${ID}/status`)).status).toBe(404);
    });
  });
});

describe('CSRF and login', () => {
  it('blocks cross-site PATCH and DELETE (Origin / Sec-Fetch-Site) without changing anything', async () => {
    const evil = { Origin: 'https://evil.example' };
    expect((await request(app).patch(`/api/wallets/${ID}`).set(evil).send({ name: 'Pwned' })).status).toBe(403);
    expect((await request(app).delete(`/api/wallets/${ID}`).set(evil).send({ confirmName: 'Whitfeild Family Trust' })).status).toBe(403);
    expect((await request(app).patch(`/api/wallets/${ID}`).set('Sec-Fetch-Site', 'cross-site').send({ name: 'Pwned' })).status).toBe(403);
    expect((await request(app).delete(`/api/wallets/${ID}`).set('Sec-Fetch-Site', 'cross-site').send({ confirmName: 'Whitfeild Family Trust' })).status).toBe(403);
    expect(store.get(ID)!.name).toBe('Whitfeild Family Trust');
    expect(unloads()).toEqual([]);
    // same-origin requests from the app itself pass
    expect((await request(app).patch(`/api/wallets/${ID}`).set('Origin', 'http://127.0.0.1:9330').set('Sec-Fetch-Site', 'same-origin').send({ name: 'OK' })).status).toBe(200);
  });
  it('requires the app login when auth is on', async () => {
    const authCfg: AppConfig = { ...base, apiHost: '0.0.0.0', network: 'regtest', dataDir: mkdtempSync(join(tmpdir(), 'btctrust-admin-auth-')), auth: { ...base.auth, mode: 'auto' as const, scryptN: 2 ** 12 } };
    const auth = new AuthService(authCfg);
    const a = mk(authCfg, {}, auth);
    store.save(wallet(ID, 'Whitfeild Family Trust'));
    expect((await request(a).patch(`/api/wallets/${ID}`).send({ name: 'X' })).status).toBe(401);
    expect((await request(a).delete(`/api/wallets/${ID}`).send({ confirmName: 'Whitfeild Family Trust' })).status).toBe(401);
    const setup = await request(a).post('/api/auth/setup').send({ passphrase: 'correct horse battery staple', setupToken: auth.pendingSetupToken });
    const cookie = ([] as string[]).concat(setup.headers['set-cookie'] ?? []).find((x) => x.startsWith(COOKIE + '='))!.split(';')[0];
    expect((await request(a).patch(`/api/wallets/${ID}`).set('Cookie', cookie).send({ name: 'Whitfield Family Trust' })).status).toBe(200);
    expect(store.get(ID)!.name).toBe('Whitfield Family Trust');
  });
});
