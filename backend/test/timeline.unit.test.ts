import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GENESIS_HASH, WHITEPAPER, daysBetween, estimateHeightDate, parseCoinbase, parseHeader, verifyGenesis } from '../src/timeline/chain.js';
import { FredCache, parseFredCsv } from '../src/timeline/fred.js';
import { MainnetService, crossCheck, localDate, streak, type SourceTip, type Snapshot } from '../src/timeline/mainnet.js';
import { US_EVENTS } from '../src/timeline/events.js';
import { verifyWhitepaper, WHITEPAPER_FILE } from '../src/timeline/service.js';
import { BitcoinRpc } from '../src/rpc.js';
import { B, FX, fakeFetch } from './timeline-mocks.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'btctrust-tl-'));
const MS = 'mempool.space', BS = 'blockstream.info', EMZY = 'mempool.emzy.de';

describe('FRED CSV parser', () => {
  it('parses observation_date CSV and skips "." missing values', () => {
    const pts = parseFredCsv('observation_date,UNRATE\r\n2008-09-01,6.1\r\n2008-10-01,.\r\n2008-11-01,6.8\r\n', 'UNRATE');
    expect(pts).toEqual([{ date: '2008-09-01', value: 6.1 }, { date: '2008-11-01', value: 6.8 }]);
  });
  it('accepts the legacy DATE header and a BOM', () => {
    expect(parseFredCsv('\uFEFFDATE,GDP\n2009-01-01,14430.902\n')).toEqual([{ date: '2009-01-01', value: 14430.902 }]);
  });
  it('rejects wrong series, bad headers, bad dates and non-numeric values', () => {
    expect(() => parseFredCsv('observation_date,M2SL\n2008-01-01,1\n', 'CPIAUCSL')).toThrow(/expected CPIAUCSL/);
    expect(() => parseFredCsv('<html>error</html>')).toThrow(/header/);
    expect(() => parseFredCsv('observation_date,X\n01/02/2008,1\n')).toThrow(/date/);
    expect(() => parseFredCsv('observation_date,X\n2008-01-01,abc\n')).toThrow(/value/);
    expect(() => parseFredCsv('')).toThrow(/Empty/);
  });
  it('caches the raw CSV with fetch date and source URL; serves stale cache if refresh fails', async () => {
    const calls: string[] = [];
    const dir = tmp();
    const c = new FredCache(dir, fakeFetch({}, calls), 0);
    const s = await c.get('FEDFUNDS');
    expect(s.points).toEqual([{ date: '2008-10-01', value: 1.5 }, { date: '2008-12-01', value: 2.5 }]);
    expect(s.csvUrl).toBe('https://fred.stlouisfed.org/graph/fredgraph.csv?id=FEDFUNDS');
    expect(s.sourceUrl).toBe('https://fred.stlouisfed.org/series/FEDFUNDS');
    expect(Date.parse(s.fetchedAt)).toBeGreaterThan(Date.now() - 60_000);
    expect(readFileSync(join(dir, 'FEDFUNDS.csv'), 'utf8')).toContain('observation_date,FEDFUNDS');
    const fresh = new FredCache(dir, fakeFetch({}, calls), 3600_000);
    await fresh.get('FEDFUNDS');
    expect(calls).toHaveLength(1); // served from cache
    const offline = new FredCache(dir, async () => { throw new Error('offline'); }, 0, 1);
    const stale = await offline.get('FEDFUNDS');
    expect(stale.stale).toBe(true);
    expect(stale.points).toHaveLength(2);
  });
});

