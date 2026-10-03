import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { BitcoinRpc } from '../src/rpc.js';
import { WalletStore } from '../src/store.js';
import { TimelineService } from '../src/timeline/service.js';
import { AuthService, COOKIE, authRequired } from '../src/auth.js';
import { attachRealtime } from '../src/messaging/realtime.js';

const PASS = 'correct horse battery staple';
const base = loadConfig();
function mk(over: Partial<AppConfig> = {}, now?: () => number) {
  const cfg: AppConfig = { ...base, apiHost: '0.0.0.0', dataDir: mkdtempSync(join(tmpdir(), 'auth-')), auth: { ...base.auth, mode: 'auto', scryptN: 2 ** 12 }, ...over };
  const auth = new AuthService(cfg, now);
  const tl = new TimelineService(cfg, { node: null, fetch: async () => { throw new Error('offline'); }, attempts: 1 });
  return { cfg, auth, app: createApp(cfg, new BitcoinRpc(cfg), new WalletStore(cfg.dataDir, cfg.network), null, tl, auth) };
}
const cookieOf = (r: request.Response) => {
  const c = ([] as string[]).concat(r.headers['set-cookie'] ?? []).find((x) => x.startsWith(COOKIE + '='));
  return c ? c.split(';')[0] : '';
};
async function setUp(app: ReturnType<typeof mk>['app'], auth: AuthService) {
  const r = await request(app).post('/api/auth/setup').send({ passphrase: PASS, setupToken: auth.pendingSetupToken });
  expect(r.status).toBe(201);
  return cookieOf(r);
}

