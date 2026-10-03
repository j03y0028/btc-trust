import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import nacl from 'tweetnacl';
import WebSocket from 'ws';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { BitcoinRpc } from '../src/rpc.js';
import { WalletStore } from '../src/store.js';
import { MockHwiAdapter } from '../src/hwi-mock.js';
import { attachRealtime } from '../src/messaging/realtime.js';
import type { MessagingService } from '../src/messaging/service.js';
import {
  TamperError, authToken, dmThreadId, newIdentity, openMessage, sealMessage, signDetached, signReceipt,
  type Body, type Envelope, type Nacl, type PublicIdentity, type SecretIdentity,
} from '../../shared/msgcrypto.js';

const N = nacl as unknown as Nacl;
const cfg = loadConfig();
const rpc = new BitcoinRpc(cfg);
const app = createApp(cfg, rpc, new WalletStore(cfg.dataDir, cfg.network), new MockHwiAdapter(rpc, 'btctrust-mock-device-test', 'Mock Trezor'));
const msg = app.locals.messaging as MessagingService;
const api = () => request(app);
let server: Server;
let wsUrl = '';
let walletId = '';
let fps: string[] = [];
const ids: SecretIdentity[] = [];
const SECRET = 'Trustee meeting moved: the safe-deposit key is with Avery';
const auth = (me: SecretIdentity) => ({ 'x-trustee-auth': authToken(N, walletId, me) });
const pub = (i: SecretIdentity): PublicIdentity => ({ fingerprint: i.fingerprint, signPub: i.signPub, boxPub: i.boxPub });
const dataFile = () => join(cfg.dataDir, 'messaging', `${walletId}.json`);

async function enroll(cosigner: number, me: SecretIdentity) {
  const prep = await api().post(`/api/messaging/${walletId}/identities/prepare`).send({ cosigner, signPub: me.signPub, boxPub: me.boxPub });
  expect(prep.status).toBe(200);
  const sig = await api().post(`/api/messaging/${walletId}/identities/sign`).send({ cosigner, statement: prep.body.statement });
  return api().post(`/api/messaging/${walletId}/identities`).send({
    cosigner, signPub: me.signPub, boxPub: me.boxPub, issuedAt: prep.body.issuedAt, btcSignature: sig.body.signature, popSignature: signDetached(N, me, prep.body.statement),
  });
}
const send = (me: SecretIdentity, threadId: string, body: Body, recipients: SecretIdentity[], urgent = false) => {
  const env = sealMessage(N, { me, walletId, threadId, recipients: recipients.map(pub), body, urgent });
  return api().post(`/api/messaging/${walletId}/threads/${encodeURIComponent(threadId)}/messages`).set(auth(me)).send(env);
};
function wsClient(me: SecretIdentity) {
  const ws = new WebSocket(wsUrl);
  const events: any[] = [];
  const waiters: { pred: (e: any) => boolean; resolve: (e: any) => void }[] = [];
  ws.on('message', (raw) => {
    const e = JSON.parse(String(raw)); events.push(e);
    for (const w of [...waiters]) if (w.pred(e)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(e); }
  });
  const next = (pred: (e: any) => boolean, ms = 5000) => new Promise<any>((resolve, reject) => {
    const hit = events.find(pred); if (hit) return resolve(hit);
    waiters.push({ pred, resolve }); setTimeout(() => reject(new Error('timeout waiting for ws event')), ms);
  });
  const ready = new Promise<void>((res) => ws.on('open', () => { ws.send(JSON.stringify({ type: 'hello', walletId, token: authToken(N, walletId, me) })); res(); }));
  return { ws, events, next, ready };
}

