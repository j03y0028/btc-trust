import express, { Router, type Request } from 'express';
import { HttpError } from '../errors.js';
import type { VaultService } from './service.js';

export function vaultRouter(vault: VaultService) {
  const r = Router();
  const token = (req: Request) => req.header('x-vault-session') ?? undefined;
  const wid = (req: Request) => String(req.params.walletId);
  const sess = (req: Request) => vault.session(wid(req), token(req));
  const num = (v: unknown) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Invalid version');
    return n;
  };

  r.get('/:walletId/status', (req, res) => { res.json(vault.status(wid(req), token(req))); });
  r.post('/:walletId', async (req, res) => { res.status(201).json(await vault.create(wid(req), req.body ?? {})); });
  r.post('/:walletId/unlock', async (req, res) => { res.json(await vault.unlock(wid(req), req.body?.passphrase)); });
  r.post('/:walletId/unlock/sign', async (req, res) => { res.json(await vault.signChallenge(wid(req), req.body?.challengeId)); });
  r.post('/:walletId/unlock/verify', async (req, res) => { res.json(await vault.verifyChallenge(wid(req), req.body?.challengeId, req.body?.signature)); });
  r.post('/:walletId/lock', (req, res) => { res.json(vault.lock(token(req) ?? '')); });
  r.post('/:walletId/ping', (req, res) => { sess(req); res.json(vault.status(wid(req), token(req))); });

  r.get('/:walletId/templates/:type', (req, res) => { sess(req); res.json(vault.template(wid(req), String(req.params.type))); });
  r.get('/:walletId/documents', (req, res) => { res.json(vault.list(sess(req))); });
  r.post('/:walletId/documents', (req, res) => { res.status(201).json(vault.createDoc(sess(req), req.body ?? {})); });
  r.get('/:walletId/documents/:docId', (req, res) => { res.json(vault.get(sess(req), String(req.params.docId))); });
  r.put('/:walletId/documents/:docId', (req, res) => { res.json(vault.updateDoc(sess(req), String(req.params.docId), req.body ?? {})); });
  r.delete('/:walletId/documents/:docId', (req, res) => { res.json(vault.deleteDoc(sess(req), String(req.params.docId))); });
  r.get('/:walletId/documents/:docId/versions/:v/verify', (req, res) => { res.json(vault.verifyVersion(sess(req), String(req.params.docId), num(req.params.v))); });
  r.post('/:walletId/documents/:docId/versions/:v/anchor', async (req, res) => {
    res.json(await vault.anchor(sess(req), String(req.params.docId), num(req.params.v), req.body?.confirm !== false));
  });
  r.get('/:walletId/documents/:docId/versions/:v/anchor', async (req, res) => {
    res.json(await vault.verifyAnchor(sess(req), String(req.params.docId), num(req.params.v)));
  });

  // Attachments: raw body with the file's real MIME type; name in x-filename.
  r.post('/:walletId/documents/:docId/attachments', express.raw({ type: () => true, limit: '12mb' }), (req, res) => {
    const s = sess(req);
    const mime = String(req.header('content-type') ?? '').split(';')[0].trim();
    const name = decodeURIComponent(String(req.header('x-filename') ?? 'file'));
    res.status(201).json(vault.addAttachment(s, String(req.params.docId), name, mime, req.body as Buffer));
  });
  r.get('/:walletId/documents/:docId/attachments/:attId', (req, res) => {
    const { meta, data } = vault.getAttachment(sess(req), String(req.params.docId), String(req.params.attId));
    res.setHeader('content-type', meta.mime);
    res.setHeader('content-disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${meta.name}"`);
    res.setHeader('cache-control', 'no-store');
    res.send(data);
  });

  r.post('/:walletId/passphrase', async (req, res) => { res.json(await vault.changePassphrase(sess(req), req.body?.current, req.body?.next)); });
  r.post('/:walletId/second-factor', async (req, res) => { res.json(await vault.setSecondFactor(sess(req), req.body?.passphrase, req.body?.secondFactor ?? null)); });
  r.get('/:walletId/backup', (req, res) => {
    const b = vault.exportBackup(sess(req));
    res.setHeader('content-disposition', `attachment; filename="${wid(req)}-vault-backup.json"`);
    res.json(b);
  });
  r.post('/:walletId/restore', express.json({ limit: '40mb' }), async (req, res) => { res.json(await vault.restoreBackup(wid(req), req.body ?? {})); });
  return r;
}