describe('app login', () => {
  it('is required exactly when the API binds beyond loopback', () => {
    const a = (apiHost: string, mode: AppConfig['auth']['mode']) => authRequired({ apiHost, auth: { ...base.auth, mode } });
    expect(a('127.0.0.1', 'auto')).toBe(false);
    expect(a('0.0.0.0', 'auto')).toBe(true);
    expect(a('192.168.1.20', 'auto')).toBe(true);
    expect(a('127.0.0.1', 'on')).toBe(true);
    expect(a('127.0.0.1', 'off')).toBe(false);
    expect(() => a('0.0.0.0', 'off')).toThrow(/mandatory beyond localhost/);
  });

  it('locks every API route until first-run setup with the one-time token', async () => {
    const { app, auth, cfg } = mk();
    const token = auth.pendingSetupToken!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{20}$/);
    expect(readFileSync(join(cfg.dataDir, 'setup-token'), 'utf8').trim()).toBe(token);
    expect(statSync(join(cfg.dataDir, 'setup-token')).mode & 0o777).toBe(0o600);
    for (const p of ['/api/stages', '/api/wallets', '/api/blockchain', '/api/mode', '/api/progress', '/api/health']) {
      const r = await request(app).get(p);
      expect(r.status, p).toBe(401);
      expect(r.headers['x-auth-required']).toBe('1');
    }
    expect((await request(app).post('/api/regtest/mine').set('content-type', 'application/json').send({})).status).toBe(401);
    expect((await request(app).get('/api/healthz')).body).toEqual({ ok: true });
    expect((await request(app).get('/api/auth/status')).body).toEqual({ required: true, configured: false, authenticated: false, setupTokenRequired: true, minLength: 12 });

    expect((await request(app).post('/api/auth/setup').send({ passphrase: PASS, setupToken: 'wrong' })).status).toBe(403);
    expect((await request(app).post('/api/auth/setup').send({ passphrase: PASS })).status).toBe(403);
    expect((await request(app).post('/api/auth/setup').send({ passphrase: 'short', setupToken: token })).status).toBe(400);
    const r = await request(app).post('/api/auth/setup').send({ passphrase: PASS, setupToken: token });
    expect(r.status).toBe(201);
    const set = ([] as string[]).concat(r.headers['set-cookie']).join(';');
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    expect(set).not.toMatch(/Secure/i); // plain http on the LAN
    expect(existsSync(join(cfg.dataDir, 'setup-token'))).toBe(false);
    const rec = readFileSync(join(cfg.dataDir, 'auth.json'), 'utf8');
    expect(rec).not.toContain(PASS);
    expect(JSON.parse(rec)).toMatchObject({ v: 1, kdf: 'scrypt', N: 4096, r: 8, p: 1 });
    expect(statSync(join(cfg.dataDir, 'auth.json')).mode & 0o777).toBe(0o600);

    const c = cookieOf(r);
    expect((await request(app).get('/api/stages').set('Cookie', c)).status).toBe(200);
    expect((await request(app).get('/api/auth/status').set('Cookie', c)).body.authenticated).toBe(true);
    expect((await request(app).post('/api/auth/setup').send({ passphrase: PASS, setupToken: token })).status).toBe(409);
  });

  it('logs in, logs out and rejects forged or stale cookies', async () => {
    const { app, auth } = mk();
    await setUp(app, auth);
    expect((await request(app).post('/api/auth/login').send({ passphrase: 'not it at all' })).status).toBe(401);
    const r = await request(app).post('/api/auth/login').send({ passphrase: PASS });
    expect(r.status).toBe(200);
    const c = cookieOf(r);
    expect((await request(app).get('/api/stages').set('Cookie', c)).status).toBe(200);
    expect((await request(app).get('/api/stages').set('Cookie', `${COOKIE}=forged`)).status).toBe(401);
    await request(app).post('/api/auth/logout').set('Cookie', c);
    expect((await request(app).get('/api/stages').set('Cookie', c)).status).toBe(401);
  });

  it('sets Secure behind the HTTPS proxy (myNode nginx :9331)', async () => {
    const { app, auth } = mk();
    const r = await request(app).post('/api/auth/setup').set('X-Forwarded-Proto', 'https').send({ passphrase: PASS, setupToken: auth.pendingSetupToken });
    expect(([] as string[]).concat(r.headers['set-cookie']).join(';')).toMatch(/Secure/);
  });

  it('locks out after repeated wrong passphrases', async () => {
    let t = 1_000_000;
    const { app, auth } = mk({}, () => t);
    await setUp(app, auth);
    for (let i = 0; i < 5; i++) expect((await request(app).post('/api/auth/login').send({ passphrase: 'wrong wrong wrong' })).status).toBe(401);
    const locked = await request(app).post('/api/auth/login').send({ passphrase: PASS });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
    t += 60_000;
    expect((await request(app).post('/api/auth/login').send({ passphrase: PASS })).status).toBe(200);
  });

  it('expires idle sessions and revokes all sessions on passphrase change', async () => {
    let t = 5_000_000;
    const { app, auth, cfg } = mk({}, () => t);
    const c1 = await setUp(app, auth);
    t += cfg.auth.sessionIdleMs + 1;
    expect((await request(app).get('/api/stages').set('Cookie', c1)).status).toBe(401);
    const c2 = cookieOf(await request(app).post('/api/auth/login').send({ passphrase: PASS }));
    const c3 = cookieOf(await request(app).post('/api/auth/login').send({ passphrase: PASS }));
    expect((await request(app).post('/api/auth/passphrase').set('Cookie', c2).send({ current: 'nope', next: 'another long passphrase' })).status).toBe(401);
    const ch = await request(app).post('/api/auth/passphrase').set('Cookie', c2).send({ current: PASS, next: 'another long passphrase' });
    expect(ch.status).toBe(200);
    expect((await request(app).get('/api/stages').set('Cookie', c3)).status).toBe(401);
    expect((await request(app).get('/api/stages').set('Cookie', cookieOf(ch))).status).toBe(200);
    expect((await request(app).post('/api/auth/login').send({ passphrase: 'another long passphrase' })).status).toBe(200);
  });

  it('is off on loopback by default and refuses AUTH_MODE=off beyond it', () => {
    const { auth } = mk({ apiHost: '127.0.0.1' });
    expect(auth.required).toBe(false);
    expect(auth.pendingSetupToken).toBeNull();
    expect(() => mk({ auth: { ...base.auth, mode: 'off' } })).toThrow(/mandatory/);
  });

  it('accepts LAN IP / .onion / configured Host headers but not unknown domains', async () => {
    const { app } = mk();
    for (const h of ['192.168.1.50:9330', 'mynode.local:9330', 'abcdefghijklmnopqrstuvwxyz234567abcdefghijklmnopqrstuv.onion', '[fd00::5]:9330']) {
      const r = await request(app).get('/api/auth/status').set('Host', h);
      expect(r.status, h).toBe(h.startsWith('mynode') ? 421 : 200);
    }
    const { app: app2 } = mk({ security: { ...base.security, allowedHosts: ['mynode.local'] } });
    expect((await request(app2).get('/api/auth/status').set('Host', 'mynode.local:9331')).status).toBe(200);
    expect((await request(app2).get('/api/auth/status').set('Host', 'evil.example')).status).toBe(421);
  });

  it('serves the built SPA on the same port with the app CSP, API 404s stay JSON', async () => {
    const { app } = mk({ staticDir: join(import.meta.dirname, 'fixtures/static') });
    const page = await request(app).get('/');
    expect(page.status).toBe(200);
    expect(page.text).toContain('<div id=root>');
    expect(page.headers['content-security-policy']).toMatch(/script-src 'self';.*frame-ancestors 'none'/);
    expect(page.headers['cache-control']).toBe('no-store');
    expect((await request(app).get('/app.js')).status).toBe(200); // assets need no login (no data)
    const api = await request(app).get('/api/nope');
    expect(api.status).toBe(401); // login first…
    expect(api.headers['content-security-policy']).toMatch(/default-src 'none'/);
  });

  describe('WebSocket', () => {
    const { app, auth, cfg } = mk();
    const server = app.listen(0, '127.0.0.1');
    attachRealtime(server, app.locals.messaging, cfg, auth);
    afterAll(() => new Promise<void>((r) => server.close(() => r())));
    const tryWs = (cookie?: string) => new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/ws`, { origin: 'http://127.0.0.1:9330', headers: cookie ? { cookie } : {} });
      ws.on('open', () => { ws.close(); resolve('open'); });
      ws.on('unexpected-response', (_q, res) => resolve(String(res.statusCode)));
      ws.on('error', () => resolve('error'));
    });
    it('needs the session cookie', async () => {
      expect(await tryWs()).toBe('401');
      const c = await setUp(app, auth);
      expect(await tryWs(c)).toBe('open');
    });
  });
});
