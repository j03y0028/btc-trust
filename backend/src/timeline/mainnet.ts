import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BitcoinRpc } from '../rpc.js';
import { GENESIS_HASH, HALVING_HEIGHTS, parseHeader, verifyGenesis } from './chain.js';
import { fetchText, type FetchLike } from './fetcher.js';

/** Read-only mainnet tip from one source. Height comes from the source; hash/time/difficulty from the verified header. */
export interface SourceTip { name: string; ok: boolean; height?: number; hash?: string; time?: number; difficulty?: number; powValid?: boolean; latencyMs?: number; error?: string }
export interface CrossCheck { status: 'agree' | 'disagree' | 'single-source' | 'unavailable'; lagBlocks: number; notes: string[] }
export interface Snapshot {
  date: string; takenAt: string; height: number; hash: string; time: number; timeISO: string; difficulty: number;
  primary: string; check: CrossCheck; sources: SourceTip[];
}

export const ESPLORA_SOURCES = [
  { name: 'mempool.space', base: 'https://mempool.space/api' },
  { name: 'blockstream.info', base: 'https://blockstream.info/api' },
];
/** Independent community mempool instance, queried only when a primary source fails so a cross-check is still possible. */
export const FALLBACK_SOURCES = [{ name: 'mempool.emzy.de', base: 'https://mempool.emzy.de/api' }];

/** Esplora-compatible REST API (mempool.space and blockstream.info expose the same endpoints). */
export class Esplora {
  constructor(readonly name: string, private base: string, private fetchImpl?: FetchLike, private attempts = 6) {}
  private get = (p: string) => fetchText(`${this.base}${p}`, { fetch: this.fetchImpl, attempts: this.attempts });
  hashAt = async (height: number) => (await this.get(`/block-height/${height}`)).trim();
  header = async (hash: string) => (await this.get(`/block/${hash}/header`)).trim();
  txHex = async (txid: string) => (await this.get(`/tx/${txid}/hex`)).trim();
  async tip(): Promise<SourceTip> {
    const t0 = Date.now();
    try {
      const hash = (await this.get('/blocks/tip/hash')).trim();
      const status = JSON.parse(await this.get(`/block/${hash}/status`)) as { in_best_chain: boolean; height: number };
      const h = parseHeader(await this.header(hash));
      if (h.hash !== hash) throw new Error('header does not hash to the reported tip');
      if (!h.powValid) throw new Error('header fails proof of work');
      if (!status.in_best_chain) throw new Error('reported tip is not in the best chain');
      return { name: this.name, ok: true, height: status.height, hash, time: h.time, difficulty: h.difficulty, powValid: h.powValid, latencyMs: Date.now() - t0 };
    } catch (e) {
      return { name: this.name, ok: false, error: (e as Error).message, latencyMs: Date.now() - t0 };
    }
  }
}

/**
 * Compare independent tips. Sources at the leader's height must report the same hash; a lagging source is fine
 * if the leader's block at its height matches (`leaderHashAt[height]`).
 */
export function crossCheck(tips: SourceTip[], leaderHashAt: Record<number, string | undefined> = {}): CrossCheck {
  const ok = tips.filter((t) => t.ok);
  const failed = tips.filter((t) => !t.ok).map((t) => `${t.name}: ${t.error}`);
  if (ok.length === 0) return { status: 'unavailable', lagBlocks: 0, notes: failed };
  if (ok.length === 1) return { status: 'single-source', lagBlocks: 0, notes: [`Only ${ok[0].name} answered; not cross-checked`, ...failed] };
  const [a, ...rest] = [...ok].sort((x, y) => y.height! - x.height!);
  const notes: string[] = [];
  let status: CrossCheck['status'] = 'agree';
  let lagBlocks = 0;
  for (const b of rest) {
    const lag = a.height! - b.height!;
    lagBlocks = Math.max(lagBlocks, lag);
    if (lag === 0) {
      if (a.hash === b.hash) notes.push(`${a.name} and ${b.name} report the same tip`);
      else { status = 'disagree'; notes.push(`Same height ${a.height} but different hashes (${a.name} ${a.hash!.slice(0, 16)}… vs ${b.name} ${b.hash!.slice(0, 16)}…): possible stale block or bad data`); }
    } else if (leaderHashAt[b.height!] === undefined) {
      status = 'disagree'; notes.push(`${b.name} is ${lag} block(s) behind ${a.name} and the common block could not be compared`);
    } else if (leaderHashAt[b.height!] === b.hash) {
      notes.push(`${b.name} is ${lag} block(s) behind ${a.name}; its tip matches ${a.name}'s block ${b.height}`);
    } else {
      status = 'disagree'; notes.push(`${b.name}'s tip ${b.hash!.slice(0, 16)}… at ${b.height} is not on ${a.name}'s chain`);
    }
  }
  return { status, lagBlocks, notes: [...notes, ...failed] };
}

