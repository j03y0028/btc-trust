/**
 * BTC → fiat prices for display only, fetched by the backend so the browser never talks to a third party
 * (CSP connect-src stays 'self'). Public APIs, no keys, no wallet data sent: each request asks only for "the BTC price".
 *
 * - sources are tried in order; one that fails is skipped for `failBackoffMs`
 * - each source's whole table is cached for `ttlMs` (default 60 s): at most one request per source per minute,
 *   however many browsers ask
 * - when every source fails, the last good price is served (marked stale) for up to `staleMaxMs`, then "unavailable"
 * - prices are kept as exact decimal strings and as integer "price × 10^8" (priceE8), so clients can convert
 *   integer sats without floating-point drift
 */
import { USER_AGENT, type FetchLike } from './timeline/fetcher.js';
import { CURRENCIES, type CurrencyCode } from '../../shared/currencies.js';

export { CURRENCIES };
export type Currency = CurrencyCode;
const CODES = new Set<string>(CURRENCIES.map(([c]) => c));
export const isCurrency = (c: unknown): c is Currency => typeof c === 'string' && CODES.has(c);

export type PriceTable = Partial<Record<Currency, string>>; // decimal strings, BTC price in that currency
export interface PriceSource {
  id: string; name: string; url: string;
  /** null = every currency in CURRENCIES */
  currencies: readonly Currency[] | null;
  parse: (body: unknown) => { table: PriceTable; time?: number };
}

const MEMPOOL_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'CHF', 'AUD', 'JPY'] as const;
const mempoolParse = (b: unknown) => {
  const o = b as Record<string, unknown>;
  const table: PriceTable = {};
  for (const c of MEMPOOL_CURRENCIES) if (o?.[c] !== undefined) table[c] = num(o[c]);
  return { table, time: typeof o?.time === 'number' ? o.time * 1000 : undefined };
};
const KRAKEN = ['USD', 'EUR', 'GBP', 'CAD', 'JPY', 'CHF', 'AUD'] as const;

export const SOURCES: Record<string, PriceSource> = {
  mempool: { id: 'mempool', name: 'mempool.space', url: 'https://mempool.space/api/v1/prices', currencies: MEMPOOL_CURRENCIES, parse: mempoolParse },
  coinbase: {
    id: 'coinbase', name: 'Coinbase', url: 'https://api.coinbase.com/v2/exchange-rates?currency=BTC', currencies: null,
    parse: (b) => {
      const d = (b as { data?: { currency?: string; rates?: Record<string, unknown> } })?.data;
      if (d?.currency !== 'BTC' || !d.rates) throw new Error('unexpected response');
      const table: PriceTable = {};
      for (const [c] of CURRENCIES) if (d.rates[c] !== undefined) table[c] = num(d.rates[c]);
      return { table };
    },
  },
  kraken: {
    id: 'kraken', name: 'Kraken', url: `https://api.kraken.com/0/public/Ticker?pair=${KRAKEN.map((c) => `XBT${c}`).join(',')}`, currencies: KRAKEN,
    parse: (b) => {
      const o = b as { error?: unknown[]; result?: Record<string, { c?: unknown[] }> };
      if (!o?.result || (o.error?.length ?? 0) > 0) throw new Error(`Kraken error ${JSON.stringify(o?.error ?? '')}`);
      const table: PriceTable = {};
      // keys look like XXBTZUSD or XBTCHF: the quote currency is the last three letters
      for (const [k, v] of Object.entries(o.result)) {
        const c = k.slice(-3);
        if ((KRAKEN as readonly string[]).includes(c) && /XBT/.test(k) && v?.c?.[0] !== undefined) table[c as Currency] = num(v.c[0]);
      }
      return { table };
    },
  },
  emzy: { id: 'emzy', name: 'mempool.emzy.de', url: 'https://mempool.emzy.de/api/v1/prices', currencies: MEMPOOL_CURRENCIES, parse: mempoolParse },
  coingecko: {
    id: 'coingecko', name: 'CoinGecko', currencies: null,
    url: `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=${CURRENCIES.map(([c]) => c.toLowerCase()).join(',')}&include_last_updated_at=true`,
    parse: (b) => {
      const o = (b as { bitcoin?: Record<string, unknown> })?.bitcoin;
      if (!o) throw new Error('unexpected response');
      const table: PriceTable = {};
      for (const [c] of CURRENCIES) if (o[c.toLowerCase()] !== undefined) table[c] = num(o[c.toLowerCase()]);
      return { table, time: typeof o.last_updated_at === 'number' ? o.last_updated_at * 1000 : undefined };
    },
  },
};
export const DEFAULT_ORDER = ['mempool', 'coinbase', 'kraken', 'emzy', 'coingecko'];

/** Plain decimal string (no exponent), > 0 and below an absurd ceiling. */
function num(v: unknown): string {
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : typeof v === 'string' ? v.trim() : '';
  if (!/^\d{1,15}(\.\d+)?$/.test(s) || /^0+(\.0*)?$/.test(s)) throw new Error(`bad price value ${JSON.stringify(v)}`);
  return s;
}

