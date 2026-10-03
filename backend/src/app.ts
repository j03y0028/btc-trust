import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import type { AppConfig } from './config.js';
import { BitcoinRpc, RpcError } from './rpc.js';
import { ChainService } from './service.js';
import { STAGES } from './stages.js';

export function createApp(cfg: AppConfig, rpc = new BitcoinRpc(cfg)) {
  const svc = new ChainService(rpc);
  const app = express();
  app.use(cors({ origin: [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/] }));
  app.use(express.json());

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

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof RpcError ? 502 : 500;
    res.status(status).json({ error: (err as Error).message ?? 'Internal error' });
  });

  return app;
}
