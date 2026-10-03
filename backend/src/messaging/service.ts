import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import nacl from 'tweetnacl';
import { HttpError } from '../errors.js';
import type { WalletService } from '../wallets.js';
import type { IdentityKeys } from '../identity.js';
import {
  PROTOCOL, attestationStatement, authText, canonical, dmThreadId, parseAuthToken, receiptText, safetyNumber, unb64, verifyDetached, verifyEnvelope,
  type Envelope, type Nacl, type Receipt,
} from '../../../shared/msgcrypto.js';

const N = nacl as unknown as Nacl;
const AUTH_SKEW_MS = 5 * 60_000;
const ATTEST_MAX_AGE_MS = 15 * 60_000;
const MAX_ENVELOPE = 96 * 1024;
export const GROUP = 'group';

export interface Identity {
  fingerprint: string; cosigner: number; label: string; kind: string;
  signPub: string; boxPub: string; issuedAt: string; statement: string;
  btcAddress: string; btcPath: string; btcSignature: string; popSignature: string;
  attestedAt: string; safetyNumber: string;
}
export interface StoredMessage { seq: number; receivedAt: string; envelope: Envelope; deliveredTo: Record<string, string>; readBy: Record<string, string> }
export interface SigEvent { at: string; action: 'requested' | 'signed' | 'imported' | 'broadcast'; by: string; signatures: number; txid?: string }
export interface SigRequest {
  id: string; walletId: string; threadId: string; createdBy: string; requestedFrom: string[]; createdAt: string;
  psbt: string; txid: string; required: number; signatures: number; signedBy: string[]; complete: boolean;
  fee: number | null; outputs: { address: string; amount: number; isChange: boolean }[];
  status: 'open' | 'ready' | 'broadcast'; broadcastTxid?: string; urgent: boolean; events: SigEvent[];
}
interface Data { version: 1; seq: number; identities: Record<string, Identity>; retired: Identity[]; messages: StoredMessage[]; receipts: Receipt[]; sigRequests: SigRequest[] }

export type HubEvent =
  | { type: 'message'; walletId: string; threadId: string; to: string[]; message: StoredMessage }
  | { type: 'receipt'; walletId: string; threadId: string; to: string[]; receipt: Receipt; delivered?: never }
  | { type: 'delivered'; walletId: string; threadId: string; to: string[]; fingerprint: string; seqs: number[] }
  | { type: 'identity'; walletId: string; to: 'all'; identity: Identity }
  | { type: 'sigrequest'; walletId: string; to: string[]; request: SigRequest };

export class MessagingService {
  readonly hub = new EventEmitter();
  private cache = new Map<string, Data>();

  constructor(private wallets: WalletService, private ids: IdentityKeys, private opts: { dataDir: string }) {
    mkdirSync(this.dir, { recursive: true });
    this.hub.setMaxListeners(100);
  }

  private get dir() { return join(this.opts.dataDir, 'messaging'); }
  file(walletId: string) {
    if (!/^[a-z0-9-]{1,80}$/.test(walletId)) throw new HttpError(400, 'Invalid wallet id');
    return join(this.dir, `${walletId}.json`);
  }
  private load(walletId: string): Data {
    this.wallets.get(walletId);
    const f = this.file(walletId);
    const c = this.cache.get(walletId);
    if (c) return c;
    const d: Data = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : { version: 1, seq: 0, identities: {}, retired: [], messages: [], receipts: [], sigRequests: [] };
    this.cache.set(walletId, d);
    return d;
  }
  private save(walletId: string, d: Data) {
    const f = this.file(walletId);
    writeFileSync(`${f}.tmp`, JSON.stringify(d, null, 1));
    renameSync(`${f}.tmp`, f);
  }
  /** Drop the in-memory cache (used by tests that edit the file on disk). */
  reload(walletId: string) { this.cache.delete(walletId); }
  private emit(e: HubEvent) { this.hub.emit('event', e); }

  // ---------- identities ----------
  async directory(walletId: string) {
    const w = this.wallets.get(walletId);
    const d = this.load(walletId);
    return w.cosigners.map((c, i) => {
      const id = d.identities[c.fingerprint];
      const previousKeys = d.retired.filter((r) => r.fingerprint === c.fingerprint).map((r) => r.signPub);
      return { cosigner: i, fingerprint: c.fingerprint, label: c.label, kind: c.kind ?? (c.signerWallet ? 'software' : 'airgapped'), identity: id ? this.publicIdentity(id) : null, previousKeys };
    });
  }
  private publicIdentity(id: Identity) {
    return { ...id, verified: true as const };
  }

