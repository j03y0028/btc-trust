import { Router } from 'express';
import type { RegistrationService } from './service.js';

export function registrationRouter(r: RegistrationService) {
  const x = Router();
  const id = (p: unknown) => String(p);
  x.get('/:id/registration', async (req, res) => res.json(await r.status(id(req.params.id))));
  x.get('/:id/registration/coldcard', (req, res) => res.json(r.coldcard(id(req.params.id))));
  x.get('/:id/registration/coldcard.txt', (req, res) => {
    const f = r.coldcard(id(req.params.id));
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="${f.filename}"`);
    res.send(f.text);
  });
  x.post('/:id/registration/coldcard/confirm', (req, res) => res.json(r.confirmColdcard(id(req.params.id), Number(req.body?.cosigner))));
  x.post('/:id/registration/ledger', async (req, res) => res.status(201).json(await r.registerLedger(id(req.params.id), Number(req.body?.cosigner))));
  x.get('/:id/registration/ledger/:cosigner/verify', (req, res) => res.json(r.verifyLedger(id(req.params.id), Number(req.params.cosigner))));
  return x;
}