/** Local calendar date (YYYY-MM-DD) in the given IANA zone (default: the box timezone). */
export const localDate = (d = new Date(), timeZone = process.env.SNAPSHOT_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

export class MainnetService {
  readonly sources: Esplora[];
  readonly fallbacks: Esplora[];
  constructor(private opts: { dataDir: string; node?: BitcoinRpc | null; fetch?: FetchLike; attempts?: number; sources?: Esplora[]; fallbacks?: Esplora[] }) {
    this.sources = opts.sources ?? ESPLORA_SOURCES.map((s) => new Esplora(s.name, s.base, opts.fetch, opts.attempts));
    this.fallbacks = opts.fallbacks ?? FALLBACK_SOURCES.map((s) => new Esplora(s.name, s.base, opts.fetch, opts.attempts));
  }
  get logFile() { return join(this.opts.dataDir, 'daily-blocks.json'); }
  get refFile() { return join(this.opts.dataDir, 'mainnet-reference.json'); }

  log(): Snapshot[] {
    return existsSync(this.logFile) ? (JSON.parse(readFileSync(this.logFile, 'utf8')).snapshots as Snapshot[]) : [];
  }
  private writeJson(file: string, value: unknown) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
    renameSync(`${file}.tmp`, file);
  }

  /** Mainnet node first (myNode), when configured: read-only getblockchaininfo + getblockheader. */
  private async nodeTip(): Promise<SourceTip | null> {
    if (!this.opts.node) return null;
    const t0 = Date.now();
    try {
      const info = await this.opts.node.call<{ chain: string; blocks: number; bestblockhash: string; difficulty: number }>('getblockchaininfo');
      if (info.chain !== 'main') return { name: 'node', ok: false, error: `configured node is on ${info.chain}, not mainnet` };
      const hdr = parseHeader(await this.opts.node.call<string>('getblockheader', [info.bestblockhash, false]));
      return { name: 'node', ok: true, height: info.blocks, hash: info.bestblockhash, time: hdr.time, difficulty: info.difficulty, powValid: hdr.powValid, latencyMs: Date.now() - t0 };
    } catch (e) {
      return { name: 'node', ok: false, error: (e as Error).message };
    }
  }

  async observe(): Promise<{ tips: SourceTip[]; check: CrossCheck; best: SourceTip | null; primary: string }> {
    const node = await this.nodeTip();
    const tips = await Promise.all(this.sources.map((s) => s.tip()));
    if (tips.some((t) => !t.ok)) tips.push(...(await Promise.all(this.fallbacks.map((s) => s.tip()))));
    const publicOk = tips.filter((t) => t.ok).sort((a, b) => b.height! - a.height!);
    const leaderHashAt: Record<number, string | undefined> = {};
    if (publicOk.length > 1) {
      const leader = [...this.sources, ...this.fallbacks].find((s) => s.name === publicOk[0].name)!;
      for (const t of publicOk.slice(1)) if (t.height !== publicOk[0].height) leaderHashAt[t.height!] = await leader.hashAt(t.height!).catch(() => undefined);
    }
    const check = crossCheck(tips, leaderHashAt);
    if (node?.ok) {
      const ref = publicOk.find((t) => t.height === node.height);
      check.notes.unshift(ref ? (ref.hash === node.hash ? `Node tip matches ${ref.name}` : `Node tip DIFFERS from ${ref.name} at height ${node.height}`) : 'Node tip height differs from public APIs (sync lag?)');
      if (ref && ref.hash !== node.hash) check.status = 'disagree';
      return { tips: [node, ...tips], check, best: node, primary: 'node' };
    }
    const all = node ? [node, ...tips] : tips;
    return { tips: all, check, best: publicOk[0] ?? null, primary: publicOk[0]?.name ?? 'none' };
  }

  /** Append today's snapshot; returns the existing one if today's is already recorded (idempotent per date). */
  async snapshot(now = new Date()): Promise<{ created: boolean; snapshot: Snapshot }> {
    const date = localDate(now);
    const log = this.log();
    const existing = log.find((s) => s.date === date);
    if (existing) return { created: false, snapshot: existing };
    const o = await this.observe();
    if (!o.best?.ok) throw new Error(`No mainnet source available: ${o.check.notes.join('; ')}`);
    const s: Snapshot = {
      date, takenAt: now.toISOString(), height: o.best.height!, hash: o.best.hash!, time: o.best.time!, timeISO: new Date(o.best.time! * 1000).toISOString(),
      difficulty: o.best.difficulty!, primary: o.primary, check: o.check, sources: o.tips,
    };
    // re-read right before writing so concurrent runs stay idempotent
    const fresh = this.log();
    const again = fresh.find((x) => x.date === date);
    if (again) return { created: false, snapshot: again };
    this.writeJson(this.logFile, { description: 'Daily read-only mainnet tip snapshots (btc-trust)', snapshots: [...fresh, s].sort((a, b) => a.date.localeCompare(b.date)) });
    return { created: true, snapshot: s };
  }

  /** Genesis + halving blocks: fetched once from public APIs, verified locally, cached. */
  reference(): Reference | null {
    return existsSync(this.refFile) ? JSON.parse(readFileSync(this.refFile, 'utf8')) : null;
  }
  async fetchReference(): Promise<Reference> {
    const cur = this.reference();
    if (cur?.genesis?.verified && cur.halvings.length === HALVING_HEIGHTS.length) return cur;
    let lastErr: unknown;
    for (const src of [...this.sources, ...this.fallbacks]) {
      try {
        const gHeader = await src.header(GENESIS_HASH);
        const gTx = await src.txHex('4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b');
        const g = verifyGenesis(gHeader, gTx);
        const halvings = [];
        for (const height of HALVING_HEIGHTS) {
          const hash = await src.hashAt(height);
          const hdr = parseHeader(await src.header(hash));
          halvings.push({ height, hash, time: hdr.time, timeISO: new Date(hdr.time * 1000).toISOString(), verified: hdr.hash === hash && hdr.powValid });
        }
        const ref: Reference = {
          fetchedAt: new Date().toISOString(), source: src.name,
          genesis: { hash: g.hash, time: g.time, timeISO: new Date(g.time * 1000).toISOString(), headline: g.headline, headerHex: gHeader, coinbaseHex: gTx, coinbaseTxid: g.coinbaseTxid, checks: g.checks, verified: g.verified },
          halvings,
        };
        this.writeJson(this.refFile, ref);
        return ref;
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }
}

export interface Reference {
  fetchedAt: string; source: string;
  genesis: { hash: string; time: number; timeISO: string; headline: string | null; headerHex: string; coinbaseHex: string; coinbaseTxid: string; checks: Record<string, boolean>; verified: boolean };
  halvings: { height: number; hash: string; time: number; timeISO: string; verified: boolean }[];
}

/** Consecutive-day streak ending at the latest snapshot. */
export function streak(log: Snapshot[]) {
  const dates = [...new Set(log.map((s) => s.date))].sort();
  let n = 0;
  for (let i = dates.length - 1; i >= 0; i--) {
    if (i === dates.length - 1) { n = 1; continue; }
    const gap = (Date.parse(`${dates[i + 1]}T00:00:00Z`) - Date.parse(`${dates[i]}T00:00:00Z`)) / 86_400_000;
    if (gap === 1) n++; else break;
  }
  return n;
}