describe('Bitcoin chain data', () => {
  it('parses the real genesis header: hash, time, difficulty 1, proof of work', () => {
    const h = parseHeader(FX.genesis.headerHex);
    expect(h.hash).toBe(GENESIS_HASH);
    expect(h.time).toBe(1231006505);
    expect(new Date(h.time * 1000).toISOString()).toBe('2009-01-03T18:15:05.000Z');
    expect(h.difficulty).toBe(1);
    expect(h.powValid).toBe(true);
    expect(h.prevHash).toBe('0'.repeat(64));
  });
  it('detects a tampered header (fails proof of work) and wrong length', () => {
    const bad = FX.genesis.headerHex.slice(0, 152) + '00000000';
    expect(parseHeader(bad).powValid).toBe(false);
    expect(() => parseHeader('00')).toThrow(/80 bytes/);
  });
  it('decodes The Times headline from the genesis coinbase and ties it to the header merkle root', () => {
    const g = verifyGenesis(FX.genesis.headerHex, FX.genesis.coinbaseHex);
    expect(g.headline).toBe('The Times 03/Jan/2009 Chancellor on brink of second bailout for banks');
    expect(g.checks).toEqual({ hashIsGenesis: true, proofOfWork: true, merkleRootIsCoinbase: true, coinbaseTxid: true });
    expect(g.verified).toBe(true);
    const tampered = FX.genesis.coinbaseHex.replace('54686520', '54686521'); // "The " → "Thf!"... altered byte
    expect(verifyGenesis(FX.genesis.headerHex, tampered).verified).toBe(false);
    expect(() => parseCoinbase(FX.genesis.headerHex)).toThrow();
  });
  it('real halving headers hash correctly and carry mainnet difficulty', () => {
    const diffs = [210000, 420000, 630000, 840000].map((h) => {
      const p = parseHeader(B(h).headerHex);
      expect(p.hash).toBe(B(h).hash);
      expect(p.powValid).toBe(true);
      return p.difficulty;
    });
    expect(diffs[0]).toBeCloseTo(3438908.96, 1); // difficulty at the first halving (Nov 2012)
    expect(diffs[3]).toBeGreaterThan(8.6e13);
    expect([...diffs].sort((a, b) => a - b)).toEqual(diffs);
    expect(new Date(B(840000).time * 1000).toISOString()).toBe('2024-04-20T00:09:27.000Z');
  });
  it('estimates the next halving from observed block intervals', () => {
    const e = estimateHeightDate(1_050_000, { height: 840_000, time: 1_000_000 }, { height: 840_100, time: 1_060_000 });
    expect(e.avgBlockSeconds).toBe(600);
    expect(e.remaining).toBe(209_900);
    expect(e.estimatedTime).toBe(1_060_000 + 209_900 * 600);
    expect(daysBetween('2008-10-31', '2008-11-30')).toBe(30);
  });
});

describe('white paper', () => {
  it('bundled bitcoin.pdf matches the published SHA-256', () => {
    const v = verifyWhitepaper();
    expect(existsSync(WHITEPAPER_FILE)).toBe(true);
    expect(v).toMatchObject({ bundled: true, matches: true, bytes: 184292, sha256: WHITEPAPER.sha256 });
    expect(WHITEPAPER.sha256).toBe('b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553');
  });
  it('flags a modified copy', () => {
    const f = join(tmp(), 'bitcoin.pdf');
    const buf = readFileSync(WHITEPAPER_FILE);
    buf[100] ^= 1;
    writeFileSync(f, buf);
    expect(verifyWhitepaper(f).matches).toBe(false);
    expect(verifyWhitepaper(join(tmp(), 'missing.pdf')).bundled).toBe(false);
  });
});

describe('curated events', () => {
  it('every U.S. event has an ISO date and an https citation on an official/primary domain', () => {
    expect(US_EVENTS.length).toBeGreaterThanOrEqual(12);
    for (const e of US_EVENTS) {
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.citation).toMatch(/^https:\/\/(www\.federalreserve\.gov|www\.federalreservehistory\.org|www\.congress\.gov)\//);
    }
  });
});

