// BTC → fiat display prices: source parsing, exact integer math, caching, fallback, failure, routes, CSRF, login.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type AppConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { WalletStore } from '../src/store.js';
import type { BitcoinRpc } from '../src/rpc.js';
import { TimelineService } from '../src/timeline/service.js';
import { AuthService, COOKIE } from '../src/auth.js';
import { CURRENCIES, PriceService, SOURCES, toE8 } from '../src/prices.js';
import { SPA_CSP } from '../src/security.js';
import { READ_ONLY_METHODS } from '../src/readonly-rpc.js';

// Response bodies in the real shapes (captured 2026-10-03)
const BODIES: Record<string, unknown> = {
  'mempool.space': { time: 1791081305, USD: 84822, EUR: 75379, GBP: 64122, CAD: 121025, CHF: 70277, AUD: 122103, JPY: 13408005 },
  'api.coinbase.com': { data: { currency: 'BTC', rates: { USD: '84830.105', EUR: '75390.5', MXN: '1554321.987654321', JPY: '13409000', AAVE: '465.87', BTC: '1.0' } } },
  'api.kraken.com': { error: [], result: { XXBTZUSD: { c: ['84825.10000', '0.001'] }, XBTCHF: { c: ['70280.0', '0.1'] }, XBTAUD: { c: ['122134.30000', '0.0006'] }, XXBTZJPY: { c: ['13409100', '0.01'] } } },
  'mempool.emzy.de': { time: 1791081300, USD: 84800, EUR: 75370, GBP: 64100, CAD: 121000, CHF: 70270, AUD: 122100, JPY: 13407000 },
  'api.coingecko.com': { bitcoin: { usd: 84850.5, mxn: 1554400, pln: 330000.12, last_updated_at: 1791081290 } },
};
type Mode = 'ok' | 'fail' | 'hang' | 'garbage' | 'bad-value' | 429;
function fakeFetch(modes: Record<string, Mode> = {}) {
  const calls: string[] = [];
  const f = async (url: string, init?: RequestInit) => {
    const host = new URL(url).host;
    calls.push(host);
    const m = modes[host] ?? 'ok';
    if (m === 'fail') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    if (m === 'hang') return new Promise<Response>((_r, rej) => init?.signal?.addEventListener('abort', () => rej(init.signal!.reason)));
    if (m === 429) return new Response('{"status":{"error_code":429}}', { status: 429 });
    if (m === 'garbage') return new Response('<html>oops</html>', { status: 200 });
    if (m === 'bad-value') return new Response(JSON.stringify({ time: 1, USD: -5, EUR: '1e5', GBP: 0, JPY: 'NaN' }), { status: 200 });
    return new Response(JSON.stringify(BODIES[host]), { status: 200 });
  };
  return { f, calls };
}
const clock = (t = 1_791_081_400_000) => { const c = { t, now: () => c.t }; return c; };

