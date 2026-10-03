import { Router, type Request } from 'express';
import type { MessagingService } from './service.js';

export function messagingRouter(msg: MessagingService) {
  const r = Router();
  const wid = (req: Request) => String(req.params.walletId);
  const me = (req: Request) => msg.auth(wid(req), req.header('x-trustee-auth') ?? undefined);

  r.get('/alerts', (_req, res) => { res.json(msg.alerts()); });
  r.get('/:walletId/directory', async (req, res) => { res.json(await msg.directory(wid(req))); });
  r.post('/:walletId/identities/prepare', async (req, res) => { res.json(await msg.prepareAttestation(wid(req), req.body ?? {})); });
  r.post('/:walletId/identities/sign', async (req, res) => { res.json(await msg.signAttestation(wid(req), req.body ?? {})); });
  r.post('/:walletId/identities', async (req, res) => { res.status(201).json(await msg.register(wid(req), req.body ?? {})); });

  r.get('/:walletId/threads', (req, res) => { res.json(msg.threads(wid(req), me(req))); });
  r.get('/:walletId/threads/:threadId/messages', (req, res) => {
    res.json(msg.list(wid(req), me(req), String(req.params.threadId), Number(req.query.since ?? 0) || 0));
  });
  r.post('/:walletId/threads/:threadId/messages', (req, res) => {
    const env = req.body ?? {};
    if (env.threadId !== String(req.params.threadId)) { res.status(400).json({ error: 'threadId mismatch' }); return; }
    res.status(201).json(msg.post(wid(req), me(req), env));
  });
  r.post('/:walletId/threads/:threadId/read', (req, res) => { res.json(msg.read(wid(req), me(req), { ...(req.body ?? {}), threadId: String(req.params.threadId) })); });

  r.get('/:walletId/sigrequests', (req, res) => { res.json(msg.sigRequests(wid(req), me(req))); });
  r.post('/:walletId/sigrequests', async (req, res) => { res.status(201).json(await msg.createSigRequest(wid(req), me(req), req.body ?? {})); });
  r.get('/:walletId/sigrequests/:rid', (req, res) => { res.json(msg.sigRequest(wid(req), me(req), String(req.params.rid))); });
  r.post('/:walletId/sigrequests/:rid/sign', async (req, res) => { res.json(await msg.signSigRequest(wid(req), me(req), String(req.params.rid))); });
  r.post('/:walletId/sigrequests/:rid/import', async (req, res) => { res.json(await msg.importSigned(wid(req), me(req), String(req.params.rid), req.body?.psbt)); });
  r.post('/:walletId/sigrequests/:rid/broadcast', async (req, res) => { res.json(await msg.broadcastSigRequest(wid(req), me(req), String(req.params.rid))); });
  return r;
}
