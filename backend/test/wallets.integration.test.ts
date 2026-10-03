import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { BitcoinRpc } from '../src/rpc.js';

const cfg = loadConfig();
const rpc = new BitcoinRpc(cfg);
const app = createApp(cfg, rpc);
const PRIV = /[tx]prv[1-9A-HJ-NP-Za-km-z]{50,}/;
const api = () => request(app);
const noPriv = (body: unknown) => expect(JSON.stringify(body)).not.toMatch(PRIV);

let burn = '';
const mine = (blocks: number, address?: string) => api().post('/api/regtest/mine').send({ blocks, address });
const fund = (walletId: string, amount: number) => api().post('/api/regtest/fund').send({ walletId, amount });

beforeAll(async () => {
  const chain = (await rpc.call<{ chain: string }>('getblockchaininfo')).chain;
  if (chain !== 'regtest') throw new Error('wallet tests only run on regtest');
  // A fixed OP_TRUE-style address isn't spendable by us; derive a throwaway address from a fresh descriptor instead.
  [burn] = await rpc.call<string[]>('deriveaddresses', [
    (await rpc.call<{ descriptor: string }>('getdescriptorinfo', ['addr(bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080)'])).descriptor,
  ]);
});

describe('2-of-3 multisig (default)', () => {
  let id = '';
  let wallet: any;
  let psbtBase = '';

  it('creates a 2-of-3 wsh(sortedmulti) watch-only wallet with 3 local cosigners', async () => {
    const r = await api().post('/api/wallets').send({ name: 'Family Trust Test', type: 'multisig' });
    expect(r.status).toBe(201);
    wallet = r.body;
    id = wallet.id;
    expect(wallet).toMatchObject({ type: 'multisig', m: 2, n: 3, canSign: true });
    expect(wallet.descriptors.receive).toMatch(/^wsh\(sortedmulti\(2,/);
    expect(wallet.descriptors.change).toMatch(/\/1\/\*/);
    expect(wallet.cosigners).toHaveLength(3);
    expect(wallet.cosigners.every((c: any) => c.local && /^[0-9a-f]{8}$/.test(c.fingerprint))).toBe(true);
    expect(wallet).not.toHaveProperty('cosigners.0.signerWallet');
    noPriv(r.body);
    // The tracking wallet in bitcoind must hold no private keys.
    const info = await rpc.call<{ private_keys_enabled: boolean }>('getwalletinfo', [], wallet.watchWallet);
    expect(info.private_keys_enabled).toBe(false);
  });

  it('lists the wallet and hands out bech32 P2WSH receive addresses', async () => {
    const list = await api().get('/api/wallets');
    expect(list.body.some((w: any) => w.id === id)).toBe(true);
    const a = await api().post(`/api/wallets/${id}/address`);
    expect(a.body.address).toMatch(/^bcrt1q[0-9a-z]{58}$/); // 32-byte witness program
  });

  it('is funded by mining to it (coinbase) and by the regtest faucet', async () => {
    const r = await api().post('/api/regtest/mine').send({ walletId: id, blocks: 1 });
    expect(r.status).toBe(200);
    const mined = (await api().get(`/api/wallets/${id}`)).body;
    expect(mined.balance.immature).toBeGreaterThan(0); // coinbase needs 100 confs before it can be spent
    const f = await fund(id, 5);
    expect(f.status).toBe(200);
    const d = await api().get(`/api/wallets/${id}`);
    expect(d.body.balance.confirmed).toBeGreaterThanOrEqual(5); // +coinbase if the faucet bootstrap matured it
    expect(d.status).toBe(200);
    expect(d.body.balance.confirmed).toBeGreaterThan(0);
    expect(d.body.utxos.length).toBeGreaterThanOrEqual(1);
    expect(d.body.history.map((h: any) => h.type).sort()).toEqual(['mined', 'received']);
    noPriv(d.body);
  });

  it('creates a funded PSBT that needs 2 signatures', async () => {
    const r = await api().post(`/api/wallets/${id}/psbt`).send({ outputs: [{ address: burn, amount: 1.25 }], feeRate: 2 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ required: 2, signatures: 0, complete: false });
    expect(r.body.fee).toBeGreaterThan(0);
    expect(r.body.outputs.find((o: any) => o.address === burn).amount).toBe(1.25);
    expect(r.body.outputs.some((o: any) => o.isChange)).toBe(true);
    psbtBase = r.body.psbt;
  });

  it('fails to finalize with only 1 of 2 signatures', async () => {
    const s1 = await api().post(`/api/wallets/${id}/psbt/sign`).send({ psbt: psbtBase, cosigner: 0 });
    expect(s1.status).toBe(200);
    expect(s1.body).toMatchObject({ signatures: 1, required: 2, complete: false });
    expect(s1.body.signedBy).toEqual([wallet.cosigners[0].fingerprint]);
    const f = await api().post(`/api/wallets/${id}/psbt/finalize`).send({ psbt: s1.body.psbt });
    expect(f.status).toBe(422);
    expect(f.body.error).toMatch(/Not enough signatures.*1\/2/);
    const b = await api().post(`/api/wallets/${id}/psbt/broadcast`).send({ psbt: s1.body.psbt });
    expect(b.status).toBe(422);
    // Same cosigner can't count twice.
    const again = await api().post(`/api/wallets/${id}/psbt/sign`).send({ psbt: s1.body.psbt, cosigner: 0 });
    expect(again.status).toBe(409);
  });

  it('sends with 2 signatures (sign separately, combine, finalize, broadcast)', async () => {
    const before = (await api().get(`/api/wallets/${id}`)).body.balance.confirmed;
    const a = await api().post(`/api/wallets/${id}/psbt/sign`).send({ psbt: psbtBase, cosigner: 0 });
    const c = await api().post(`/api/wallets/${id}/psbt/sign`).send({ psbt: psbtBase, cosigner: 2 });
    const comb = await api().post(`/api/wallets/${id}/psbt/combine`).send({ psbts: [a.body.psbt, c.body.psbt] });
    expect(comb.body).toMatchObject({ signatures: 2, complete: true });
    expect(comb.body.signedBy.sort()).toEqual([wallet.cosigners[0].fingerprint, wallet.cosigners[2].fingerprint].sort());
    const fin = await api().post(`/api/wallets/${id}/psbt/finalize`).send({ psbt: comb.body.psbt });
    expect(fin.status).toBe(200);
    expect(fin.body.hex).toMatch(/^[0-9a-f]+$/);
    const b = await api().post(`/api/wallets/${id}/psbt/broadcast`).send({ psbt: comb.body.psbt });
    expect(b.status).toBe(200);
    expect(b.body.txid).toBe(comb.body.txid);
    const mempool = await rpc.call<string[]>('getrawmempool');
    expect(mempool).toContain(b.body.txid);
    await mine(1);
    const d = (await api().get(`/api/wallets/${id}`)).body;
    const sent = d.history.find((h: any) => h.txid === b.body.txid);
    expect(sent).toMatchObject({ type: 'sent', confirmations: 1 });
    expect(sent.amount).toBeCloseTo(-1.25 - sent.fee, 8);
    expect(d.balance.confirmed).toBeLessThan(before);
  });

  it('also supports sequential signing', async () => {
    const p = await api().post(`/api/wallets/${id}/psbt`).send({ outputs: [{ address: burn, amount: 0.1 }] });
    const s1 = await api().post(`/api/wallets/${id}/psbt/sign`).send({ psbt: p.body.psbt, cosigner: 1 });
    const s2 = await api().post(`/api/wallets/${id}/psbt/sign`).send({ psbt: s1.body.psbt, cosigner: 2 });
    expect(s2.body).toMatchObject({ signatures: 2, complete: true });
    const b = await api().post(`/api/wallets/${id}/psbt/broadcast`).send({ psbt: s2.body.psbt });
    expect(b.status).toBe(200);
  });

  it('rejects bad PSBT requests', async () => {
    expect((await api().post(`/api/wallets/${id}/psbt`).send({ outputs: [{ address: 'nope', amount: 1 }] })).status).toBe(400);
    expect((await api().post(`/api/wallets/${id}/psbt`).send({ outputs: [{ address: burn, amount: -1 }] })).status).toBe(400);
    expect((await api().post(`/api/wallets/${id}/psbt`).send({ outputs: [{ address: burn, amount: 1e6 }] })).status).toBe(400);
    expect((await api().post(`/api/wallets/${id}/psbt/sign`).send({ psbt: 'garbage', cosigner: 0 })).status).toBe(400);
    expect((await api().get('/api/wallets/does-not-exist')).status).toBe(404);
  });
});

describe('other wallet types', () => {
  it('creates a single-sig wpkh wallet and spends with 1/1 signature', async () => {
    const r = await api().post('/api/wallets').send({ name: 'Spending', type: 'singlesig' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ type: 'singlesig', m: 1, n: 1, canSign: true });
    expect(r.body.descriptors.receive).toMatch(/^wpkh\(\[[0-9a-f]{8}\/84h\/1h\/0h\]tpub/);
    noPriv(r.body);
    const id = r.body.id;
    await fund(id, 2);
    const p = await api().post(`/api/wallets/${id}/psbt`).send({ outputs: [{ address: burn, amount: 0.5 }] });
    expect(p.body.required).toBe(1);
    const s = await api().post(`/api/wallets/${id}/psbt/sign`).send({ psbt: p.body.psbt, cosigner: 0 });
    expect(s.body.complete).toBe(true);
    expect((await api().post(`/api/wallets/${id}/psbt/broadcast`).send({ psbt: s.body.psbt })).status).toBe(200);
  });

  it('creates custom m-of-n multisig (3-of-5, 1-of-1) and rejects invalid m/n', async () => {
    const r = await api().post('/api/wallets').send({ name: 'Board 3of5', type: 'multisig', m: 3, n: 5, cosignerLabels: ['Alice', 'Bob'] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ m: 3, n: 5 });
    expect(r.body.cosigners.map((c: any) => c.label)).toEqual(['Alice', 'Bob', 'Cosigner C', 'Cosigner D', 'Cosigner E']);
    expect(r.body.descriptors.receive).toMatch(/^wsh\(sortedmulti\(3,/);
    const one = await api().post('/api/wallets').send({ name: 'Solo ms', type: 'multisig', m: 1, n: 1 });
    expect(one.status).toBe(201);
    for (const [m, n] of [[3, 2], [0, 2], [2, 16]]) {
      const bad = await api().post('/api/wallets').send({ name: 'bad', type: 'multisig', m, n });
      expect(bad.status).toBe(400);
    }
  });

  it('multisig with an external (hardware) key cannot be signed by that key locally', async () => {
    const tmp = await api().post('/api/wallets').send({ name: 'hw source', type: 'singlesig' });
    const hwKey = tmp.body.cosigners[0].key;
    const r = await api().post('/api/wallets').send({ name: 'With HW', type: 'multisig', m: 2, n: 3, externalKeys: [hwKey] });
    expect(r.status).toBe(201);
    expect(r.body.cosigners[0]).toMatchObject({ local: false, key: hwKey });
    expect(r.body.canSign).toBe(true); // 2 local keys still meet m=2
    const p = await api().post(`/api/wallets/${r.body.id}/psbt`).send({ outputs: [{ address: burn, amount: 0.1 }] });
    expect(p.status).toBe(400); // unfunded → insufficient funds
    await fund(r.body.id, 1);
    const p2 = await api().post(`/api/wallets/${r.body.id}/psbt`).send({ outputs: [{ address: burn, amount: 0.1 }] });
    const s1 = await api().post(`/api/wallets/${r.body.id}/psbt/sign`).send({ psbt: p2.body.psbt, cosigner: 1 });
    expect(s1.body.signatures).toBe(1);
    const ext = await api().post(`/api/wallets/${r.body.id}/psbt/sign`).send({ psbt: s1.body.psbt, cosigner: 0 });
    expect(ext.status).toBe(400);
    expect(ext.body.error).toMatch(/external key/);
  });

  it('imports a watch-only wallet by xpub and derives the same addresses', async () => {
    const src = await api().post('/api/wallets').send({ name: 'xpub source', type: 'singlesig' });
    const key: string = src.body.cosigners[0].key; // [fp/84h/1h/0h]tpub.../0/*
    const xpubOnly = key.match(/(tpub[1-9A-HJ-NP-Za-km-z]+)/)![1];
    const srcAddr = (await api().post(`/api/wallets/${src.body.id}/address`)).body.address;
    const r = await api().post('/api/wallets').send({ name: 'Watch xpub', type: 'watchonly', xpub: key });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ type: 'watchonly', canSign: false });
    expect(r.body.cosigners[0].local).toBe(false);
    const a = await api().post(`/api/wallets/${r.body.id}/address`);
    expect(a.body.address).toBe(srcAddr);
    await mine(1, srcAddr);
    const d = await api().get(`/api/wallets/${r.body.id}`);
    expect(d.body.balance.immature).toBeGreaterThan(0); // watch-only wallet tracks the coinbase
    // bare tpub (no origin) also works
    const bare = await api().post('/api/wallets').send({ name: 'Watch bare', type: 'watchonly', xpub: xpubOnly });
    expect(bare.status).toBe(201);
    // watch-only can build a PSBT but has no local signer
    const sign = await api().post(`/api/wallets/${r.body.id}/psbt/sign`).send({ psbt: 'cHNidP8BAAoCAAAAAAAAAAAAAAA=', cosigner: 0 });
    expect(sign.status).toBe(400);
  });

  it('imports a watch-only multisig by descriptor and detects m-of-n', async () => {
    const ms = await api().post('/api/wallets').send({ name: 'desc source', type: 'multisig' });
    const r = await api().post('/api/wallets').send({ name: 'Watch desc', type: 'watchonly', descriptor: ms.body.descriptors.receive });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ m: 2, n: 3, canSign: false });
    const a1 = (await api().post(`/api/wallets/${ms.body.id}/address`)).body.address;
    const a2 = (await api().post(`/api/wallets/${r.body.id}/address`)).body.address;
    expect(a2).toBe(a1);
  });

  it('refuses private keys and bad descriptors', async () => {
    const tprv = 'tprv8ZgxMBicQKsPd7Uf69XL1XwhmjHopUGep8GuEiJDZmbQz6o58LninorQAfcKZWARbtRtfnLcJ5MQ2AtHcQJCCRUcMRvmDUjyEmNUWwx8UbK';
    expect((await api().post('/api/wallets').send({ name: 'x', type: 'watchonly', descriptor: `wpkh(${tprv}/0/*)` })).status).toBe(400);
    expect((await api().post('/api/wallets').send({ name: 'x', type: 'watchonly', xpub: tprv })).status).toBe(400);
    expect((await api().post('/api/wallets').send({ name: 'x', type: 'watchonly', descriptor: 'wpkh(nonsense)' })).status).toBe(400);
    expect((await api().post('/api/wallets').send({ name: 'x', type: 'watchonly' })).status).toBe(400);
    expect((await api().post('/api/wallets').send({ name: '', type: 'multisig' })).status).toBe(400);
    expect((await api().post('/api/wallets').send({ name: 'x', type: 'weird' })).status).toBe(400);
  });
});