describe('price sources (real response shapes)', () => {
  it('parses mempool.space, Coinbase, Kraken, mempool.emzy.de and CoinGecko', async () => {
    const want: Record<string, [string, string][]> = {
      mempool: [['USD', '84822'], ['JPY', '13408005']],
      coinbase: [['USD', '84830.105'], ['MXN', '1554321.987654321']],
      kraken: [['USD', '84825.10000'], ['CHF', '70280.0'], ['AUD', '122134.30000'], ['JPY', '13409100']],
      emzy: [['EUR', '75370']],
      coingecko: [['USD', '84850.5'], ['PLN', '330000.12']],
    };
    for (const [id, pairs] of Object.entries(want)) {
      const { f } = fakeFetch();
      const svc = new PriceService({ order: [id], fetch: f });
      for (const [c, p] of pairs) {
        const r = await svc.price(c as 'USD');
        expect(r, `${id} ${c}`).toMatchObject({ available: true, price: p, source: SOURCES[id].name, stale: false });
      }
    }
  });
  it('Coinbase ignores crypto codes; only listed fiat currencies are kept', () => {
    const t = SOURCES.coinbase.parse(BODIES['api.coinbase.com']).table;
    expect(Object.keys(t).sort()).toEqual(['EUR', 'JPY', 'MXN', 'USD']);
  });
  it('every source URL is https and needs no API key', () => {
    for (const s of Object.values(SOURCES)) { expect(s.url).toMatch(/^https:\/\//); expect(s.url).not.toMatch(/key|token/i); }
  });
});

describe('exact integer math', () => {
  it('toE8 keeps 8 decimals exactly (no float)', () => {
    expect(toE8('84822')).toBe(8_482_200_000_000n);
    expect(toE8('84830.105')).toBe(8_483_010_500_000n);
    expect(toE8('1554321.987654321')).toBe(155_432_198_765_432n);   // truncated past 8 decimals
    expect(toE8('0.1')).toBe(10_000_000n);
  });
  it('the API result carries priceE8 as a string', async () => {
    const { f } = fakeFetch();
    const r = await new PriceService({ order: ['coinbase'], fetch: f }).price('USD');
    expect(r).toMatchObject({ priceE8: '8483010500000' });
  });
});

describe('caching', () => {
  it('serves from cache for 60 s (one request for many readers), refetches after', async () => {
    const { f, calls } = fakeFetch(); const c = clock();
    const svc = new PriceService({ fetch: f, now: c.now });
    await Promise.all([svc.price('USD'), svc.price('USD'), svc.price('EUR')]);   // concurrent → one request
    expect(calls).toEqual(['mempool.space']);
    c.t += 59_000; expect(await svc.price('GBP')).toMatchObject({ available: true, ageMs: 59_000 });
    expect(calls).toHaveLength(1);
    c.t += 2_000; await svc.price('USD');
    expect(calls).toEqual(['mempool.space', 'mempool.space']);
  });
  it('the cache TTL is configurable via PRICE_CACHE_MS', () => {
    expect(loadConfig({ PRICE_CACHE_MS: '120000' }).prices).toMatchObject({ ttlMs: 120_000, enabled: true, timeoutMs: 5000 });
    expect(loadConfig({ PRICE_FEED: 'off' }).prices?.enabled).toBe(false);
    expect(loadConfig({ PRICE_SOURCES: 'kraken, coinbase' }).prices?.order).toEqual(['kraken', 'coinbase']);
  });
});

describe('fallback and failure', () => {
  it('falls back to the next source when the first fails, and says which source answered', async () => {
    const { f, calls } = fakeFetch({ 'mempool.space': 'fail' });
    const r = await new PriceService({ fetch: f }).price('USD');
    expect(r).toMatchObject({ available: true, source: 'Coinbase', price: '84830.105' });
    expect(calls).toEqual(['mempool.space', 'api.coinbase.com']);
  });
  it('skips sources that do not list the currency (MXN goes straight to Coinbase)', async () => {
    const { f, calls } = fakeFetch();
    expect(await new PriceService({ fetch: f }).price('MXN')).toMatchObject({ source: 'Coinbase' });
    expect(calls).toEqual(['api.coinbase.com']);
  });
  it('treats HTTP 429, non-JSON and bad values as failures', async () => {
    for (const m of [429, 'garbage', 'bad-value'] as Mode[]) {
      const { f } = fakeFetch({ 'mempool.space': m });
      expect(await new PriceService({ fetch: f }).price('USD'), String(m)).toMatchObject({ available: true, source: 'Coinbase' });
    }
  });
  it('times out a hanging source and moves on', async () => {
    const { f } = fakeFetch({ 'mempool.space': 'hang' });
    const t0 = Date.now();
    const r = await new PriceService({ fetch: f, timeoutMs: 50 }).price('USD');
    expect(r).toMatchObject({ available: true, source: 'Coinbase' });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
  it('does not retry a failed source during the backoff window', async () => {
    const { f, calls } = fakeFetch({ 'mempool.space': 'fail' }); const c = clock();
    const svc = new PriceService({ fetch: f, now: c.now, failBackoffMs: 300_000 });
    await svc.price('USD'); c.t += 61_000; await svc.price('USD');
    expect(calls.filter((h) => h === 'mempool.space')).toHaveLength(1);
    c.t += 300_000; await svc.price('USD');
    expect(calls.filter((h) => h === 'mempool.space')).toHaveLength(2);
  });
  it('serves the last good price marked stale when every source fails, then reports unavailable', async () => {
    const modes: Record<string, Mode> = {};
    const { f } = fakeFetch(modes); const c = clock();
    const svc = new PriceService({ fetch: f, now: c.now, staleMaxMs: 30 * 60_000, failBackoffMs: 0 });
    expect(await svc.price('USD')).toMatchObject({ available: true, stale: false });
    for (const h of Object.keys(BODIES)) modes[h] = 'fail';
    c.t += 5 * 60_000;
    expect(await svc.price('USD')).toMatchObject({ available: true, stale: true, source: 'mempool.space', ageMs: 300_000 });
    c.t += 30 * 60_000;
    const r = await svc.price('USD');
    expect(r.available).toBe(false);
    expect(r).toMatchObject({ error: expect.stringMatching(/^Price unavailable: mempool\.space: ECONNREFUSED; Coinbase: ECONNREFUSED/) });
  });
  it('PRICE_FEED=off: never calls out, says so', async () => {
    const { f, calls } = fakeFetch();
    expect(await new PriceService({ enabled: false, fetch: f }).price('USD')).toMatchObject({ available: false, disabled: true });
    expect(calls).toEqual([]);
  });
});

// ---------- HTTP routes ----------
const base = loadConfig();
const rpc = { async call() { return null; } } as unknown as BitcoinRpc;
function mk(over: Partial<AppConfig> = {}, svc = new PriceService({ fetch: fakeFetch().f }), auth?: AuthService) {
  const cfg: AppConfig = { ...base, network: 'regtest', dataDir: mkdtempSync(join(tmpdir(), 'btctrust-prices-')), ...over };
  const tl = new TimelineService(cfg, { node: null, fetch: async () => { throw new Error('offline'); }, attempts: 1 });
  return { app: createApp(cfg, rpc, new WalletStore(cfg.dataDir, cfg.network), null, tl, auth, svc), cfg, svc };
}

describe('GET /api/prices', () => {
  it('returns the price with source and time; rejects unknown currencies', async () => {
    const { app } = mk();
    const r = await request(app).get('/api/prices?currency=eur');
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.body).toMatchObject({ available: true, currency: 'EUR', price: '75379', priceE8: '7537900000000', source: 'mempool.space', sourceTime: 1791081305000 });
    expect((await request(app).get('/api/prices?currency=XYZ')).status).toBe(400);
    expect((await request(app).get('/api/prices?currency=BTC')).status).toBe(400);
  });
  it('a failing feed is 200 with available:false (the UI shows "price unavailable")', async () => {
    const all: Record<string, Mode> = Object.fromEntries(Object.keys(BODIES).map((h) => [h, 'fail' as Mode]));
    const { app } = mk({}, new PriceService({ fetch: fakeFetch(all).f }));
    const r = await request(app).get('/api/prices?currency=USD');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ available: false, currency: 'USD' });
  });
  it('lists the supported currencies', async () => {
    const r = await request(mk().app).get('/api/prices/currencies');
    expect(r.body.currencies).toHaveLength(CURRENCIES.length);
    expect(r.body.currencies.map((c: { code: string }) => c.code)).toEqual(expect.arrayContaining(['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'MXN']));
    expect(r.body.enabled).toBe(true);
  });
  it('browser policy is unchanged: SPA connect-src stays self (+ws), mainnet allowlist still 15 read-only methods', () => {
    expect(SPA_CSP).toContain("connect-src 'self' ws: wss:");
    expect(SPA_CSP).not.toMatch(/mempool|coinbase|kraken|coingecko/);
    expect(READ_ONLY_METHODS).toHaveLength(15);
  });
});

describe('display settings', () => {
  it('defaults to BTC + USD, saves server-side and survives a restart', async () => {
    const { app, cfg } = mk();
    expect((await request(app).get('/api/settings/display')).body).toEqual({ unit: 'BTC', fiat: 'USD' });
    expect((await request(app).put('/api/settings/display').send({ fiat: 'JPY' })).body).toEqual({ unit: 'BTC', fiat: 'JPY' });
    expect((await request(app).put('/api/settings/display').send({ unit: 'sats', fiat: null })).body).toEqual({ unit: 'sats', fiat: null });
    const again = mk({ dataDir: cfg.dataDir }).app;
    expect((await request(again).get('/api/settings/display')).body).toEqual({ unit: 'sats', fiat: null });
  });
  it.each([
    [{ unit: 'mBTC' }], [{ fiat: 'XYZ' }], [{ fiat: 'usd' }], [{ fiat: 5 }], [{ unit: 'BTC', extra: 1 }], [[1]],
  ])('rejects %j (400)', async (body) => {
    const { app } = mk();
    expect((await request(app).put('/api/settings/display').send(body as object)).status).toBe(400);
    expect((await request(app).get('/api/settings/display')).body).toEqual({ unit: 'BTC', fiat: 'USD' });
  });
  it('blocks cross-site writes (CSRF)', async () => {
    const { app } = mk();
    expect((await request(app).put('/api/settings/display').set('Origin', 'https://evil.example').send({ fiat: 'EUR' })).status).toBe(403);
    expect((await request(app).put('/api/settings/display').set('Sec-Fetch-Site', 'cross-site').send({ fiat: 'EUR' })).status).toBe(403);
    expect((await request(app).get('/api/settings/display')).body.fiat).toBe('USD');
    expect((await request(app).put('/api/settings/display').set('Origin', 'http://127.0.0.1:9330').set('Sec-Fetch-Site', 'same-origin').send({ fiat: 'EUR' })).status).toBe(200);
  });
  it('prices and settings require the app login when auth is on', async () => {
    const authCfg: AppConfig = { ...base, apiHost: '0.0.0.0', network: 'regtest', dataDir: mkdtempSync(join(tmpdir(), 'btctrust-prices-auth-')), auth: { ...base.auth, mode: 'auto' as const, scryptN: 2 ** 12 } };
    const auth = new AuthService(authCfg);
    const { f, calls } = fakeFetch();
    const { app } = mk(authCfg, new PriceService({ fetch: f }), auth);
    expect((await request(app).get('/api/prices?currency=USD')).status).toBe(401);
    expect((await request(app).get('/api/settings/display')).status).toBe(401);
    expect((await request(app).put('/api/settings/display').send({ fiat: 'EUR' })).status).toBe(401);
    expect(calls).toEqual([]);   // no outbound call for anonymous visitors
    const setup = await request(app).post('/api/auth/setup').send({ passphrase: 'correct horse battery staple', setupToken: auth.pendingSetupToken });
    const cookie = ([] as string[]).concat(setup.headers['set-cookie'] ?? []).find((x) => x.startsWith(COOKIE + '='))!.split(';')[0];
    expect((await request(app).get('/api/prices?currency=USD').set('Cookie', cookie)).body).toMatchObject({ available: true });
  });
});
