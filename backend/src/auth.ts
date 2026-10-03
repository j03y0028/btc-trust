import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { Router, type NextFunction, type Request, type Response } from 'express';
import type { AppConfig } from './config.js';
import { isLoopback } from './security.js';

/**
 * App login for deployments reachable beyond localhost (myNode). One shared app passphrase, chosen on first run,
 * stored only as a scrypt hash. Successful login → random 256-bit session id in an HttpOnly cookie; the server keeps
 * only SHA-256(session id). Independent of — and in addition to — the vault passphrase and the trustee keyring.
 */
export const COOKIE = 'btctrust_sid';
export const MIN_APP_PASSPHRASE = 12;
const AUTH_FILE = 'auth.json';
const TOKEN_FILE = 'setup-token';

interface AuthRecord { v: 1; kdf: 'scrypt'; N: number; r: number; p: number; salt: string; hash: string; createdAt: string; changedAt?: string }
interface Session { idHash: string; created: number; lastSeen: number }

const scrypt = (pw: string, salt: Buffer, N: number, r: number, p: number) =>
  new Promise<Buffer>((res, rej) => scryptCb(pw.normalize('NFKC'), salt, 32, { N, r, p, maxmem: 256 * N * r + 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))));
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function authRequired(cfg: Pick<AppConfig, 'auth' | 'apiHost'>) {
  if (cfg.auth.mode === 'on') return true;
  if (cfg.auth.mode === 'off') {
    if (!isLoopback(cfg.apiHost)) throw new Error(`AUTH_MODE=off is refused while the API binds to ${cfg.apiHost}. The app login is mandatory beyond localhost.`);
    return false;
  }
  return !isLoopback(cfg.apiHost);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export class AuthService {
  readonly required: boolean;
  private sessions = new Map<string, Session>();
  private failures = 0;
  private lockedUntil = 0;
  private setupToken: string | null = null;
  constructor(private cfg: Pick<AppConfig, 'auth' | 'apiHost' | 'dataDir'>, private now = () => Date.now()) {
    this.required = authRequired(cfg);
    if (this.required && !this.configured) this.setupToken = this.ensureSetupToken();
  }

  private get file() { return join(this.cfg.dataDir, AUTH_FILE); }
  private get tokenFile() { return join(this.cfg.dataDir, TOKEN_FILE); }
  get configured() { return existsSync(this.file); }
  private record(): AuthRecord | null { try { return JSON.parse(readFileSync(this.file, 'utf8')); } catch { return null; } }

  /** One-time token that must accompany first-run setup, so nobody else on the LAN can claim the app first. */
  private ensureSetupToken(): string {
    if (this.cfg.auth.setupToken) return this.cfg.auth.setupToken;
    if (existsSync(this.tokenFile)) return readFileSync(this.tokenFile, 'utf8').trim();
    const t = randomBytes(15).toString('base64url'); // 120 bits
    mkdirSync(this.cfg.dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.tokenFile, t + '\n', { mode: 0o600 });
    return t;
  }
  get setupTokenPath() { return this.setupToken && !this.cfg.auth.setupToken ? this.tokenFile : null; }
  /** For the startup log only. */
  get pendingSetupToken() { return this.setupToken; }

  private lockout() {
    const ms = this.lockedUntil - this.now();
    return ms > 0 ? Math.ceil(ms / 1000) : 0;
  }
  private fail() {
    this.failures++;
    if (this.failures >= 5) this.lockedUntil = this.now() + Math.min(15 * 60_000, 1000 * 2 ** (this.failures - 5));
  }

  async setup(passphrase: unknown, token: unknown) {
    if (this.configured) throw Object.assign(new Error('App passphrase is already set'), { status: 409 });
    const wait = this.lockout();
    if (wait) throw Object.assign(new Error(`Too many attempts; wait ${wait}s`), { status: 429 });
    const want = this.setupToken ?? '';
    const got = typeof token === 'string' ? token.trim() : '';
    if (this.required && (!want || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want)))) {
      this.fail();
      throw Object.assign(new Error('Setup token is wrong (see the myNode app page or data/setup-token)'), { status: 403 });
    }
    await this.write(this.checkStrength(passphrase));
    this.failures = 0;
    if (existsSync(this.tokenFile)) rmSync(this.tokenFile);
    this.setupToken = null;
    return this.newSession();
  }

  private checkStrength(p: unknown): string {
    if (typeof p !== 'string' || p.length < MIN_APP_PASSPHRASE) throw Object.assign(new Error(`Passphrase must be at least ${MIN_APP_PASSPHRASE} characters`), { status: 400 });
    if (p.length > 1024) throw Object.assign(new Error('Passphrase too long'), { status: 400 });
    return p;
  }

  private async write(passphrase: string, prev?: AuthRecord) {
    const salt = randomBytes(16);
    const { scryptN: N } = this.cfg.auth;
    const key = await scrypt(passphrase, salt, N, 8, 1);
    const rec: AuthRecord = { v: 1, kdf: 'scrypt', N, r: 8, p: 1, salt: salt.toString('base64'), hash: key.toString('base64'), createdAt: prev?.createdAt ?? new Date(this.now()).toISOString(), ...(prev ? { changedAt: new Date(this.now()).toISOString() } : {}) };
    mkdirSync(this.cfg.dataDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.file + '.tmp', JSON.stringify(rec, null, 2), { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file);
  }

  async verify(passphrase: unknown): Promise<boolean> {
    const rec = this.record();
    if (!rec || typeof passphrase !== 'string' || passphrase.length > 1024) return false;
    const key = await scrypt(passphrase, Buffer.from(rec.salt, 'base64'), rec.N, rec.r, rec.p);
    const want = Buffer.from(rec.hash, 'base64');
    return key.length === want.length && timingSafeEqual(key, want);
  }

  async login(passphrase: unknown) {
    if (!this.configured) throw Object.assign(new Error('App passphrase not set yet'), { status: 409 });
    const wait = this.lockout();
    if (wait) throw Object.assign(new Error(`Too many failed logins; wait ${wait}s`), { status: 429, retryAfter: wait });
    if (!(await this.verify(passphrase))) {
      this.fail();
      throw Object.assign(new Error('Wrong passphrase'), { status: 401 });
    }
    this.failures = 0;
    return this.newSession();
  }

  async changePassphrase(current: unknown, next: unknown) {
    if (!(await this.verify(current))) { this.fail(); throw Object.assign(new Error('Current passphrase is wrong'), { status: 401 }); }
    await this.write(this.checkStrength(next), this.record() ?? undefined);
    this.sessions.clear(); // everyone logs in again
    return this.newSession();
  }

  private newSession() {
    const id = randomBytes(32).toString('base64url');
    const t = this.now();
    this.sessions.set(sha(id), { idHash: sha(id), created: t, lastSeen: t });
    return id;
  }

  /** Valid session for this cookie value? Slides the idle timer. */
  check(id: string | undefined): boolean {
    if (!id) return false;
    const s = this.sessions.get(sha(id));
    if (!s) return false;
    const t = this.now();
    if (t - s.lastSeen > this.cfg.auth.sessionIdleMs || t - s.created > this.cfg.auth.sessionMaxMs) { this.sessions.delete(s.idHash); return false; }
    s.lastSeen = t;
    return true;
  }
  logout(id: string | undefined) { if (id) this.sessions.delete(sha(id)); }
  get activeSessions() { return this.sessions.size; }

  /** For non-Express callers (WebSocket upgrade). */
  allows(req: IncomingMessage) { return !this.required || this.check(parseCookies(req.headers.cookie)[COOKIE]); }
}

