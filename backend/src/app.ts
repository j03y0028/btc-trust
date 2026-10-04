import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import type { AppConfig } from './config.js';
import { BitcoinRpc } from './rpc.js';
import { ChainService } from './service.js';
import { STAGES } from './stages.js';
import { WalletStore } from './store.js';
import { WalletService } from './wallets.js';
import { WalletAdmin } from './wallet-admin.js';
import { CURRENCIES, PriceService, isCurrency } from './prices.js';
import { SettingsStore } from './settings.js';
import { HttpError, statusFor } from './errors.js';
import { Faucet } from './faucet.js';
import { HwiCliAdapter, type HwiAdapter } from './hwi.js';
import { MockHwiAdapter } from './hwi-mock.js';
import { DeviceService, type KeyPurpose } from './devices.js';
import { VaultService } from './vault/service.js';
import { vaultRouter } from './vault/routes.js';
import { IdentityKeys } from './identity.js';
import { MessagingService } from './messaging/service.js';
import { messagingRouter } from './messaging/routes.js';
import { TimelineService } from './timeline/service.js';
import { timelineRouter } from './timeline/routes.js';
import { RegistrationService } from './registration/service.js';
import { registrationRouter } from './registration/routes.js';
import { securityMiddleware } from './security.js';
import { AuthService, authRouter, requireLogin } from './auth.js';
import { READ_ONLY_METHODS, TestChainRpc } from './readonly-rpc.js';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function hwiFromConfig(cfg: AppConfig, rpc: BitcoinRpc): HwiAdapter | null {
  const { mode, bin, emulators, timeoutMs } = cfg.hwi;
  if (mode === 'off') return null;
  if (mode === 'mock') return new MockHwiAdapter(rpc);
  if (mode === 'cli' || HwiCliAdapter.available(bin)) return new HwiCliAdapter({ bin, network: cfg.network, emulators, timeoutMs });
  return null;
}

/** Extended private keys must never leave the node. */
const XPRV_RE = /\b[tx]prv[1-9A-HJ-NP-Za-km-z]{100,}/;

/** Wallet-side client: in split mode it refuses to talk to a node that reports mainnet. */
export const walletRpcFor = (cfg: AppConfig): BitcoinRpc => (cfg.mode === 'split' ? new TestChainRpc(cfg) : new BitcoinRpc(cfg));

/** Route prefixes that belong to the wallet side (test chain); switched off entirely with WALLET_FEATURES=off. */
const WALLET_PREFIXES = ['/api/wallets', '/api/devices', '/api/vaults', '/api/messaging', '/api/regtest'];

