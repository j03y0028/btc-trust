import fx from './fixtures/mainnet-blocks.json' with { type: 'json' };
import type { FetchLike } from '../src/timeline/fetcher.js';

export const FX = fx as { genesis: { hash: string; headerHex: string; coinbaseHex: string }; blocks: Record<string, { hash: string; headerHex: string; time: number }> };
export const B = (h: number) => FX.blocks[String(h)];

export interface FakeChain { tip?: { hash: string; height: number }; fail?: 429 | 'reset'; hashAt?: Record<number, string> }

/** Mocked fetch that routes Esplora URLs per host to a fake chain built from real mainnet headers. */
export function fakeFetch(chains: Record<string, FakeChain>, calls: string[] = []): FetchLike {
  const headers: Record<string, string> = { [FX.genesis.hash]: FX.genesis.headerHex };
  for (const b of Object.values(FX.blocks)) headers[b.hash] = b.headerHex;
  return async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    const host = u.host;
    if (host === 'fred.stlouisfed.org') return new Response(`observation_date,${u.searchParams.get('id')}\n2008-10-01,1.5\n2008-11-01,.\n2008-12-01,2.5\n`);
    const c = chains[host];
    if (!c || c.fail === 'reset') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    if (c.fail === 429) return new Response('Too Many Requests', { status: 429 });
    const p = u.pathname.replace(/^\/api/, '');
    let m: RegExpExecArray | null;
    if (p === '/blocks/tip/hash' && c.tip) return new Response(c.tip.hash);
    if ((m = /^\/block\/([0-9a-f]{64})\/status$/.exec(p)) && c.tip && m[1] === c.tip.hash) return Response.json({ in_best_chain: true, height: c.tip.height });
    if ((m = /^\/block\/([0-9a-f]{64})\/header$/.exec(p)) && headers[m[1]]) return new Response(headers[m[1]]);
    if ((m = /^\/block-height\/(\d+)$/.exec(p))) {
      const h = c.hashAt?.[Number(m[1])] ?? FX.blocks[m[1]]?.hash ?? (m[1] === '0' ? FX.genesis.hash : undefined);
      if (h) return new Response(h);
    }
    if (p === `/tx/4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b/hex`) return new Response(FX.genesis.coinbaseHex);
    return new Response('not found', { status: 404 });
  };
}
