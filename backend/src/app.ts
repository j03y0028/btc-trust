import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import type { AppConfig } from './config.js';
import { BitcoinRpc } from './rpc.js';
import { ChainService } from './service.js';
import { STAGES } from './stages.js';
import { WalletStore } from './store.js';
import { WalletService } from './wallets.js';
import { HttpError, statusFor } from './errors.js';
import { Faucet } from './faucet.js';

/** Extended private keys must never leave the node. */
const XPRV_RE = /\b[tx]prv[1-9A-HJ-NP-Za-km-z]{100,}/;

export function createApp(cfg: AppConfig, rpc = new BitcoinRpc(cfg), store = new WalletStore(cfg.dataDir, cfg.network)) {
  const svc = new ChainService(rpc);
  const wallets = new WalletService(rpc, store, cfg.network);
  const faucet = new Faucet(rpc, cfg.network);
  const app = express();
  app.use(cors({ origin: [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/] }));
  app.use(express.json({ limit: '2mb' }));

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
    try {
      await rpc.call('getblockcount');
      res.json({ ok: true, rpc: 'connected', network: cfg.network });
    } catch (e) {
      res.status(503).json({ ok: false, rpc: 'unreachable', error: (e as Error).message });
    }
  });

  app.get('/api/blockchain', async (_req, res) => {
    res.json(await svc.summary());
  });

  app.get('/api/blocks', async (req, res) => {
    const count = Number(req.query.count ?? 10);
    if (!Number.isFinite(count) || count < 1) {
      res.status(400).json({ error: 'count must be a positive number' });
      return;
    }
    res.json(await svc.recentBlocks(count));
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
  app.post('/api/wallets/:id/address', async (req, res) => res.json(await wallets.newAddress(id(req))));
  app.post('/api/wallets/:id/psbt', async (req, res) => res.json(await wallets.createPsbt(id(req), req.body)));
  app.post('/api/wallets/:id/psbt/decode', async (req, res) => res.json(await wallets.decode(id(req), psbtOf(req))));
  app.post('/api/wallets/:id/psbt/sign', async (req, res) => res.json(await wallets.sign(id(req), psbtOf(req), Number(req.body?.cosigner))));
  app.post('/api/wallets/:id/psbt/combine', async (req, res) => res.json(await wallets.combine(id(req), req.body?.psbts)));
  app.post('/api/wallets/:id/psbt/finalize', async (req, res) => res.json(await wallets.finalize(id(req), psbtOf(req))));
  app.post('/api/wallets/:id/psbt/broadcast', async (req, res) => res.json(await wallets.broadcast(id(req), psbtOf(req))));

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

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as Error & { details?: unknown };
    res.status(statusFor(err)).json({ error: e.message ?? 'Internal error', ...(e.details ? { details: e.details } : {}) });
  });

  return app;
}
