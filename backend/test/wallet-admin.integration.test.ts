// Rename + delete against the real regtest bitcoind: bitcoind wallets are untouched by rename, unloaded (not erased) by delete.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { BitcoinRpc } from '../src/rpc.js';
import { WalletStore } from '../src/store.js';

const cfg = { ...loadConfig(), dataDir: mkdtempSync(join(tmpdir(), 'btctrust-admin-int-')) };
const rpc = new BitcoinRpc(cfg);
const app = createApp(cfg, rpc, new WalletStore(cfg.dataDir, cfg.network), null);
const loaded = async () => rpc.call<string[]>('listwallets');
const onDisk = async () => (await rpc.call<{ wallets: { name: string }[] }>('listwalletdir')).wallets.map((w) => w.name);

beforeAll(async () => {
  if ((await rpc.call<{ chain: string }>('getblockchaininfo')).chain !== 'regtest') throw new Error('regtest only');
});

describe('rename and delete on regtest', () => {
  it('rename keeps the bitcoind wallet and descriptors; delete unloads every wallet it created and keeps the files', async () => {
    const c = await request(app).post('/api/wallets').send({ name: 'Whitfeild Test Trust', type: 'multisig', m: 2, n: 3, cosignerLabels: ['Jordan', 'Avery Whitfield', 'Mateo Whitfield'] });
    expect(c.status).toBe(201);
    const w = c.body;
    const names = [w.watchWallet, `${w.watchWallet}-key1`, `${w.watchWallet}-key2`, `${w.watchWallet}-key3`];
    expect(await loaded()).toEqual(expect.arrayContaining(names));
    const before = (await request(app).get(`/api/wallets/${w.id}`)).body;

    const r = await request(app).patch(`/api/wallets/${w.id}`).send({ name: 'Whitfield Test Trust' });
    expect(r.status).toBe(200);
    const after = (await request(app).get(`/api/wallets/${w.id}`)).body;
    expect(after).toMatchObject({ id: w.id, name: 'Whitfield Test Trust', watchWallet: w.watchWallet, descriptors: before.descriptors, cosigners: before.cosigners });
    expect(after.addresses).toEqual(before.addresses);
    expect(await loaded()).toEqual(expect.arrayContaining(names));

    const d = await request(app).delete(`/api/wallets/${w.id}`).send({ confirmName: 'Whitfield Test Trust' });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    expect(d.body.unloaded.sort()).toEqual([...names].sort());
    const now = await loaded();
    for (const n of names) expect(now).not.toContain(n);
    expect(await onDisk()).toEqual(expect.arrayContaining(names));   // files kept on the test node
    expect((await request(app).get(`/api/wallets/${w.id}`)).status).toBe(404);
    expect((await request(app).get('/api/wallets')).body.map((x: { id: string }) => x.id)).not.toContain(w.id);
    // a fresh wallet with the same display name gets a new id; nothing collides
    const again = await request(app).post('/api/wallets').send({ name: 'Whitfield Test Trust', type: 'singlesig' });
    expect(again.status).toBe(201);
    expect(again.body.id).not.toBe(w.id);
  }, 60_000);
});