/** "84822.123456789" → 8482212345678n (price × 10^8, truncated past 8 decimals). */
export function toE8(price: string): bigint {
  const [w, f = ''] = price.split('.');
  return BigInt(w) * 100_000_000n + BigInt((f + '00000000').slice(0, 8));
}

export interface PriceOk {
  available: true; currency: Currency; price: string; priceE8: string;
  source: string; sourceId: string; fetchedAt: number; sourceTime?: number; stale: boolean; ageMs: number;
}
export interface PriceUnavailable { available: false; currency: Currency; disabled?: boolean; error: string }
export type PriceResult = PriceOk | PriceUnavailable;

export interface PriceOptions {
  enabled?: boolean; ttlMs?: number; timeoutMs?: number; failBackoffMs?: number; staleMaxMs?: number;
  order?: string[]; fetch?: FetchLike; now?: () => number; sources?: Record<string, PriceSource>;
}

interface Entry { at: number; table: PriceTable; time?: number }

export class PriceService {
  readonly enabled: boolean;
  private ttl: number; private timeout: number; private backoff: number; private staleMax: number;
  private order: PriceSource[];
  private f: FetchLike; private now: () => number;
  private cache = new Map<string, Entry>();
  private failedAt = new Map<string, { at: number; error: string }>();
  private inflight = new Map<string, Promise<Entry>>();
  /** outbound HTTP requests made (tests, /api/prices status) */
  requests = 0;

  constructor(o: PriceOptions = {}) {
    this.enabled = o.enabled ?? true;
    this.ttl = o.ttlMs ?? 60_000;
    this.timeout = o.timeoutMs ?? 5_000;
    this.backoff = o.failBackoffMs ?? 5 * 60_000;
    this.staleMax = o.staleMaxMs ?? 30 * 60_000;
    const all = o.sources ?? SOURCES;
    this.order = (o.order ?? DEFAULT_ORDER).map((id) => all[id]).filter(Boolean);
    if (this.order.length === 0) throw new Error('PRICE_SOURCES: no known price source');
    this.f = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
  }

  get sources() { return this.order.map((s) => ({ id: s.id, name: s.name, currencies: s.currencies ?? CURRENCIES.map(([c]) => c) })); }

  private async load(s: PriceSource): Promise<Entry> {
    const running = this.inflight.get(s.id);
    if (running) return running;
    const p = (async () => {
      this.requests++;
      const r = await this.f(s.url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(this.timeout) });
      if (!r.ok) throw new Error(`HTTP ${r.status}${r.status === 429 ? ' (rate limited)' : ''}`);
      const { table, time } = s.parse(JSON.parse(await r.text()));
      if (Object.keys(table).length === 0) throw new Error('no prices in response');
      const e: Entry = { at: this.now(), table, ...(time ? { time } : {}) };
      this.cache.set(s.id, e);
      this.failedAt.delete(s.id);
      return e;
    })().catch((err: Error & { cause?: { code?: string } }) => {
      const msg = err.name === 'TimeoutError' ? `timed out after ${this.timeout} ms` : err.cause?.code ?? err.message;
      this.failedAt.set(s.id, { at: this.now(), error: msg });
      throw new Error(msg);
    }).finally(() => this.inflight.delete(s.id));
    this.inflight.set(s.id, p);
    return p;
  }

  private ok(s: PriceSource, e: Entry, currency: Currency, stale: boolean): PriceOk {
    const price = e.table[currency]!;
    return { available: true, currency, price, priceE8: toE8(price).toString(), source: s.name, sourceId: s.id, fetchedAt: e.at, ...(e.time ? { sourceTime: e.time } : {}), stale, ageMs: this.now() - e.at };
  }

  async price(currency: Currency): Promise<PriceResult> {
    if (!this.enabled) return { available: false, currency, disabled: true, error: 'The price feed is switched off on this node (PRICE_FEED=off).' };
    const now = this.now();
    const candidates = this.order.filter((s) => !s.currencies || s.currencies.includes(currency));
    // 1. a fresh cached table that has this currency
    for (const s of candidates) {
      const e = this.cache.get(s.id);
      if (e && now - e.at < this.ttl && e.table[currency]) return this.ok(s, e, currency, false);
    }
    // 2. ask the sources in order (skipping ones that failed recently)
    const errors: string[] = [];
    for (const s of candidates) {
      const failed = this.failedAt.get(s.id);
      if (failed && now - failed.at < this.backoff) { errors.push(`${s.name}: ${failed.error} (retry later)`); continue; }
      try {
        const e = await this.load(s);
        if (e.table[currency]) return this.ok(s, e, currency, false);
        errors.push(`${s.name}: no ${currency} price`);
      } catch (err) { errors.push(`${s.name}: ${(err as Error).message}`); }
    }
    // 3. the newest older value, if not too old
    let best: { s: PriceSource; e: Entry } | null = null;
    for (const s of candidates) {
      const e = this.cache.get(s.id);
      if (e?.table[currency] && now - e.at < this.staleMax && (!best || e.at > best.e.at)) best = { s, e };
    }
    if (best) return this.ok(best.s, best.e, currency, true);
    return { available: false, currency, error: `Price unavailable: ${errors.join('; ') || 'no source for this currency'}` };
  }
}