const secureReq = (req: Request) => req.secure || req.headers['x-forwarded-proto'] === 'https';
function setCookie(req: Request, res: Response, id: string, maxMs: number) {
  // Lax (not Strict): opening the app from the myNode home page is a cross-scheme navigation (http → https:9331).
  res.cookie(COOKIE, id, { httpOnly: true, sameSite: 'lax', secure: secureReq(req), path: '/', maxAge: maxMs });
}

export function authRouter(auth: AuthService, cfg: Pick<AppConfig, 'auth'>) {
  const r = Router();
  const sid = (req: Request) => parseCookies(req.headers.cookie)[COOKIE];
  r.get('/status', (req, res) => {
    res.json({ required: auth.required, configured: auth.configured, authenticated: !auth.required || auth.check(sid(req)), setupTokenRequired: auth.required && !auth.configured, minLength: MIN_APP_PASSPHRASE });
  });
  r.post('/setup', async (req, res) => {
    const id = await auth.setup(req.body?.passphrase, req.body?.setupToken);
    setCookie(req, res, id, cfg.auth.sessionMaxMs);
    res.status(201).json({ ok: true });
  });
  r.post('/login', async (req, res) => {
    try {
      const id = await auth.login(req.body?.passphrase);
      setCookie(req, res, id, cfg.auth.sessionMaxMs);
      res.json({ ok: true });
    } catch (e) {
      const ra = (e as { retryAfter?: number }).retryAfter;
      if (ra) res.setHeader('retry-after', String(ra));
      throw e;
    }
  });
  r.post('/logout', (req, res) => {
    auth.logout(sid(req));
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  });
  r.post('/passphrase', async (req, res) => {
    if (auth.required && !auth.check(sid(req))) { res.status(401).json({ error: 'Login required', auth: 'required' }); return; }
    const id = await auth.changePassphrase(req.body?.current, req.body?.next);
    setCookie(req, res, id, cfg.auth.sessionMaxMs);
    res.json({ ok: true });
  });
  return r;
}

/** Everything under /api except login endpoints and the bare liveness probe needs a session when auth is required. */
export function requireLogin(auth: AuthService) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!auth.required || !req.path.startsWith('/api/') || req.path.startsWith('/api/auth/') || req.path === '/api/healthz') return next();
    if (auth.check(parseCookies(req.headers.cookie)[COOKIE])) return next();
    res.setHeader('x-auth-required', '1');
    res.status(401).json({ error: 'Login required', auth: 'required' });
  };
}
