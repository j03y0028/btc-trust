import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { BitcoinRpc } from '../src/rpc.js';

// Requires a running regtest bitcoind configured via .env (see README).
const cfg = loadConfig();
const rpc = new BitcoinRpc(cfg);
const app = createApp(cfg, rpc);
const WALLET = 'btctrust-test-miner';
let minerAddress = '';

beforeAll(async () => {
  const chain = (await rpc.call<{ chain: string }>('getblockchaininfo')).chain;
  if (chain !== 'regtest') throw new Error(`Integration tests only run on regtest (node is on ${chain})`);
  const loaded = await rpc.call<string[]>('listwallets');
  if (!loaded.includes(WALLET)) {
    try {
      await rpc.call('loadwallet', [WALLET]);
    } catch {
      await rpc.call('createwallet', [WALLET]);
    }
  }
  minerAddress = await rpc.call<string>('getnewaddress', ['', 'bech32'], WALLET);
});

describe('regtest integration', () => {
  it('health reports rpc connected', async () => {
    const r = await request(app).get('/api/health');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, network: 'regtest' });
  });

  it('blockchain summary has expected shape', async () => {
    const r = await request(app).get('/api/blockchain');
    expect(r.status).toBe(200);
    expect(r.body.network).toBe('regtest');
    expect(r.body.bestBlockHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof r.body.height).toBe('number');
    expect(typeof r.body.difficulty).toBe('number');
    expect(r.body.mempool).toHaveProperty('size');
    expect(r.body.syncProgressPct).toBeGreaterThanOrEqual(0);
  });

  it('height increments after generatetoaddress', async () => {
    const before = (await request(app).get('/api/blockchain')).body;
    const hashes = await rpc.call<string[]>('generatetoaddress', [3, minerAddress]);
    expect(hashes).toHaveLength(3);
    const after = (await request(app).get('/api/blockchain')).body;
    expect(after.height).toBe(before.height + 3);
    expect(after.bestBlockHash).toBe(hashes[2]);
    expect(after.syncProgressPct).toBe(100);
  });

  it('recent blocks are ordered newest-first and link to tip', async () => {
    await rpc.call('generatetoaddress', [2, minerAddress]);
    const tip = await rpc.call<number>('getblockcount');
    const r = await request(app).get('/api/blocks?count=5');
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(5);
    expect(r.body[0].height).toBe(tip);
    for (let i = 1; i < r.body.length; i++) expect(r.body[i].height).toBe(r.body[i - 1].height - 1);
    expect(r.body[0].txCount).toBeGreaterThanOrEqual(1);
  });

  it('mempool size reflects a pending transaction', async () => {
    // Make sure the test wallet has mature coins (coinbase needs 100 confs).
    await rpc.call('generatetoaddress', [101, minerAddress]);
    const dest = await rpc.call<string>('getnewaddress', [], WALLET);
    await rpc.call('sendtoaddress', [dest, 0.1], WALLET);
    const r = await request(app).get('/api/blockchain');
    expect(r.body.mempool.size).toBeGreaterThanOrEqual(1);
    await rpc.call('generatetoaddress', [1, minerAddress]);
    const r2 = await request(app).get('/api/blockchain');
    expect(r2.body.mempool.size).toBe(0);
  });
});
