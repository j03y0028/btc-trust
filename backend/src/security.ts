import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import type { AppConfig } from './config.js';

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]', '::1'];
export const isLoopback = (host: string) => LOOPBACK.includes(host) || /^127\.\d+\.\d+\.\d+$/.test(host);
const hostname = (h: string) => (h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0]).toLowerCase();

export function allowedHost(cfg: Pick<AppConfig, 'security'>, hostHeader: string | undefined) {
  if (!hostHeader) return false;
  const h = hostname(hostHeader);
  return isLoopback(h) || cfg.security.allowedHosts.includes(h);
}
export function allowedOrigin(cfg: Pick<AppConfig, 'security'>, origin: string) {
  try { const u = new URL(origin); return (u.protocol === 'http:' || u.protocol === 'https:') && allowedHost(cfg, u.host); } catch { return false; }
}

/**
 * Security middleware for a localhost wallet API:
 *  - helmet headers (CSP default-src 'none' for API responses, no sniffing, no framing, no referrer)
 *  - Host allowlist → blocks DNS-rebinding attacks against 127.0.0.1
 *  - cross-site request guard on unsafe methods (Origin / Sec-Fetch-Site) → blocks CSRF via "simple" text/plain or
 *    octet-stream POSTs that CORS preflight would not catch
 *  - rate limits: general, sensitive (passphrase/identity/signing), outbound (calls to public APIs)
 */
export function securityMiddleware(cfg: Pick<AppConfig, 'security'>): RequestHandler[] {
  const s = cfg.security;
  const limiter = (limit: number, name: string) => rateLimit({ windowMs: 60_000, limit, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: `Too many ${name} requests; slow down and retry in a minute` } });
  const general = limiter(s.rateLimit.general, 'API');
  const sensitive = limiter(s.rateLimit.sensitive, 'sensitive');
  const outbound = limiter(s.rateLimit.outbound, 'outbound');
  const SENSITIVE = [/^\/api\/vaults\/[^/]+(\/(unlock(\/sign|\/verify)?|passphrase|second-factor|restore))?$/, /^\/api\/messaging\/[^/]+\/identities/, /\/psbt\/sign$/, /^\/api\/wallets\/[^/]+\/registration\/ledger$/];
  const OUTBOUND = [/^\/api\/mainnet\/snapshot$/, /^\/api\/timeline\/refresh$/];
  return [
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'no-referrer' },
      strictTransportSecurity: false, // plain-http localhost; enable behind TLS (myNode nginx)
    }),
    (req: Request, res: Response, next: NextFunction) => {
      if (!allowedHost(cfg, req.headers.host)) { res.status(421).json({ error: 'Host not allowed (DNS-rebinding protection). Add it to API_ALLOWED_HOSTS.' }); return; }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const origin = req.headers.origin;
        if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && !allowedOrigin(cfg, origin))) { res.status(403).json({ error: 'Cross-site request blocked' }); return; }
      }
      next();
    },
    (req: Request, res: Response, next: NextFunction) => {
      if (!req.path.startsWith('/api/')) return next();
      if (req.method !== 'GET' && OUTBOUND.some((r) => r.test(req.path))) return outbound(req, res, () => general(req, res, next));
      if (req.method !== 'GET' && SENSITIVE.some((r) => r.test(req.path))) return sensitive(req, res, () => general(req, res, next));
      return general(req, res, next);
    },
  ];
}

/**
 * Restrict data files to the current user: umask 077 for new files, and tighten an existing data dir / .env that
 * earlier versions created world-readable. Best-effort (e.g. on filesystems without POSIX modes).
 */
export function hardenFilePermissions(dataDir: string, extra: string[] = []) {
  process.umask(0o077);
  const walk = (p: string) => {
    try {
      const st = statSync(p);
      if (st.isDirectory()) { if ((st.mode & 0o077) !== 0) chmodSync(p, 0o700); for (const f of readdirSync(p)) walk(join(p, f)); }
      else if ((st.mode & 0o077) !== 0) chmodSync(p, 0o600);
    } catch { /* missing or not ours */ }
  };
  walk(dataDir);
  for (const f of extra) if (existsSync(f)) walk(f);
}