  /** Resolve the cosigner's Bitcoin identity key and the exact statement it must sign. */
  async prepareAttestation(walletId: string, body: { cosigner: number; signPub: string; boxPub: string; address?: string }) {
    const key = await this.ids.resolve(walletId, { cosigner: body.cosigner, address: body.address });
    this.checkKey(body.signPub, 32, 'signPub'); this.checkKey(body.boxPub, 32, 'boxPub');
    const issuedAt = new Date().toISOString();
    const statement = attestationStatement({ walletId, fingerprint: key.fingerprint, label: key.label, signPub: body.signPub, boxPub: body.boxPub, issuedAt });
    return { statement, issuedAt, address: key.address, path: key.path, kind: key.kind, fingerprint: key.fingerprint };
  }

  async signAttestation(walletId: string, body: { cosigner: number; statement: string }) {
    const key = await this.ids.resolve(walletId, { cosigner: body.cosigner });
    if (!String(body.statement ?? '').startsWith('BTC Trust trustee attestation v1\n') || !body.statement.includes(`cosigner: ${key.fingerprint} `)) {
      throw new HttpError(400, 'Not an attestation statement for this cosigner');
    }
    return this.ids.sign(walletId, key, body.statement);
  }

  async register(walletId: string, body: { cosigner: number; signPub: string; boxPub: string; issuedAt: string; btcSignature: string; popSignature: string; address?: string }) {
    const key = await this.ids.resolve(walletId, { cosigner: body.cosigner, address: body.address });
    this.checkKey(body.signPub, 32, 'signPub'); this.checkKey(body.boxPub, 32, 'boxPub');
    const age = Date.now() - Date.parse(body.issuedAt);
    if (!(age >= -60_000 && age <= ATTEST_MAX_AGE_MS)) throw new HttpError(400, 'Attestation is stale; prepare a new one');
    const statement = attestationStatement({ walletId, fingerprint: key.fingerprint, label: key.label, signPub: body.signPub, boxPub: body.boxPub, issuedAt: body.issuedAt });
    if (!(await this.ids.verify(key.address, body.btcSignature, statement))) {
      throw new HttpError(401, `Attestation signature is not valid for ${key.label}'s identity key ${key.address}`, { code: 'BAD_ATTESTATION' });
    }
    if (!verifyDetached(N, body.signPub, statement, body.popSignature)) {
      throw new HttpError(401, 'Proof of possession for the Ed25519 key failed', { code: 'BAD_POP' });
    }
    const d = this.load(walletId);
    const prev = d.identities[key.fingerprint];
    if (prev) d.retired.push(prev);
    const id: Identity = {
      fingerprint: key.fingerprint, cosigner: key.cosigner, label: key.label, kind: key.kind, signPub: body.signPub, boxPub: body.boxPub,
      issuedAt: body.issuedAt, statement, btcAddress: key.address, btcPath: key.path, btcSignature: String(body.btcSignature).trim(),
      popSignature: body.popSignature, attestedAt: new Date().toISOString(), safetyNumber: safetyNumber(N, body),
    };
    d.identities[key.fingerprint] = id;
    this.save(walletId, d);
    this.emit({ type: 'identity', walletId, to: 'all', identity: id });
    return { ...this.publicIdentity(id), rotated: !!prev };
  }

  private checkKey(k: unknown, len: number, name: string) {
    let ok = false;
    try { ok = typeof k === 'string' && unb64(k).length === len; } catch { ok = false; }
    if (!ok) throw new HttpError(400, `${name} must be a base64 ${len}-byte key`);
  }

  /** Validates an `x-trustee-auth` token (Ed25519 over wallet, fingerprint and timestamp) and returns the trustee. */
  auth(walletId: string, token: string | undefined): Identity {
    const t = parseAuthToken(String(token ?? ''));
    if (!t) throw new HttpError(401, 'Trustee authentication required', { code: 'TRUSTEE_AUTH' });
    if (Math.abs(Date.now() - t.ts) > AUTH_SKEW_MS) throw new HttpError(401, 'Trustee auth token expired', { code: 'TRUSTEE_AUTH' });
    const id = this.load(walletId).identities[t.fingerprint];
    if (!id || !verifyDetached(N, id.signPub, authText(walletId, t.fingerprint, t.ts), t.sig)) throw new HttpError(401, 'Trustee authentication failed', { code: 'TRUSTEE_AUTH' });
    return id;
  }