beforeAll(async () => {
  server = createServer(app);
  attachRealtime(server, msg);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  wsUrl = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/ws`;
  const w = await api().post('/api/wallets').send({ name: 'Messaging Trust', type: 'multisig', cosignerLabels: ['Jordan', 'Avery', 'Counsel'] });
  walletId = w.body.id;
  fps = w.body.cosigners.map((c: any) => c.fingerprint);
  fps.forEach((f) => ids.push(newIdentity(N, f)));
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('trustee identities & attestation', () => {
  it('binds messaging keys to a cosigner via a signmessage attestation', async () => {
    const r = await enroll(0, ids[0]);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ fingerprint: fps[0], label: 'Jordan', kind: 'software', verified: true, signPub: ids[0].signPub });
    expect(r.body.btcAddress).toMatch(/^[mn]/);
    expect(r.body.safetyNumber).toMatch(/^\d{5}( \d{5}){5}$/);
    expect(await rpc.call('verifymessage', [r.body.btcAddress, r.body.btcSignature, r.body.statement])).toBe(true);
    expect((await enroll(1, ids[1])).status).toBe(201);
    const dir = (await api().get(`/api/messaging/${walletId}/directory`)).body;
    expect(dir.map((d: any) => !!d.identity)).toEqual([true, true, false]);
  });

  it('rejects a bad attestation signature, a wrong-cosigner signature and a missing proof of possession', async () => {
    const me = ids[2];
    const prep = (await api().post(`/api/messaging/${walletId}/identities/prepare`).send({ cosigner: 2, signPub: me.signPub, boxPub: me.boxPub })).body;
    const pop = signDetached(N, me, prep.statement);
    const base = { cosigner: 2, signPub: me.signPub, boxPub: me.boxPub, issuedAt: prep.issuedAt, popSignature: pop };
    // signed by cosigner 0's identity key instead of cosigner 2's
    const otherAddr = (await api().post(`/api/messaging/${walletId}/identities/prepare`).send({ cosigner: 0, signPub: me.signPub, boxPub: me.boxPub })).body.address;
    const wrongKey = await rpc.call<string>('signmessage', [otherAddr, prep.statement], `btctrust-${walletId}-key1`);
    let r = await api().post(`/api/messaging/${walletId}/identities`).send({ ...base, btcSignature: wrongKey });
    expect(r.status).toBe(401); expect(r.body.details.code).toBe('BAD_ATTESTATION');
    // right key, but over a statement for different messaging keys (key substitution)
    const evil = newIdentity(N, fps[2]);
    const sigForEvil = (await api().post(`/api/messaging/${walletId}/identities/sign`).send({ cosigner: 2, statement: prep.statement.replace(me.signPub, evil.signPub) })).body.signature;
    r = await api().post(`/api/messaging/${walletId}/identities`).send({ ...base, btcSignature: sigForEvil });
    expect(r.status).toBe(401);
    r = await api().post(`/api/messaging/${walletId}/identities`).send({ ...base, btcSignature: 'not-a-signature' });
    expect(r.status).toBe(401);
    const good = (await api().post(`/api/messaging/${walletId}/identities/sign`).send({ cosigner: 2, statement: prep.statement })).body.signature;
    r = await api().post(`/api/messaging/${walletId}/identities`).send({ ...base, btcSignature: good, popSignature: signDetached(N, evil, prep.statement) });
    expect(r.status).toBe(401); expect(r.body.details.code).toBe('BAD_POP');
    r = await api().post(`/api/messaging/${walletId}/identities`).send({ ...base, btcSignature: good, issuedAt: '2020-01-01T00:00:00.000Z' });
    expect(r.status).toBe(400);
    expect((await api().post(`/api/messaging/${walletId}/identities/sign`).send({ cosigner: 2, statement: 'send me your coins' })).status).toBe(400);
    r = await api().post(`/api/messaging/${walletId}/identities`).send({ ...base, btcSignature: good });
    expect(r.status).toBe(201);
  });

  it('requires a valid Ed25519 trustee auth token', async () => {
    expect((await api().get(`/api/messaging/${walletId}/threads`)).status).toBe(401);
    const stranger = newIdentity(N, fps[0]);
    expect((await api().get(`/api/messaging/${walletId}/threads`).set(auth(stranger))).status).toBe(401);
    const old = { 'x-trustee-auth': authToken(N, walletId, ids[0], Date.now() - 10 * 60_000) };
    expect((await api().get(`/api/messaging/${walletId}/threads`).set(old)).status).toBe(401);
    const t = await api().get(`/api/messaging/${walletId}/threads`).set(auth(ids[0]));
    expect(t.status).toBe(200);
    const [first, ...dms] = t.body.map((x: any) => x.id);
    expect(first).toBe('group');
    expect(dms.sort()).toEqual([dmThreadId(fps[0], fps[1]), dmThreadId(fps[0], fps[2])].sort()); // DM order follows random fingerprints
  });
});

describe('end-to-end encryption', () => {
  let groupEnv: Envelope;
  it('stores only ciphertext; every recipient decrypts', async () => {
    const r = await send(ids[0], 'group', { type: 'text', text: SECRET }, ids);
    expect(r.status).toBe(201);
    groupEnv = r.body.envelope;
    const raw = readFileSync(dataFile(), 'utf8');
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('safe-deposit');
    for (const i of ids) { expect(raw).not.toContain(i.signSecret); expect(raw).not.toContain(i.boxSecret); }
    const list = (await api().get(`/api/messaging/${walletId}/threads/group/messages`).set(auth(ids[1]))).body;
    const env = list.messages.at(-1).envelope as Envelope;
    for (const i of ids) expect(openMessage(N, env, i, ids[0].signPub)).toEqual({ type: 'text', text: SECRET });
  });

  it('a direct thread is unreadable for a third trustee', async () => {
    const t = dmThreadId(fps[0], fps[1]);
    const r = await send(ids[0], t, { type: 'text', text: 'just between us' }, [ids[0], ids[1]]);
    expect(r.status).toBe(201);
    expect((await api().get(`/api/messaging/${walletId}/threads/${t}/messages`).set(auth(ids[2]))).status).toBe(403);
    expect(() => openMessage(N, r.body.envelope, ids[2], ids[0].signPub)).toThrow(/not encrypted for you/);
    expect(openMessage(N, r.body.envelope, ids[1], ids[0].signPub)).toMatchObject({ text: 'just between us' });
  });

  it('server rejects forged senders, bad signatures and wrong recipient sets', async () => {
    const env = sealMessage(N, { me: ids[0], walletId, threadId: 'group', recipients: ids.map(pub), body: { type: 'text', text: 'x' } });
    // authenticated as Avery but claims to be Jordan
    expect((await api().post(`/api/messaging/${walletId}/threads/group/messages`).set(auth(ids[1])).send(env)).status).toBe(403);
    const flipped = { ...env, urgent: true };
    const r = await api().post(`/api/messaging/${walletId}/threads/group/messages`).set(auth(ids[0])).send(flipped);
    expect(r.status).toBe(422); expect(r.body.details.code).toBe('TAMPERED');
    const missing = await send(ids[0], 'group', { type: 'text', text: 'x' }, [ids[0], ids[1]]);
    expect(missing.status).toBe(409); expect(missing.body.details.code).toBe('RECIPIENTS');
  });

  it('detects tampering of stored ciphertext and metadata on the client', async () => {
    const d = JSON.parse(readFileSync(dataFile(), 'utf8'));
    const m = d.messages.find((x: any) => x.envelope.id === groupEnv.id);
    const ct = Buffer.from(m.envelope.ct, 'base64'); ct[3] ^= 1;
    m.envelope.ct = ct.toString('base64');
    writeFileSync(dataFile(), JSON.stringify(d)); msg.reload(walletId);
    const got = (await api().get(`/api/messaging/${walletId}/threads/group/messages`).set(auth(ids[1]))).body.messages.find((x: any) => x.envelope.id === groupEnv.id).envelope;
    expect(() => openMessage(N, got, ids[1], ids[0].signPub)).toThrow(TamperError);
    // an attacker without Jordan's Ed25519 key cannot re-sign; an envelope signed by another key is rejected
    const resigned = sealMessage(N, { me: newIdentity(N, fps[0]), walletId, threadId: 'group', recipients: ids.map(pub), body: { type: 'text', text: 'pay me' } });
    expect(() => openMessage(N, resigned, ids[1], ids[0].signPub)).toThrow(/Signature check failed/);
    // a wrapped key swapped from another message fails authentication
    const other = sealMessage(N, { me: ids[0], walletId, threadId: 'group', recipients: ids.map(pub), body: { type: 'text', text: 'y' } });
    expect(() => openMessage(N, { ...groupEnv, keys: other.keys }, ids[1], ids[0].signPub)).toThrow(TamperError);
    m.envelope = groupEnv; writeFileSync(dataFile(), JSON.stringify(d)); msg.reload(walletId);
  });

  it('offline queue retries are idempotent', async () => {
    const env = sealMessage(N, { me: ids[1], walletId, threadId: 'group', recipients: ids.map(pub), body: { type: 'text', text: 'queued while offline' } });
    const a = await api().post(`/api/messaging/${walletId}/threads/group/messages`).set(auth(ids[1])).send(env);
    const b = await api().post(`/api/messaging/${walletId}/threads/group/messages`).set(auth(ids[1])).send(env);
    expect(b.body.seq).toBe(a.body.seq);
    expect((await api().post(`/api/messaging/${walletId}/threads/group/messages`).set(auth(ids[1])).send({ ...env, ct: env.nonce })).status).toBe(409);
  });
});

describe('WebSocket delivery, offline catch-up and receipts', () => {
  it('pushes new ciphertext live and marks it delivered', async () => {
    const b = wsClient(ids[1]);
    await b.ready; await b.next((e) => e.type === 'ready');
    const a = wsClient(ids[0]);
    await a.ready; await a.next((e) => e.type === 'ready');
    const r = await send(ids[0], 'group', { type: 'text', text: 'live hello' }, ids);
    const ev = await b.next((e) => e.type === 'message' && e.message.envelope.id === r.body.envelope.id);
    expect(openMessage(N, ev.message.envelope, ids[1], ids[0].signPub)).toMatchObject({ text: 'live hello' });
    const del = await a.next((e) => e.type === 'delivered' && e.fingerprint === fps[1] && e.seqs.includes(r.body.seq));
    expect(del.threadId).toBe('group');
    // read receipt (signed) flows back to the sender
    const rc = signReceipt(N, ids[1], { walletId, threadId: 'group', upToSeq: r.body.seq, at: new Date().toISOString() });
    expect((await api().post(`/api/messaging/${walletId}/threads/group/read`).set(auth(ids[1])).send(rc)).status).toBe(200);
    const got = await a.next((e) => e.type === 'receipt' && e.receipt.fingerprint === fps[1]);
    expect(got.receipt.upToSeq).toBe(r.body.seq);
    const forged = { ...rc, upToSeq: rc.upToSeq + 100 };
    expect((await api().post(`/api/messaging/${walletId}/threads/group/read`).set(auth(ids[1])).send(forged)).status).toBe(422);
    const t = (await api().get(`/api/messaging/${walletId}/threads`).set(auth(ids[1]))).body.find((x: any) => x.id === 'group');
    expect(t.unread).toBe(0);
    a.ws.close(); b.ws.close();
  });

  it('queues messages for an offline trustee and flushes them on connect', async () => {
    const r = await send(ids[0], 'group', { type: 'text', text: 'for Counsel, offline' }, ids, true);
    const c = wsClient(ids[2]);
    await c.ready;
    const ev = await c.next((e) => e.type === 'message' && e.message.envelope.id === r.body.envelope.id);
    expect(ev.message.envelope.urgent).toBe(true);
    expect(openMessage(N, ev.message.envelope, ids[2], ids[0].signPub)).toMatchObject({ text: 'for Counsel, offline' });
    // HTTP catch-up with ?since also works
    const since = (await api().get(`/api/messaging/${walletId}/threads/group/messages?since=${r.body.seq - 1}`).set(auth(ids[2]))).body.messages;
    expect(since.map((m: any) => m.seq)).toEqual([r.body.seq]);
    c.ws.close();
  });

  it('rejects an unauthenticated WebSocket hello', async () => {
    const ws = new WebSocket(wsUrl);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ type: 'hello', walletId, token: authToken(N, walletId, newIdentity(N, fps[0])) }));
    const code = await new Promise((r) => ws.on('close', (c) => r(c)));
    expect(code).toBe(4401);
  });

  it('urgent messages raise an alert until every recipient has read them', async () => {
    const alerts = (await api().get('/api/messaging/alerts')).body.filter((a: any) => a.walletId === walletId);
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0]).toMatchObject({ walletName: 'Messaging Trust', senderLabel: 'Jordan', threadId: 'group' });
    const maxSeq = Math.max(...alerts.map((a: any) => a.seq));
    for (const me of [ids[1], ids[2]]) {
      await api().post(`/api/messaging/${walletId}/threads/group/read`).set(auth(me)).send(signReceipt(N, me, { walletId, threadId: 'group', upToSeq: maxSeq, at: new Date().toISOString() }));
    }
    expect((await api().get('/api/messaging/alerts')).body.filter((a: any) => a.walletId === walletId)).toEqual([]);
  });
});

describe('signature requests linked to a PSBT', () => {
  it('request → trustee signs 1/2 → second trustee signs 2/2 → broadcast, with live status', async () => {
    await api().post('/api/regtest/fund').send({ walletId, amount: 2 });
    const burn = await rpc.call<string>('getnewaddress', [], 'btctrust-faucet');
    const p = await api().post(`/api/wallets/${walletId}/psbt`).send({ outputs: [{ address: burn, amount: 0.25 }] });
    expect(p.body.signatures).toBe(0);
    const b = wsClient(ids[1]);
    await b.ready; await b.next((e) => e.type === 'ready');

    const cr = await api().post(`/api/messaging/${walletId}/sigrequests`).set(auth(ids[2])).send({ psbt: p.body.psbt, threadId: 'group' });
    expect(cr.status).toBe(201);
    const rid = cr.body.id;
    expect(cr.body).toMatchObject({ status: 'open', signatures: 0, required: 2, txid: p.body.txid, createdBy: fps[2] });
    expect(cr.body.requestedFrom.sort()).toEqual([fps[0], fps[1]].sort());
    // the encrypted chat card that links to it
    const card = await send(ids[2], 'group', { type: 'sigreq', requestId: rid, txid: p.body.txid, summary: '0.25 BTC to faucet', text: 'Please sign the distribution' }, ids);
    expect(card.status).toBe(201);
    expect((await b.next((e) => e.type === 'sigrequest' && e.request.id === rid)).request.status).toBe('open');
    expect((await api().post(`/api/messaging/${walletId}/sigrequests`).set(auth(ids[2])).send({ psbt: p.body.psbt })).status).toBe(409);

    const s1 = await api().post(`/api/messaging/${walletId}/sigrequests/${rid}/sign`).set(auth(ids[0]));
    expect(s1.status).toBe(200);
    expect(s1.body).toMatchObject({ signatures: 1, status: 'open', signedBy: [fps[0]] });
    expect((await api().post(`/api/messaging/${walletId}/sigrequests/${rid}/sign`).set(auth(ids[0]))).status).toBe(409);
    const s2 = await api().post(`/api/messaging/${walletId}/sigrequests/${rid}/sign`).set(auth(ids[1]));
    expect(s2.body).toMatchObject({ signatures: 2, required: 2, complete: true, status: 'ready' });
    expect((await b.next((e) => e.type === 'sigrequest' && e.request.signatures === 2)).request.status).toBe('ready');
    expect(s2.body.events.map((e: any) => e.action)).toEqual(['requested', 'signed', 'signed']);

    const bc = await api().post(`/api/messaging/${walletId}/sigrequests/${rid}/broadcast`).set(auth(ids[1]));
    expect(bc.body.status).toBe('broadcast');
    expect(bc.body.broadcastTxid).toBe(p.body.txid);
    expect((await rpc.call<string[]>('getrawmempool')).includes(p.body.txid)).toBe(true);
    b.ws.close();
  });

  it('import rejects a PSBT for another transaction; outsiders cannot see requests', async () => {
    const burn = await rpc.call<string>('getnewaddress', [], 'btctrust-faucet');
    const p1 = await api().post(`/api/wallets/${walletId}/psbt`).send({ outputs: [{ address: burn, amount: 0.1 }] });
    const p2 = await api().post(`/api/wallets/${walletId}/psbt`).send({ outputs: [{ address: burn, amount: 0.2 }] });
    const t = dmThreadId(fps[0], fps[1]);
    const rq = await api().post(`/api/messaging/${walletId}/sigrequests`).set(auth(ids[0])).send({ psbt: p1.body.psbt, threadId: t, requestedFrom: [fps[1]] });
    expect(rq.status).toBe(201);
    expect((await api().post(`/api/messaging/${walletId}/sigrequests/${rq.body.id}/import`).set(auth(ids[0])).send({ psbt: p2.body.psbt })).status).toBe(400);
    expect((await api().get(`/api/messaging/${walletId}/sigrequests/${rq.body.id}`).set(auth(ids[2]))).status).toBe(403);
    // an externally signed copy merges in
    const signed = await rpc.call<{ psbt: string }>('walletprocesspsbt', [p1.body.psbt, true, 'ALL', true, false], `btctrust-${walletId}-key2`);
    const im = await api().post(`/api/messaging/${walletId}/sigrequests/${rq.body.id}/import`).set(auth(ids[1])).send({ psbt: signed.psbt });
    expect(im.body).toMatchObject({ signatures: 1, signedBy: [fps[1]] });
  });
});

describe('key rotation', () => {
  it('re-attesting replaces the key; envelopes from the old key are refused', async () => {
    const old = ids[1];
    const fresh = newIdentity(N, fps[1]);
    const r = await enroll(1, fresh);
    expect(r.body.rotated).toBe(true);
    const stale = await send(old, 'group', { type: 'text', text: 'x' }, ids);
    expect(stale.status).toBe(401); // old key can no longer authenticate
    ids[1] = fresh;
    const toOld = sealMessage(N, { me: ids[0], walletId, threadId: 'group', recipients: [pub(ids[0]), pub(old), pub(ids[2])], body: { type: 'text', text: 'x' } });
    const rr = await api().post(`/api/messaging/${walletId}/threads/group/messages`).set(auth(ids[0])).send(toOld);
    expect(rr.status).toBe(409); expect(rr.body.details.code).toBe('STALE_KEY');
  });
});
