import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchText, type FetchLike } from './fetcher.js';

export interface FredPoint { date: string; value: number }
export interface FredSeriesMeta { id: string; title: string; units: string; frequency: string; seasonal: string; kind: 'rate' | 'level' }

/** Series shown on the timeline. Metadata from each series page at fred.stlouisfed.org/series/<ID>. */
export const FRED_SERIES: FredSeriesMeta[] = [
  { id: 'CPIAUCSL', title: 'Consumer Price Index for All Urban Consumers: All Items in U.S. City Average', units: 'Index 1982-1984=100', frequency: 'Monthly', seasonal: 'Seasonally Adjusted', kind: 'level' },
  { id: 'M2SL', title: 'M2 Money Stock', units: 'Billions of Dollars', frequency: 'Monthly', seasonal: 'Seasonally Adjusted', kind: 'level' },
  { id: 'FEDFUNDS', title: 'Federal Funds Effective Rate', units: 'Percent', frequency: 'Monthly', seasonal: 'Not Seasonally Adjusted', kind: 'rate' },
  { id: 'GDP', title: 'Gross Domestic Product', units: 'Billions of Dollars', frequency: 'Quarterly', seasonal: 'Seasonally Adjusted Annual Rate', kind: 'level' },
  { id: 'UNRATE', title: 'Unemployment Rate', units: 'Percent', frequency: 'Monthly', seasonal: 'Seasonally Adjusted', kind: 'rate' },
];
export const fredCsvUrl = (id: string) => `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}`;
export const fredPageUrl = (id: string) => `https://fred.stlouisfed.org/series/${encodeURIComponent(id)}`;

/** Parse a FRED graph CSV (`observation_date,<ID>` or legacy `DATE,<ID>`); "." marks a missing value. */
export function parseFredCsv(text: string, id?: string): FredPoint[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) throw new Error('Empty FRED CSV');
  const header = lines[0].split(',').map((s) => s.trim());
  if (!/^(observation_date|DATE)$/i.test(header[0]) || header.length < 2) throw new Error(`Unexpected FRED CSV header: ${lines[0].slice(0, 80)}`);
  if (id && header[1] !== id) throw new Error(`FRED CSV is for ${header[1]}, expected ${id}`);
  const out: FredPoint[] = [];
  for (const line of lines.slice(1)) {
    const [date, raw] = line.split(',').map((s) => s.trim());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Bad FRED date: ${date}`);
    if (raw === '.' || raw === '' || raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`Bad FRED value for ${date}: ${raw}`);
    out.push({ date, value });
  }
  return out;
}

export interface CachedSeries extends FredSeriesMeta { fetchedAt: string; csvUrl: string; sourceUrl: string; points: FredPoint[]; stale?: boolean; error?: string }

/** Local cache under data/fred: raw CSV as downloaded + fetch metadata. Refreshed when older than maxAgeMs. */
export class FredCache {
  constructor(private dir: string, private fetchImpl?: FetchLike, private maxAgeMs = 24 * 3600_000, private attempts = 4) {}
  private metaFile = () => join(this.dir, 'meta.json');
  private meta(): Record<string, { fetchedAt: string; csvUrl: string; rows: number }> {
    return existsSync(this.metaFile()) ? JSON.parse(readFileSync(this.metaFile(), 'utf8')) : {};
  }
  cached(id: string): CachedSeries | null {
    const m = this.meta()[id];
    const f = join(this.dir, `${id}.csv`);
    const def = FRED_SERIES.find((s) => s.id === id);
    if (!m || !def || !existsSync(f)) return null;
    return { ...def, fetchedAt: m.fetchedAt, csvUrl: m.csvUrl, sourceUrl: fredPageUrl(id), points: parseFredCsv(readFileSync(f, 'utf8'), id) };
  }
  async refresh(id: string): Promise<CachedSeries> {
    const csvUrl = fredCsvUrl(id);
    const text = await fetchText(csvUrl, { fetch: this.fetchImpl, attempts: this.attempts, timeoutMs: 30_000 });
    const points = parseFredCsv(text, id); // validate before caching
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${id}.csv`), text);
    const meta = this.meta();
    meta[id] = { fetchedAt: new Date().toISOString(), csvUrl, rows: points.length };
    writeFileSync(this.metaFile(), JSON.stringify(meta, null, 2));
    return this.cached(id)!;
  }
  /** Cached copy if fresh; otherwise refetch, falling back to the stale cache on network failure. */
  async get(id: string, force = false): Promise<CachedSeries> {
    const c = this.cached(id);
    if (c && !force && Date.now() - Date.parse(c.fetchedAt) < this.maxAgeMs) return c;
    try { return await this.refresh(id); } catch (e) {
      if (c) return { ...c, stale: true, error: (e as Error).message };
      throw e;
    }
  }
}