const tip = (name: string, height: number, hash: string): SourceTip => ({ name, ok: true, height, hash, time: 1, difficulty: 1 });
describe('cross-check', () => {
  it('agree when both report the same tip', () => {
    expect(crossCheck([tip(MS, 5, 'aa'), tip(BS, 5, 'aa')]).status).toBe('agree');
  });
  it('flags disagreement on different hashes at the same height', () => {
    const c = crossCheck([tip(MS, 5, 'aa'), tip(BS, 5, 'bb')]);
    expect(c.status).toBe('disagree');
    expect(c.notes[0]).toMatch(/different hashes/);
  });
  it('accepts a lagging source only if it is on the leader’s chain', () => {
    expect(crossCheck([tip(MS, 6, 'cc'), tip(BS, 5, 'aa')], { 5: 'aa' })).toMatchObject({ status: 'agree', lagBlocks: 1 });
    expect(crossCheck([tip(MS, 6, 'cc'), tip(BS, 5, 'aa')], { 5: 'zz' }).status).toBe('disagree');
    expect(crossCheck([tip(MS, 6, 'cc'), tip(BS, 5, 'aa')]).status).toBe('disagree');
  });
  it('single-source and unavailable', () => {
    expect(crossCheck([tip(MS, 5, 'aa'), { name: BS, ok: false, error: 'HTTP 429' }])).toMatchObject({ status: 'single-source' });
    expect(crossCheck([{ name: MS, ok: false, error: 'x' }]).status).toBe('unavailable');
  });
});

