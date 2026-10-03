import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { BitcoinRpc } from '../src/rpc.js';
import { WalletStore } from '../src/store.js';
import { TimelineService } from '../src/timeline/service.js';
import { attachRealtime } from '../src/messaging/realtime.js';
import { allowedOrigin, isLoopback } from '../src/security.js';

const base = loadConfig();
const mk = (over: Partial<AppConfig['security']> = {}) => {
  const cfg: AppConfig = { ...base, dataDir: mkdtempSync(join(tmpdir(), 'btctrust-sec-')), security: { ...base.security, ...over } };
  const offline = new TimelineService(cfg, { fetch: async () => { throw new Error('offline'); }, attempts: 1 });
  return { cfg, app: createApp(cfg, new BitcoinRpc(cfg), new WalletStore(cfg.dataDir, cfg.network), null, offline) };
};

describe('security hardening', () => {
  it('binds to loopback by default and recognises loopback hosts', () => {
    expect(loadConfig({}).apiHost).toBe('127.0.0.1');
    expect(loadConfig({ API_HOST: '0.0.0.0' }).apiHost).toBe('0.0.0.0');
    expect(['127.0.0.1', 'localhost', '[::1]', '127.0.1.1'].every(isLoopback)).toBe(true);
    expect(isLoopback('0.0.0.0')).toBe(false);
    expect(isLoopback('192.168.1.10')).toBe(false);
  });
  it('sends helmet headers with a locked-down API CSP and no x-powered-by', async () => {
    const r = await request(mk().app).get('/api/stages');
    expect(r.status).toBe(200);
    expect(r.headers['content-security-policy']).toMatch(/default-src 'none'.*frame-ancestors 'none'/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['ratelimit-policy']).toBeDefined();
  });
  it('rejects foreign Host headers (DNS rebinding) unless explicitly allowed', async () => {
    const r = await request(mk().app).get('/api/stages').set('Host', 'attacker.example:4000');
    expect(r.status).toBe(421);
    expect((await request(mk({ allowedHosts: ['mynode.local'] }).app).get('/api/stages').set('Host', 'mynode.local')).status).toBe(200);
  });
  it('blocks cross-site state-changing requests (CSRF via text/plain or octet-stream)', async () => {
    const { app } = mk();
    const evil = await request(app).post('/api/regtest/mine').set('Origin', 'https://attacker.example').set('content-type', 'text/plain').send('x');
    expect(evil.status).toBe(403);
    const fetchMeta = await request(app).post('/api/wallets/x/psbt/import').set('Sec-Fetch-Site', 'cross-site').set('content-type', 'application/octet-stream').send(Buffer.from('psbt'));
    expect(fetchMeta.status).toBe(403);
    const ok = await request(app).post('/api/wallets/does-not-exist/address').set('Origin', 'http://127.0.0.1:5173');
    expect(ok.status).toBe(404); // passed the guard, reached the route
    expect((await request(app).get('/api/stages').set('Origin', 'https://attacker.example')).status).toBe(200); // reads are CORS-protected instead
    expect(allowedOrigin(mk().cfg, 'null')).toBe(false);
  });
  it('rate-limits sensitive and outbound endpoints', async () => {
    const { app } = mk({ rateLimit: { general: 1000, sensitive: 2, outbound: 1 } });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await request(app).post('/api/vaults/nope/unlock').send({ passphrase: 'x' })).status);
    expect(codes[2]).toBe(429);
    expect(codes.slice(0, 2)).not.toContain(429);
    expect((await request(app).post('/api/mainnet/snapshot')).status).toBe(502); // offline public APIs
    const second = await request(app).post('/api/mainnet/snapshot');
    expect(second.status).toBe(429);
    expect(second.body.error).toMatch(/outbound/);
  });
  describe('WebSocket upgrade origin check', () => {
    const { cfg, app } = mk();
    const server = app.listen(0, '127.0.0.1');
    attachRealtime(server, app.locals.messaging, cfg);
    afterAll(() => new Promise<void>((r) => server.close(() => r())));
    const url = () => `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/ws`;
    const tryWs = (origin: string) => new Promise<string>((resolve) => {
      const ws = new WebSocket(url(), { origin });
      ws.on('open', () => { ws.close(); resolve('open'); });
      ws.on('unexpected-response', (_req, res) => resolve(String(res.statusCode)));
      ws.on('error', () => resolve('error'));
    });
    it('refuses cross-site origins and accepts the app origin', async () => {
      expect(await tryWs('https://attacker.example')).toBe('403');
      expect(await tryWs('http://127.0.0.1:5173')).toBe('open');
    });
  });
});

describe('file permissions', () => {
  it('tightens world-readable data files to owner-only', async () => {
    const { writeFileSync, mkdirSync, statSync, chmodSync } = await import('node:fs');
    const { hardenFilePermissions } = await import('../src/security.js');
    const old = process.umask();
    const d = mkdtempSync(join(tmpdir(), 'btctrust-perm-'));
    mkdirSync(join(d, 'vaults')); writeFileSync(join(d, 'vaults', 'v.json'), '{}'); writeFileSync(join(d, 'w.json'), '{}');
    chmodSync(d, 0o755); chmodSync(join(d, 'vaults'), 0o755); chmodSync(join(d, 'w.json'), 0o644); chmodSync(join(d, 'vaults', 'v.json'), 0o644);
    hardenFilePermissions(d);
    try {
      expect(statSync(d).mode & 0o777).toBe(0o700);
      expect(statSync(join(d, 'vaults')).mode & 0o777).toBe(0o700);
      expect(statSync(join(d, 'w.json')).mode & 0o777).toBe(0o600);
      expect(statSync(join(d, 'vaults', 'v.json')).mode & 0o777).toBe(0o600);
      writeFileSync(join(d, 'new.json'), '{}');
      expect(statSync(join(d, 'new.json')).mode & 0o777).toBe(0o600);
    } finally { process.umask(old); }
  });
});
