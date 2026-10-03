import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { BitcoinRpc } from '../src/rpc.js';
import { TimelineService } from '../src/timeline/service.js';
import { B, fakeFetch } from './timeline-mocks.js';

// Public APIs are mocked (real mainnet headers as fixtures); regtest node is not needed for these routes.
const cfg = { ...loadConfig(), dataDir: mkdtempSync(join(tmpdir(), 'btctrust-tl-int-')) };
const T = { hash: B(840000).hash, height: 840000 };
const timeline = new TimelineService(cfg, { fetch: fakeFetch({ 'mempool.space': { tip: T }, 'blockstream.info': { fail: 429 }, 'mempool.emzy.de': { tip: T } }), attempts: 1 });
const app = createApp(cfg, new BitcoinRpc(cfg), undefined, null, timeline);

describe('timeline & goals API', () => {
  it('POST /api/mainnet/snapshot creates today once, then is idempotent', async () => {
    const a = await request(app).post('/api/mainnet/snapshot');
    expect(a.status).toBe(201);
    expect(a.body.snapshot).toMatchObject({ height: 840000, primary: 'mempool.space', check: { status: 'agree' } });
    const b = await request(app).post('/api/mainnet/snapshot');
    expect(b.status).toBe(200);
    expect(b.body.created).toBe(false);
  });
  it('GET /api/timeline returns cached FRED series with source links, cited events and verified chain milestones', async () => {
    const r = await request(app).get('/api/timeline?since=2008-01-01');
    expect(r.status).toBe(200);
    expect(r.body.errors).toEqual([]);
    expect(r.body.series.map((s: { id: string }) => s.id)).toEqual(['CPIAUCSL', 'M2SL', 'FEDFUNDS', 'GDP', 'UNRATE']);
    for (const s of r.body.series) expect(s).toMatchObject({ sourceUrl: `https://fred.stlouisfed.org/series/${s.id}`, csvUrl: expect.stringContaining(`id=${s.id}`), fetchedAt: expect.any(String) });
    const titles = r.body.events.map((e: { title: string }) => e.title);
    expect(titles).toEqual(expect.arrayContaining(['Bitcoin white paper published', 'Genesis block mined', 'Lehman Brothers files for bankruptcy', 'CARES Act']));
    expect(r.body.events.every((e: { citation: string }) => /^https:\/\//.test(e.citation))).toBe(true);
    expect(r.body.reference.genesis.headline).toBe('The Times 03/Jan/2009 Chancellor on brink of second bailout for banks');
    expect(r.body.whitepaper).toMatchObject({ matches: true, localPath: '/bitcoin.pdf' });
  });
  it('GET /api/mainnet/daily summarizes growth, streak and the next-halving estimate', async () => {
    const r = await request(app).get('/api/mainnet/daily');
    expect(r.body).toMatchObject({ hasToday: true, streakDays: 1, growing: true, blocksSinceGenesis: 840000, nodeConfigured: false });
    expect(r.body.daysSinceWhitepaper).toBeGreaterThan(6000);
    expect(r.body.nextHalving).toMatchObject({ target: 1050000, remaining: 210000 });
  });
  it('GET /api/progress reads stage commits and test counts from git', async () => {
    const r = await request(app).get('/api/progress');
    expect(r.body.stages).toHaveLength(7);
    const s5 = r.body.stages.find((s: { id: number }) => s.id === 5);
    expect(s5.commit.short).toBe('e31f8e9');
    expect(s5.tests).toMatchObject({ backend: 106, frontend: 30 });
    expect(r.body.stages[0].commit.short).toBe('c83917b');
    expect(r.body.backlog.map((b: { title: string }) => b.title)).toEqual(expect.arrayContaining(['Tor transport', 'myNode packaging']));
  });
});
