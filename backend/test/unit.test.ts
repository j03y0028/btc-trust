import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { loadConfig } from '../src/config.js';
import { syncPercent } from '../src/service.js';
import { createApp } from '../src/app.js';
import { BitcoinRpc } from '../src/rpc.js';
import { STAGES } from '../src/stages.js';

describe('config', () => {
  it('defaults to regtest on port 18443', () => {
    const c = loadConfig({});
    expect(c.network).toBe('regtest');
    expect(c.rpcPort).toBe(18443);
  });
  it('refuses mainnet unless explicitly allowed', () => {
    expect(() => loadConfig({ BITCOIN_NETWORK: 'main' })).toThrow(/Mainnet is disabled/);
  });
  it('picks default port per network and honours overrides', () => {
    expect(loadConfig({ BITCOIN_NETWORK: 'signet' }).rpcPort).toBe(38332);
    expect(loadConfig({ BITCOIN_RPC_PORT: '1234' }).rpcPort).toBe(1234);
  });
  it('rejects unknown networks', () => {
    expect(() => loadConfig({ BITCOIN_NETWORK: 'foo' })).toThrow();
  });
});

describe('syncPercent', () => {
  it('is 100 when blocks == headers', () => {
    expect(syncPercent({ verificationprogress: 0.2, blocks: 5, headers: 5 })).toBe(100);
  });
  it('uses verificationprogress while syncing', () => {
    expect(syncPercent({ verificationprogress: 0.4567, blocks: 1, headers: 10 })).toBe(45.67);
  });
});

describe('stages', () => {
  it('lists 7 stages (0-6) with stages 0-5 complete', () => {
    expect(STAGES.map((s) => s.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(STAGES.filter((s) => s.status === 'complete').map((s) => s.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('API error handling', () => {
  const cfg = loadConfig({ BITCOIN_RPC_PORT: '1', BITCOIN_RPC_TIMEOUT_MS: '1000' });
  const app = createApp(cfg, new BitcoinRpc(cfg));
  it('health returns 503 when bitcoind unreachable', async () => {
    const r = await request(app).get('/api/health');
    expect(r.status).toBe(503);
    expect(r.body.ok).toBe(false);
  });
  it('blockchain returns 502 when bitcoind unreachable', async () => {
    const r = await request(app).get('/api/blockchain');
    expect(r.status).toBe(502);
  });
  it('blocks validates count', async () => {
    const r = await request(app).get('/api/blocks?count=abc');
    expect(r.status).toBe(400);
  });
});