  // ---------- threads ----------
  private members(d: Data, threadId: string): string[] {
    if (threadId === GROUP) return Object.keys(d.identities).sort();
    const m = threadId.match(/^dm:([0-9a-f]{8}):([0-9a-f]{8})$/);
    if (!m || m[1] >= m[2] || dmThreadId(m[1], m[2]) !== threadId) throw new HttpError(400, 'Unknown thread');
    return [m[1], m[2]];
  }
  private canSee(d: Data, threadId: string, fp: string) {
    return threadId === GROUP ? !!d.identities[fp] : this.members(d, threadId).includes(fp);
  }

  threads(walletId: string, me: Identity) {
    const d = this.load(walletId);
    const fps = Object.keys(d.identities).filter((f) => f !== me.fingerprint);
    const ids = [GROUP, ...fps.map((f) => dmThreadId(me.fingerprint, f))];
    for (const m of d.messages) if (m.envelope.threadId !== GROUP && this.canSee(d, m.envelope.threadId, me.fingerprint) && !ids.includes(m.envelope.threadId)) ids.push(m.envelope.threadId);
    return ids.map((threadId) => {
      const msgs = d.messages.filter((m) => m.envelope.threadId === threadId);
      const unread = msgs.filter((m) => m.envelope.sender !== me.fingerprint && m.envelope.keys[me.fingerprint] && !m.readBy[me.fingerprint]);
      const last = msgs[msgs.length - 1];
      return {
        id: threadId, kind: threadId === GROUP ? 'group' : 'direct',
        members: threadId === GROUP ? Object.keys(d.identities) : this.members(d, threadId),
        count: msgs.length, unread: unread.length, urgentUnread: unread.filter((m) => m.envelope.urgent).length,
        last: last ? { seq: last.seq, sender: last.envelope.sender, createdAt: last.envelope.createdAt, urgent: last.envelope.urgent } : null,
      };
    }).sort((a, b) => (a.kind === 'group' ? -1 : b.kind === 'group' ? 1 : (b.last?.seq ?? 0) - (a.last?.seq ?? 0)));
  }

  post(walletId: string, me: Identity, env: Envelope) {
    const d = this.load(walletId);
    if (JSON.stringify(env ?? {}).length > MAX_ENVELOPE) throw new HttpError(413, 'Message too large');
    if (!env || env.protocol !== PROTOCOL || typeof env.id !== 'string' || !/^[0-9a-f]{32}$/.test(env.id)) throw new HttpError(400, 'Malformed envelope');
    const dup = d.messages.find((m) => m.envelope.id === env.id);
    if (dup) {
      // Idempotent retry from an offline queue: same id must be byte-identical.
      if (canonical(dup.envelope) !== canonical(env)) throw new HttpError(409, 'Message id already used');
      return dup;
    }
    if (env.walletId !== walletId) throw new HttpError(400, 'Envelope is for another wallet');
    if (env.sender !== me.fingerprint) throw new HttpError(403, 'Sender does not match the authenticated trustee');
    if (env.senderKey !== me.signPub || env.senderBox !== me.boxPub) throw new HttpError(409, 'Envelope uses an outdated identity key', { code: 'STALE_KEY' });
    if (!verifyEnvelope(N, env, me.signPub)) throw new HttpError(422, 'Envelope signature invalid', { code: 'TAMPERED' });
    const members = this.members(d, env.threadId);
    if (!members.includes(me.fingerprint)) throw new HttpError(403, 'Not a member of this thread');
    for (const f of members) if (!d.identities[f]) throw new HttpError(409, `Trustee ${f} has no messaging identity yet`);
    const want = members.slice().sort();
    const got = Object.keys(env.keys ?? {}).sort();
    if (canonical(want) !== canonical(got)) throw new HttpError(409, 'Recipients do not match the thread members', { code: 'RECIPIENTS', expected: want });
    for (const f of want) if (env.keys[f].pub !== d.identities[f].boxPub) throw new HttpError(409, `Encrypted to an outdated key for ${f}`, { code: 'STALE_KEY' });
    const skew = Date.parse(env.createdAt) - Date.now();
    if (!(skew < 5 * 60_000)) throw new HttpError(400, 'createdAt is in the future');
    const m: StoredMessage = { seq: ++d.seq, receivedAt: new Date().toISOString(), envelope: env, deliveredTo: { [me.fingerprint]: new Date().toISOString() }, readBy: { [me.fingerprint]: new Date().toISOString() } };
    d.messages.push(m);
    this.save(walletId, d);
    this.emit({ type: 'message', walletId, threadId: env.threadId, to: members, message: m });
    return m;
  }

