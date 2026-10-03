import { Router } from 'express';
import type { TimelineService } from './service.js';

export function timelineRouter(t: TimelineService) {
  const r = Router();
  r.get('/timeline', async (req, res) => res.json(await t.timeline({ since: typeof req.query.since === 'string' ? req.query.since : undefined })));
  r.post('/timeline/refresh', async (_req, res) => res.json(await t.timeline({ force: true })));
  r.get('/mainnet/daily', (_req, res) => res.json(t.daily()));
  r.post('/mainnet/snapshot', async (_req, res) => {
    try {
      const out = await t.mainnet.snapshot();
      res.status(out.created ? 201 : 200).json(out);
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  });
  r.get('/progress', async (_req, res) => res.json(await t.progress()));
  return r;
}