describe('daily snapshot (mocked public APIs)', () => {
  const T420 = { hash: B(420000).hash, height: 420000 };
  it('appends once per local date (idempotent) and appends again the next day', async () => {
    const calls: string[] = [];
    const dir = tmp();
    const svc = new MainnetService({ dataDir: dir, fetch: fakeFetch({ [MS]: { tip: T420 }, [BS]: { tip: T420 } }, calls), attempts: 1 });
    const day1 = new Date('2026-10-02T19:00:00Z');
    const a = await svc.snapshot(day1);
    expect(a.created).toBe(true);
    expect(a.snapshot).toMatchObject({ height: 420000, hash: B(420000).hash, time: B(420000).time, primary: MS, check: { status: 'agree' } });
    const n = calls.length;
    const b = await svc.snapshot(new Date('2026-10-02T23:59:00Z'));
    expect(b.created).toBe(false);
    expect(b.snapshot.takenAt).toBe(a.snapshot.takenAt);
    expect(calls.length).toBe(n); // no network on a repeat
    expect(svc.log()).toHaveLength(1);
    await svc.snapshot(new Date('2026-10-03T19:00:00Z'));
    expect(svc.log().map((s) => s.date)).toEqual([localDate(day1), localDate(new Date('2026-10-03T19:00:00Z'))]);
    expect(JSON.parse(readFileSync(join(dir, 'daily-blocks.json'), 'utf8')).snapshots).toHaveLength(2);
  });
  it('records disagreement when sources report different blocks at the same height', async () => {
    const svc = new MainnetService({ dataDir: tmp(), fetch: fakeFetch({ [MS]: { tip: T420 }, [BS]: { tip: { hash: B(630000).hash, height: 420000 } } }), attempts: 1 });
    const { snapshot } = await svc.snapshot();
    expect(snapshot.check.status).toBe('disagree');
    expect(snapshot.sources.filter((s) => s.ok)).toHaveLength(2);
  });
  it('rejects a source whose header does not hash to its claimed tip', async () => {
    const fetch = fakeFetch({ [MS]: { tip: T420 }, [BS]: { tip: T420 } });
    const lying: typeof fetch = async (url, init) => (url.includes('blockstream') && url.endsWith('/header') ? new Response(B(210000).headerHex) : fetch(url, init));
    const svc = new MainnetService({ dataDir: tmp(), fetch: lying, attempts: 1, fallbacks: [] });
    const { snapshot } = await svc.snapshot();
    expect(snapshot.sources.find((s) => s.name === BS)?.error).toMatch(/does not hash/);
    expect(snapshot.check.status).toBe('single-source');
  });
  it('on HTTP 429 uses the fallback mirror to still cross-check', async () => {
    const svc = new MainnetService({ dataDir: tmp(), fetch: fakeFetch({ [MS]: { tip: T420 }, [BS]: { fail: 429 }, [EMZY]: { tip: T420 } }), attempts: 1 });
    const { snapshot } = await svc.snapshot();
    expect(snapshot.check.status).toBe('agree');
    expect(snapshot.sources.map((s) => [s.name, s.ok])).toEqual([[MS, true], [BS, false], [EMZY, true]]);
    expect(snapshot.sources[1].error).toMatch(/429/);
  });
  it('a lagging source on the same chain still agrees', async () => {
    const svc = new MainnetService({ dataDir: tmp(), fetch: fakeFetch({ [MS]: { tip: { hash: B(630000).hash, height: 420001 }, hashAt: { 420000: B(420000).hash } }, [BS]: { tip: T420 } }), attempts: 1 });
    const { snapshot } = await svc.snapshot();
    expect(snapshot.check).toMatchObject({ status: 'agree', lagBlocks: 1 });
    expect(snapshot.height).toBe(420001);
  });
  it('writes nothing when every source fails', async () => {
    const dir = tmp();
    const svc = new MainnetService({ dataDir: dir, fetch: fakeFetch({ [MS]: { fail: 'reset' }, [BS]: { fail: 429 }, [EMZY]: { fail: 'reset' } }), attempts: 1 });
    await expect(svc.snapshot()).rejects.toThrow(/No mainnet source/);
    expect(existsSync(join(dir, 'daily-blocks.json'))).toBe(false);
  });
  it('prefers a configured mainnet node (getblockchaininfo) and still cross-checks it', async () => {
    const node = { call: async (m: string) => (m === 'getblockchaininfo' ? { chain: 'main', blocks: 420000, bestblockhash: B(420000).hash, difficulty: 194254820283.444 } : B(420000).headerHex) } as unknown as BitcoinRpc;
    const svc = new MainnetService({ dataDir: tmp(), node, fetch: fakeFetch({ [MS]: { tip: T420 }, [BS]: { tip: T420 } }), attempts: 1 });
    const { snapshot } = await svc.snapshot();
    expect(snapshot.primary).toBe('node');
    expect(snapshot.difficulty).toBe(194254820283.444);
    expect(snapshot.check.notes[0]).toMatch(/Node tip matches/);
    const regtestNode = { call: async () => ({ chain: 'regtest', blocks: 1, bestblockhash: 'x', difficulty: 0 }) } as unknown as BitcoinRpc;
    const s2 = await new MainnetService({ dataDir: tmp(), node: regtestNode, fetch: fakeFetch({ [MS]: { tip: T420 }, [BS]: { tip: T420 } }), attempts: 1 }).snapshot();
    expect(s2.snapshot.primary).toBe(MS);
    expect(s2.snapshot.sources[0].error).toMatch(/not mainnet/);
  });
  it('fetches and verifies genesis + halving reference data', async () => {
    const svc = new MainnetService({ dataDir: tmp(), fetch: fakeFetch({ [MS]: { tip: T420 } }), attempts: 1 });
    const ref = await svc.fetchReference();
    expect(ref.genesis.verified).toBe(true);
    expect(ref.genesis.headline).toMatch(/^The Times 03\/Jan\/2009/);
    expect(ref.halvings.map((h) => [h.height, h.timeISO.slice(0, 10), h.verified])).toEqual([
      [210000, '2012-11-28', true], [420000, '2016-07-09', true], [630000, '2020-05-11', true], [840000, '2024-04-20', true],
    ]);
  });
  it('streak counts consecutive days ending at the latest snapshot', () => {
    const s = (date: string) => ({ date }) as Snapshot;
    expect(streak([])).toBe(0);
    expect(streak([s('2026-09-28'), s('2026-09-30'), s('2026-10-01'), s('2026-10-02')])).toBe(3);
  });
});