  /** Messages after `since` (offline catch-up) and marks them delivered to the caller. */
  list(walletId: string, me: Identity, threadId: string, since = 0) {
    const d = this.load(walletId);
    if (!this.canSee(d, threadId, me.fingerprint)) throw new HttpError(403, 'Not a member of this thread');
    const msgs = d.messages.filter((m) => m.envelope.threadId === threadId && m.seq > since && m.envelope.keys[me.fingerprint] !== undefined);
    this.markDelivered(walletId, d, me.fingerprint, msgs);
    return { messages: msgs, receipts: d.receipts.filter((r) => r.threadId === threadId) };
  }

  markDelivered(walletId: string, d: Data | null, fp: string, msgs: StoredMessage[]) {
    d ??= this.load(walletId);
    const fresh = msgs.filter((m) => !m.deliveredTo[fp]);
    if (!fresh.length) return;
    const now = new Date().toISOString();
    for (const m of fresh) m.deliveredTo[fp] = now;
    this.save(walletId, d);
    const byThread = new Map<string, number[]>();
    for (const m of fresh) byThread.set(m.envelope.threadId, [...(byThread.get(m.envelope.threadId) ?? []), m.seq]);
    for (const [threadId, seqs] of byThread) this.emit({ type: 'delivered', walletId, threadId, to: this.members(d, threadId), fingerprint: fp, seqs });
  }

  /** Messages for `fp` not yet delivered (used when a WebSocket connects). */
  pending(walletId: string, fp: string) {
    const d = this.load(walletId);
    return d.messages.filter((m) => m.envelope.keys[fp] && !m.deliveredTo[fp]);
  }

  read(walletId: string, me: Identity, r: Receipt) {
    const d = this.load(walletId);
    if (r.walletId !== walletId || r.fingerprint !== me.fingerprint) throw new HttpError(400, 'Receipt is for another trustee');
    if (!this.canSee(d, r.threadId, me.fingerprint)) throw new HttpError(403, 'Not a member of this thread');
    if (!verifyDetached(N, me.signPub, receiptText(r), r.sig)) throw new HttpError(422, 'Receipt signature invalid', { code: 'TAMPERED' });
    let changed = 0;
    for (const m of d.messages) {
      if (m.envelope.threadId === r.threadId && m.seq <= r.upToSeq && m.envelope.keys[me.fingerprint] && !m.readBy[me.fingerprint]) { m.readBy[me.fingerprint] = r.at; m.deliveredTo[me.fingerprint] ??= r.at; changed++; }
    }
    d.receipts = d.receipts.filter((x) => !(x.threadId === r.threadId && x.fingerprint === r.fingerprint));
    d.receipts.push(r);
    this.save(walletId, d);
    this.emit({ type: 'receipt', walletId, threadId: r.threadId, to: this.members(d, r.threadId), receipt: r });
    return { marked: changed };
  }

