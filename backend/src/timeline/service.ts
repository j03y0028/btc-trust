import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AppConfig } from '../config.js';
import { BitcoinRpc } from '../rpc.js';
import { STAGES } from '../stages.js';
import { NEXT_HALVING, WHITEPAPER, daysBetween, estimateHeightDate, sha256Hex } from './chain.js';
import { BITCOIN_WHITEPAPER_EVENT, US_EVENTS, type TimelineEvent } from './events.js';
import type { FetchLike } from './fetcher.js';
import { FRED_SERIES, FredCache, type CachedSeries } from './fred.js';
import { MainnetService, localDate, streak } from './mainnet.js';
import { BACKLOG, stageProgress } from './progress.js';

export const REPO_ROOT = resolve(import.meta.dirname, '../../..');
export const WHITEPAPER_FILE = join(REPO_ROOT, 'frontend/public/bitcoin.pdf');

export function verifyWhitepaper(file = WHITEPAPER_FILE) {
  if (!existsSync(file)) return { bundled: false, matches: false, bytes: 0, sha256: null as string | null };
  const buf = readFileSync(file);
  const sha256 = sha256Hex(buf);
  return { bundled: true, matches: sha256 === WHITEPAPER.sha256, bytes: buf.length, sha256 };
}

export class TimelineService {
  readonly fred: FredCache;
  readonly mainnet: MainnetService;
  constructor(private cfg: AppConfig, opts: { fetch?: FetchLike; attempts?: number; repoRoot?: string; whitepaperFile?: string } = {}) {
    this.fred = new FredCache(join(cfg.dataDir, 'fred'), opts.fetch, undefined, opts.attempts);
    const n = cfg.mainnet.node;
    const node = n ? new BitcoinRpc({ rpcHost: n.host, rpcPort: n.port, rpcUser: n.user, rpcPassword: n.password, rpcTimeoutMs: cfg.rpcTimeoutMs }) : null;
    this.mainnet = new MainnetService({ dataDir: cfg.dataDir, node, fetch: opts.fetch, attempts: opts.attempts });
    this.repoRoot = opts.repoRoot ?? REPO_ROOT;
    this.whitepaperFile = opts.whitepaperFile ?? WHITEPAPER_FILE;
  }
  private repoRoot: string;
  private whitepaperFile: string;

  async timeline(opts: { force?: boolean; since?: string } = {}) {
    const since = opts.since ?? '2000-01-01';
    const errors: string[] = [];
    const series: CachedSeries[] = [];
    for (const s of FRED_SERIES) {
      try {
        const c = await this.fred.get(s.id, opts.force);
        if (c.error) errors.push(`${s.id}: refresh failed, showing cache from ${c.fetchedAt} (${c.error})`);
        series.push({ ...c, points: c.points.filter((p) => p.date >= since) });
      } catch (e) { errors.push(`${s.id}: ${(e as Error).message}`); }
    }
    let ref = this.mainnet.reference();
    if (!ref?.genesis?.verified || opts.force) ref = await this.mainnet.fetchReference().catch((e) => { errors.push(`mainnet reference: ${(e as Error).message}`); return ref; });
    const btc: TimelineEvent[] = [BITCOIN_WHITEPAPER_EVENT];
    if (ref) {
      btc.push({ date: ref.genesis.timeISO.slice(0, 10), kind: 'bitcoin', title: 'Genesis block mined', detail: ref.genesis.headline ? `Coinbase message: “${ref.genesis.headline}”` : 'Block 0', citation: `https://mempool.space/block/${ref.genesis.hash}`, source: `${ref.source} (verified locally)` });
      for (const h of ref.halvings) btc.push({ date: h.timeISO.slice(0, 10), kind: 'bitcoin', title: `Halving #${h.height / 210_000} (block ${h.height.toLocaleString('en-US')})`, detail: `Subsidy ${50 / 2 ** (h.height / 210_000 - 1)} → ${50 / 2 ** (h.height / 210_000)} BTC`, citation: `https://mempool.space/block/${h.hash}`, source: `${ref.source} (header verified)` });
    }
    return {
      series, events: [...US_EVENTS, ...btc].sort((a, b) => a.date.localeCompare(b.date)), reference: ref,
      whitepaper: { ...WHITEPAPER, ...verifyWhitepaper(this.whitepaperFile) }, errors,
    };
  }

  daily() {
    const snapshots = this.mainnet.log();
    const latest = snapshots.at(-1) ?? null;
    const ref = this.mainnet.reference();
    const today = localDate();
    const last840 = ref?.halvings.find((h) => h.height === 840_000);
    let growing = true;
    for (let i = 1; i < snapshots.length; i++) if (snapshots[i].height <= snapshots[i - 1].height) growing = false;
    return {
      snapshots, latest, today, hasToday: latest?.date === today,
      streakDays: streak(snapshots), growing,
      blocksSinceGenesis: latest?.height ?? null,
      daysSinceWhitepaper: daysBetween(WHITEPAPER.date, today),
      daysSinceGenesis: ref ? daysBetween(ref.genesis.timeISO.slice(0, 10), today) : null,
      nextHalving: latest && last840 ? estimateHeightDate(NEXT_HALVING, { height: last840.height, time: last840.time }, { height: latest.height, time: latest.time }) : null,
      halvings: ref?.halvings ?? [], genesis: ref ? { hash: ref.genesis.hash, time: ref.genesis.time } : null,
      nodeConfigured: !!this.cfg.mainnet.node, sources: this.mainnet.sources.map((s) => s.name), fallbacks: this.mainnet.fallbacks.map((s) => s.name),
    };
  }

  async progress() {
    const statuses = Object.fromEntries(STAGES.map((s) => [s.id, s.status]));
    return { ...(await stageProgress(this.repoRoot, statuses)), backlog: BACKLOG };
  }

  /** Background job: today's snapshot (once per local date), reference data and FRED cache. */
  startDailyJob(log = console) {
    const tick = async () => {
      try {
        if (!this.daily().hasToday) {
          const r = await this.mainnet.snapshot();
          log.log(`[daily] mainnet snapshot ${r.snapshot.date}: height ${r.snapshot.height} (${r.snapshot.check.status})`);
        }
        if (!this.mainnet.reference()?.genesis?.verified) await this.mainnet.fetchReference();
      } catch (e) { log.warn(`[daily] snapshot failed, will retry: ${(e as Error).message}`); }
    };
    const t0 = setTimeout(tick, 15_000);
    const t = setInterval(tick, 3600_000);
    t0.unref(); t.unref();
    return () => { clearTimeout(t0); clearInterval(t); };
  }
}