export function createApp(cfg: AppConfig, rpc: BitcoinRpc = walletRpcFor(cfg), store = new WalletStore(cfg.dataDir, cfg.network), hwi: HwiAdapter | null = hwiFromConfig(cfg, rpc), timeline = new TimelineService(cfg), auth = new AuthService(cfg), prices = new PriceService(cfg.prices ?? {})) {
  const svc = new ChainService(rpc);
  const mainnetSvc = timeline.node ? new ChainService(timeline.node) : null;
  const devices = new DeviceService(hwi, cfg.network);
  const wallets = new WalletService(rpc, store, cfg.network, devices);
  const faucet = new Faucet(rpc, cfg.network);
  const messaging = new MessagingService(wallets, new IdentityKeys(rpc, wallets, devices, cfg.network), { dataDir: cfg.dataDir });
  const vault = new VaultService(rpc, wallets, devices, faucet, { dataDir: cfg.dataDir, network: cfg.network, idleMs: cfg.vault.idleMs, kdfN: cfg.vault.kdfN });
  const registration = new RegistrationService(wallets, devices, { dataDir: cfg.dataDir, network: cfg.network });
  const admin = new WalletAdmin(rpc, store, wallets, vault, messaging, registration, { dataDir: cfg.dataDir, network: cfg.network });
  const app = express();
  app.locals.messaging = messaging;
  app.locals.timeline = timeline;
  app.locals.auth = auth;
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(...securityMiddleware(cfg));
  app.use(cors({ origin: [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/] }));
  // Backup restore can be large; it has its own parser.
  app.use((req, res, next) => (/^\/api\/vaults\/[^/]+\/restore$/.test(req.path) ? next() : express.json({ limit: '2mb' })(req, res, next)));
  app.use(express.raw({ type: 'application/octet-stream', limit: '2mb' }));
  app.use(express.text({ type: 'text/plain', limit: '2mb' }));

  // ---- App login (required beyond localhost) ----
  app.get('/api/healthz', (_req, res) => { res.json({ ok: true }); }); // liveness only, no data (Docker HEALTHCHECK)
  app.use('/api/auth', authRouter(auth, cfg));
  app.use(requireLogin(auth));

  if (!cfg.walletFeatures) {
    app.use((req, res, next) => {
      if (!WALLET_PREFIXES.some((p) => req.path === p || req.path.startsWith(p + '/'))) return next();
      res.status(503).json({ error: 'Wallet, vault and messaging features are switched off on this deployment (WALLET_FEATURES=off).', disabled: true });
    });
  }

  // Response guard: refuse to send anything that looks like an extended private key.
  app.use((_req, res, next) => {
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      if (XPRV_RE.test(JSON.stringify(body))) {
        res.status(500);
        return json({ error: 'Response blocked: contained private key material' });
      }
      return json(body);
    };
    next();
  });

  app.get('/api/health', async (_req, res) => {
    const mainnet = timeline.node
      ? await timeline.node.chain().then((chain) => ({ rpc: 'connected', chain, readOnly: true })).catch((e) => ({ rpc: 'unreachable', error: (e as Error).message, readOnly: true }))
      : undefined;
    if (!cfg.walletFeatures) { res.status(mainnet?.rpc === 'connected' ? 200 : 503).json({ ok: mainnet?.rpc === 'connected', mode: cfg.mode, mainnet, wallet: { enabled: false } }); return; }
    try {
      await rpc.call('getblockcount');
      res.json({ ok: true, rpc: 'connected', network: cfg.network, mode: cfg.mode, ...(mainnet ? { mainnet } : {}) });
    } catch (e) {
      res.status(503).json({ ok: false, rpc: 'unreachable', error: (e as Error).message, mode: cfg.mode, ...(mainnet ? { mainnet } : {}) });
    }
  });

  /** How this deployment is split: which chain feeds the dashboard/timeline and where wallets live. */
  app.get('/api/mode', (_req, res) => {
    res.json({
      mode: cfg.mode,
      mainnet: cfg.mainnet.node ? { configured: true, readOnly: true, expectChain: cfg.mainnet.node.expectChain, auth: cfg.mainnet.node.cookieFile ? 'cookie' : 'rpcauth', methods: READ_ONLY_METHODS, refused: timeline.node?.refused.length ?? 0 } : { configured: false },
      wallet: { enabled: cfg.walletFeatures, network: cfg.walletFeatures ? cfg.network : null },
      auth: { required: auth.required },
    });
  });

  // ?source=mainnet → the read-only mainnet node (myNode); default → the wallet node.
  const chainFor = (req: Request) => {
    if (req.query.source === 'mainnet') {
      if (!mainnetSvc) throw new HttpError(404, 'No mainnet node configured (MAINNET_RPC_HOST)');
      return mainnetSvc;
    }
    if (!cfg.walletFeatures) throw new HttpError(503, 'Wallet node disabled (WALLET_FEATURES=off); use ?source=mainnet');
    return svc;
  };
  app.get('/api/blockchain', async (req, res) => {
    res.json(await chainFor(req).summary());
  });

  app.get('/api/blocks', async (req, res) => {
    const count = Number(req.query.count ?? 10);
    if (!Number.isFinite(count) || count < 1) {
      res.status(400).json({ error: 'count must be a positive number' });
      return;
    }
    res.json(await chainFor(req).recentBlocks(count));
  });

  app.get('/api/stages', (_req, res) => {
    res.json(STAGES);
  });

  // ---- Wallets ----
  const psbtOf = (req: Request): string => {
    const p = req.body?.psbt;
    if (typeof p !== 'string' || !p) throw new HttpError(400, 'psbt (base64) is required');
    return p;
  };
  const id = (req: Request) => String(req.params.id);

  app.get('/api/wallets', async (_req, res) => res.json(await wallets.list()));
  app.post('/api/wallets', async (req, res) => res.status(201).json(wallets.publicConfig(await wallets.create(req.body ?? {}))));
  app.get('/api/wallets/:id', async (req, res) => res.json(await wallets.details(id(req))));
  // Rename: display name only (id, bitcoind wallet names and descriptors never change).
  app.patch('/api/wallets/:id', (req, res) => { res.json(admin.rename(id(req), req.body)); });
  // Delete (regtest test wallets only): impact preview, then delete with the typed name as confirmation.
  app.get('/api/wallets/:id/delete-check', async (req, res) => { res.json(await admin.impact(id(req))); });
  app.delete('/api/wallets/:id', async (req, res) => { res.json(await admin.delete(id(req), req.body ?? {})); });
  app.post('/api/wallets/:id/address', async (req, res) => res.json(await wallets.newAddress(id(req))));
  app.post('/api/wallets/:id/psbt', async (req, res) => res.json(await wallets.createPsbt(id(req), req.body)));
  app.post('/api/wallets/:id/psbt/decode', async (req, res) => res.json(await wallets.decode(id(req), psbtOf(req))));
  app.post('/api/wallets/:id/psbt/sign', async (req, res) => {
    const c = req.body?.cosigner;
    res.json(await wallets.sign(id(req), psbtOf(req), { cosigner: c === undefined || c === null || c === 'auto' ? undefined : Number(c), fallback: req.body?.fallback === true }));
  });
  app.post('/api/wallets/:id/psbt/export', async (req, res) => {
    const buf = wallets.exportPsbt(psbtOf(req));
    const info = await wallets.decode(id(req), psbtOf(req));
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-disposition', `attachment; filename="${id(req)}-${info.txid.slice(0, 8)}-${info.signatures}of${info.required}.psbt"`);
    res.send(buf);
  });
  app.post('/api/wallets/:id/psbt/import', async (req, res) => {
    // Accepts a binary .psbt file (application/octet-stream), base64/hex text, or JSON {psbt, base?}.
    const base = typeof req.query.base === 'string' ? req.query.base : req.body?.base;
    const data = Buffer.isBuffer(req.body) ? req.body : typeof req.body === 'string' ? req.body : req.body?.psbt;
    if (!data || (typeof data === 'string' && !data.trim()) || (Buffer.isBuffer(data) && !data.length)) throw new HttpError(400, 'PSBT file or text is required');
    res.json(await wallets.importPsbt(id(req), data, base));
  });
  app.post('/api/wallets/:id/verify-address', async (req, res) => {
    res.json(await wallets.verifyAddress(id(req), Number(req.body?.cosigner), String(req.body?.address ?? '')));
  });

  // ---- Hardware wallets (HWI) ----
  app.get('/api/devices/status', async (_req, res) => res.json(await devices.status()));
  app.get('/api/devices', async (req, res) => {
    if (!devices.available) { res.json([]); return; }
    res.json(await devices.list(req.query.refresh === '1'));
  });
  app.post('/api/devices/:fingerprint/xpub', async (req, res) => {
    const purpose = (req.body?.purpose ?? 'multisig') as KeyPurpose;
    if (purpose !== 'multisig' && purpose !== 'singlesig') throw new HttpError(400, 'purpose must be multisig or singlesig');
    res.json(await devices.xpub(String(req.params.fingerprint), purpose, Number(req.body?.account ?? 0)));
  });
  app.post('/api/wallets/:id/psbt/combine', async (req, res) => res.json(await wallets.combine(id(req), req.body?.psbts)));
  app.post('/api/wallets/:id/psbt/finalize', async (req, res) => res.json(await wallets.finalize(id(req), psbtOf(req))));
  app.post('/api/wallets/:id/psbt/broadcast', async (req, res) => res.json(await wallets.broadcast(id(req), psbtOf(req))));

  // ---- Multisig registration on signing devices (Coldcard file, Ledger policy, Trezor: none) ----
  app.use('/api/wallets', registrationRouter(registration));

  // ---- Trust vault ----
  app.use('/api/vaults', vaultRouter(vault));
  app.use('/api/messaging', messagingRouter(messaging));
  // ---- Timeline & goals (mainnet data is read-only: public APIs or getblockchaininfo) ----
  // ---- Display: BTC → fiat prices (backend proxy, cached) and the saved display choice ----
  const settings = new SettingsStore(cfg.dataDir);
  app.get('/api/prices/currencies', (_req, res) => {
    res.json({ enabled: prices.enabled, currencies: CURRENCIES.map(([code, name]) => ({ code, name })), sources: prices.sources.map((s) => s.name) });
  });
  app.get('/api/prices', async (req, res) => {
    const c = String(req.query.currency ?? 'USD').toUpperCase();
    if (!isCurrency(c)) throw new HttpError(400, `Unsupported currency: ${c.slice(0, 10)}`);
    res.setHeader('Cache-Control', 'no-store');
    res.json(await prices.price(c));
  });
  app.get('/api/settings/display', (_req, res) => { res.json(settings.display()); });
  app.put('/api/settings/display', (req, res) => { res.json(settings.setDisplay(req.body)); });

  app.use('/api', timelineRouter(timeline));

  // ---- Regtest helpers (disabled on every other network) ----
  const target = async (req: Request): Promise<string | undefined> => {
    if (typeof req.body?.address === 'string' && req.body.address) return req.body.address;
    if (req.body?.walletId) return (await wallets.newAddress(String(req.body.walletId))).address;
    return undefined;
  };
  app.post('/api/regtest/mine', async (req, res) => {
    if (cfg.network !== 'regtest') throw new HttpError(403, 'Mining helper is only available on regtest');
    const blocks = Number(req.body?.blocks ?? 1);
    if (!Number.isInteger(blocks) || blocks < 1 || blocks > 500) throw new HttpError(400, 'blocks must be 1..500');
    const address = await target(req); // default: rewards go to the faucet
    const hashes = await faucet.mine(blocks, address);
    res.json({ address: address ?? 'faucet', blocks: hashes.length, tip: hashes.at(-1) });
  });
  app.post('/api/regtest/fund', async (req, res) => {
    if (cfg.network !== 'regtest') throw new HttpError(403, 'Faucet is only available on regtest');
    const address = await target(req);
    if (!address) throw new HttpError(400, 'address or walletId is required');
    res.json({ address, ...(await faucet.fund(address, Number(req.body?.amount ?? 1), req.body?.confirm !== false)) });
  });

  // ---- Built frontend on the same port (Docker / myNode) ----
  if (cfg.staticDir) {
    const dir = resolve(cfg.staticDir);
    const index = join(dir, 'index.html');
    app.use(express.static(dir, { index: false, maxAge: '1h', setHeaders: (res, path) => { if (path.endsWith('.html')) res.setHeader('cache-control', 'no-store'); } }));
    app.get(/^(?!\/api(\/|$)).*/, (_req, res, next) => (existsSync(index) ? res.setHeader('cache-control', 'no-store').sendFile(index) : next()));
  }
  app.use('/api', (_req, res) => { res.status(404).json({ error: 'Not found' }); });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as Error & { details?: unknown };
    res.status(statusFor(err)).json({ error: e.message ?? 'Internal error', ...(e.details ? { details: e.details } : {}) });
  });

  return app;
}