  /** Urgent messages that some recipient has not read yet, across all wallets (metadata only). */
  alerts() {
    const out: { walletId: string; walletName: string; threadId: string; seq: number; sender: string; senderLabel: string; createdAt: string; unreadBy: string[] }[] = [];
    const ids = readdirSync(this.dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
    for (const id of ids) {
      let w: { id: string; name: string };
      try { w = this.wallets.get(id); } catch { continue; }
      const d = this.load(w.id);
      for (const m of d.messages) {
        if (!m.envelope.urgent) continue;
        const unreadBy = Object.keys(m.envelope.keys).filter((f) => !m.readBy[f]);
        if (unreadBy.length) out.push({ walletId: w.id, walletName: w.name, threadId: m.envelope.threadId, seq: m.seq, sender: m.envelope.sender, senderLabel: d.identities[m.envelope.sender]?.label ?? m.envelope.sender, createdAt: m.envelope.createdAt, unreadBy });
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ---------- signature requests (linked to a PSBT) ----------
  private sigRecord(d: Data, rid: string) {
    const r = d.sigRequests.find((x) => x.id === rid);
    if (!r) throw new HttpError(404, 'Signature request not found');
    return r;
  }
  private applyInfo(r: SigRequest, info: { psbt: string; required: number; signatures: number; signedBy: string[]; complete: boolean }) {
    r.psbt = info.psbt; r.required = info.required; r.signatures = info.signatures; r.signedBy = info.signedBy; r.complete = info.complete;
    if (r.status !== 'broadcast') r.status = info.complete ? 'ready' : 'open';
  }
  private notify(walletId: string, d: Data, r: SigRequest) {
    this.save(walletId, d);
    this.emit({ type: 'sigrequest', walletId, to: this.members(d, r.threadId), request: r });
    return r;
  }

  async createSigRequest(walletId: string, me: Identity, body: { psbt: string; threadId?: string; requestedFrom?: string[]; urgent?: boolean }) {
    const d = this.load(walletId);
    const threadId = body.threadId ?? GROUP;
    if (!this.canSee(d, threadId, me.fingerprint)) throw new HttpError(403, 'Not a member of this thread');
    const info = await this.wallets.decode(walletId, String(body.psbt ?? ''));
    if (info.complete) throw new HttpError(409, 'PSBT already has enough signatures');
    const w = this.wallets.get(walletId);
    const fps = w.cosigners.map((c) => c.fingerprint);
    const requestedFrom = (body.requestedFrom?.length ? body.requestedFrom : fps.filter((f) => f !== me.fingerprint && !info.signedBy.includes(f)));
    for (const f of requestedFrom) if (!fps.includes(f)) throw new HttpError(400, `${f} is not a cosigner of this wallet`);
    const existing = d.sigRequests.find((x) => x.txid === info.txid && x.status !== 'broadcast');
    if (existing) throw new HttpError(409, 'A signature request for this transaction is already open', { requestId: existing.id });
    const r: SigRequest = {
      id: randomBytes(8).toString('hex'), walletId, threadId, createdBy: me.fingerprint, requestedFrom, createdAt: new Date().toISOString(),
      psbt: info.psbt, txid: info.txid, required: info.required, signatures: info.signatures, signedBy: info.signedBy, complete: info.complete,
      fee: info.fee, outputs: info.outputs, status: 'open', urgent: !!body.urgent,
      events: [{ at: new Date().toISOString(), action: 'requested', by: me.fingerprint, signatures: info.signatures }],
    };
    d.sigRequests.push(r);
    return this.notify(walletId, d, r);
  }

  sigRequests(walletId: string, me: Identity) {
    const d = this.load(walletId);
    return d.sigRequests.filter((r) => this.canSee(d, r.threadId, me.fingerprint));
  }
  sigRequest(walletId: string, me: Identity, rid: string) {
    const d = this.load(walletId);
    const r = this.sigRecord(d, rid);
    if (!this.canSee(d, r.threadId, me.fingerprint)) throw new HttpError(403, 'Not a member of this thread');
    return r;
  }

  /** The authenticated trustee signs with their own cosigner key (node-held software key or their connected hardware wallet). */
  async signSigRequest(walletId: string, me: Identity, rid: string) {
    const d = this.load(walletId);
    const r = this.sigRequest(walletId, me, rid);
    if (r.status === 'broadcast') throw new HttpError(409, 'Already broadcast');
    if (r.signedBy.includes(me.fingerprint)) throw new HttpError(409, 'You already signed this request');
    const idx = this.wallets.get(walletId).cosigners.findIndex((c) => c.fingerprint === me.fingerprint);
    const res = await this.wallets.sign(walletId, r.psbt, { cosigner: idx, fallback: false });
    this.applyInfo(r, res);
    r.events.push({ at: new Date().toISOString(), action: 'signed', by: me.fingerprint, signatures: r.signatures });
    return this.notify(walletId, d, r);
  }

  /** Merge a PSBT signed elsewhere (air-gapped device, Sparrow…). Must be the same transaction. */
  async importSigned(walletId: string, me: Identity, rid: string, psbt: string) {
    const d = this.load(walletId);
    const r = this.sigRequest(walletId, me, rid);
    const incoming = await this.wallets.decode(walletId, String(psbt ?? ''));
    if (incoming.txid !== r.txid) throw new HttpError(400, 'PSBT is for a different transaction');
    const before = r.signatures;
    this.applyInfo(r, await this.wallets.combine(walletId, [r.psbt, incoming.psbt]));
    r.events.push({ at: new Date().toISOString(), action: 'imported', by: me.fingerprint, signatures: r.signatures });
    if (r.signatures === before) throw new HttpError(409, 'Imported PSBT adds no new signatures');
    return this.notify(walletId, d, r);
  }

  async broadcastSigRequest(walletId: string, me: Identity, rid: string) {
    const d = this.load(walletId);
    const r = this.sigRequest(walletId, me, rid);
    if (r.status === 'broadcast') throw new HttpError(409, 'Already broadcast');
    const { txid } = await this.wallets.broadcast(walletId, r.psbt);
    r.status = 'broadcast'; r.broadcastTxid = txid;
    r.events.push({ at: new Date().toISOString(), action: 'broadcast', by: me.fingerprint, signatures: r.signatures, txid });
    return this.notify(walletId, d, r);
  }
}
