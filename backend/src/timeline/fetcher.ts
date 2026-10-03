/** Small HTTP helper for public, read-only data sources: timeout, retries with backoff, honest user agent. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export const USER_AGENT = 'Mozilla/5.0 (compatible; btc-trust/1.0; read-only regtest dashboard)';

export async function fetchText(url: string, opts: { fetch?: FetchLike; attempts?: number; timeoutMs?: number; backoffMs?: number } = {}): Promise<string> {
  const f = opts.fetch ?? fetch;
  const attempts = opts.attempts ?? 6;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await f(url, { headers: { 'user-agent': USER_AGENT, accept: '*/*' }, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
      if (r.ok) return await r.text();
      last = new Error(`HTTP ${r.status} from ${new URL(url).host}${r.status === 429 ? ' (rate limited)' : ''}`);
      if (r.status === 404 || (r.status >= 400 && r.status < 429)) break;
    } catch (e) {
      last = new Error(`${new URL(url).host}: ${(e as Error & { cause?: { code?: string } }).cause?.code ?? (e as Error).message}`);
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, (opts.backoffMs ?? 600) * 2 ** i * (0.75 + Math.random() / 2)));
  }
  throw last;
}
