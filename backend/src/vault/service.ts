import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { BitcoinRpc } from '../rpc.js';
import { IdentityKeys } from '../identity.js';
import { HttpError } from '../errors.js';
import type { WalletService } from '../wallets.js';
import { assertNoPrivateKeys, kindOf } from '../wallets.js';
import type { DeviceService } from '../devices.js';
import { FAUCET_WALLET, type Faucet } from '../faucet.js';
import { IntegrityError, deriveKey, newDataKey, newKdfParams, open, openBytes, seal, sealBytes, sha256, type Box, type KdfParams } from './crypto.js';
import { DOC_TYPES, buildTemplate, type DocType } from './templates.js';

export interface SecondFactor { cosigner: number; label: string; kind: string; fingerprint: string; address: string; path: string }
interface VaultFile {
  format: 'btctrust-vault'; version: 1; walletId: string; createdAt: string; updatedAt: string;
  kdf: KdfParams; wrappedKey: Box; secondFactor: SecondFactor | null; index: Box; attachments: string[];
}
export interface Anchor { txid: string; hash: string; anchoredAt: string }
export interface Version { v: number; createdAt: string; content: string; sha256: string; size: number; anchor?: Anchor }
export interface Attachment { id: string; name: string; mime: string; size: number; sha256: string; createdAt: string }
export interface Doc { id: string; type: DocType; title: string; createdAt: string; updatedAt: string; versions: Version[]; attachments: Attachment[] }
interface Index { documents: Doc[] }
interface Session { token: string; walletId: string; dek: Buffer; index: Index; lastSeen: number }
interface Pending { id: string; walletId: string; dek: Buffer; index: Index; message: string; expires: number; attempts: number }

export const OP_RETURN_PREFIX = '42545631'; // "BTV1"
const MIN_PASSPHRASE = 10;
const MAX_ATTACHMENT = 10 * 1024 * 1024;
const MIME_MAGIC: Record<string, (b: Buffer) => boolean> = {
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'image/png': (b) => b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
  'image/jpeg': (b) => b.subarray(0, 3).toString('hex') === 'ffd8ff',
  'image/gif': (b) => b.subarray(0, 4).toString('latin1') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};

const sfHash = (sf: SecondFactor | null) => sha256(JSON.stringify(sf));
const aadKey = (w: string) => `btctrust-vault:v1:dek:${w}`;
const aadIndex = (w: string, sf: SecondFactor | null) => `btctrust-vault:v1:index:${w}:${sfHash(sf)}`;
const aadAtt = (w: string, id: string) => `btctrust-vault:v1:att:${w}:${id}`;
const newId = () => randomBytes(8).toString('hex');

export class VaultService {
  private sessions = new Map<string, Session>();
  private pending = new Map<string, Pending>();
  private ids: IdentityKeys;
  private failures = new Map<string, { count: number; until: number }>();

  constructor(
    private rpc: BitcoinRpc,
    private wallets: WalletService,
    private devices: DeviceService | undefined,
    private faucet: Faucet,
    private opts: { dataDir: string; network: string; idleMs: number; kdfN: number },
  ) {
    this.ids = new IdentityKeys(rpc, wallets, devices, opts.network);
    mkdirSync(this.dir, { recursive: true });
    setInterval(() => this.sweep(), 15_000).unref();
  }

  get idleMs() { return this.opts.idleMs; }
  private get dir() { return join(this.opts.dataDir, 'vaults'); }
  private file(w: string) { return join(this.dir, `${w}.vault.json`); }
  private attDir(w: string) { return join(this.dir, w); }
  private attFile(w: string, id: string) { return join(this.attDir(w), `${id}.bin`); }
  private safeId(id: string) { if (!/^[a-z0-9-]{1,80}$/.test(id)) throw new HttpError(400, 'Invalid id'); return id; }

  private read(walletId: string): VaultFile {
    const f = this.file(this.safeId(walletId));
    if (!existsSync(f)) throw new HttpError(404, 'No vault for this wallet');
    return JSON.parse(readFileSync(f, 'utf8')) as VaultFile;
  }
  private write(v: VaultFile) {
    v.updatedAt = new Date().toISOString();
    const f = this.file(v.walletId);
    writeFileSync(`${f}.tmp`, JSON.stringify(v, null, 2));
    renameSync(`${f}.tmp`, f);
  }

  private sweep() {
    const now = Date.now();
    for (const [t, s] of this.sessions) if (now - s.lastSeen > this.opts.idleMs) { s.dek.fill(0); this.sessions.delete(t); }
    for (const [id, p] of this.pending) if (now > p.expires) this.pending.delete(id);
  }

  // ---------- status / create ----------
  status(walletId: string, token?: string) {
    this.wallets.get(walletId);
    const exists = existsSync(this.file(this.safeId(walletId)));
    const s = token ? this.sessions.get(token) : undefined;
    const unlocked = !!s && s.walletId === walletId && Date.now() - s.lastSeen <= this.opts.idleMs;
    if (!exists) return { exists, unlocked: false, secondFactor: null, idleMs: this.opts.idleMs };
    const v = this.read(walletId);
    return {
      exists, unlocked, idleMs: this.opts.idleMs, createdAt: v.createdAt, updatedAt: v.updatedAt,
      kdf: { name: v.kdf.name, N: v.kdf.N, r: v.kdf.r, p: v.kdf.p }, cipher: 'AES-256-GCM',
      secondFactor: v.secondFactor && { cosigner: v.secondFactor.cosigner, label: v.secondFactor.label, kind: v.secondFactor.kind, address: v.secondFactor.address },
      ...(unlocked ? { expiresInMs: this.opts.idleMs - (Date.now() - s!.lastSeen) } : {}),
    };
  }

  private checkPassphrase(p: unknown): string {
    if (typeof p !== 'string' || p.normalize('NFKC').length < MIN_PASSPHRASE) throw new HttpError(400, `Passphrase must be at least ${MIN_PASSPHRASE} characters`);
    return p;
  }

  /** Resolve the signmessage identity key (BIP44 m/44h/coin'/0'/0/0, same seed / master fingerprint) of a cosigner. */
  async resolveSecondFactor(walletId: string, spec: { cosigner?: number; address?: string }): Promise<SecondFactor> {
    return this.ids.resolve(walletId, spec);
  }

  async create(walletId: string, body: { passphrase?: string; secondFactor?: { cosigner?: number; address?: string } | null }) {
    this.wallets.get(walletId);
    if (existsSync(this.file(this.safeId(walletId)))) throw new HttpError(409, 'Vault already exists');
    const pass = this.checkPassphrase(body.passphrase);
    const sf = body.secondFactor ? await this.resolveSecondFactor(walletId, body.secondFactor) : null;
    const kdf = newKdfParams(this.opts.kdfN);
    const kek = await deriveKey(pass, kdf);
    const dek = newDataKey();
    const now = new Date().toISOString();
    const index: Index = { documents: [] };
    const v: VaultFile = {
      format: 'btctrust-vault', version: 1, walletId, createdAt: now, updatedAt: now, kdf,
      wrappedKey: seal(kek, dek, aadKey(walletId)), secondFactor: sf,
      index: seal(dek, Buffer.from(JSON.stringify(index)), aadIndex(walletId, sf)), attachments: [],
    };
    kek.fill(0);
    this.write(v);
    return this.newSession(walletId, dek, index);
  }

  // ---------- unlock ----------
  private newSession(walletId: string, dek: Buffer, index: Index) {
    const token = randomBytes(32).toString('hex');
    this.sessions.set(token, { token, walletId, dek, index, lastSeen: Date.now() });
    return { unlocked: true as const, session: token, idleMs: this.opts.idleMs };
  }

  private async openVault(walletId: string, passphrase: string) {
    const f = this.failures.get(walletId);
    if (f && Date.now() < f.until) throw new HttpError(429, `Too many failed attempts; try again in ${Math.ceil((f.until - Date.now()) / 1000)}s`);
    const v = this.read(walletId);
    const kek = await deriveKey(String(passphrase ?? ''), v.kdf);
    let dek: Buffer;
    try {
      dek = open(kek, v.wrappedKey, aadKey(walletId));
    } catch {
      const count = (f?.count ?? 0) + 1;
      this.failures.set(walletId, { count, until: count >= 5 ? Date.now() + Math.min(300_000, 2 ** (count - 5) * 15_000) : 0 });
      throw new HttpError(401, 'Wrong passphrase', { code: 'WRONG_PASSPHRASE' });
    } finally {
      kek.fill(0);
    }
    this.failures.delete(walletId);
    let index: Index;
    try {
      index = JSON.parse(open(dek, v.index, aadIndex(walletId, v.secondFactor)).toString('utf8'));
    } catch (e) {
      if (e instanceof IntegrityError) throw new HttpError(422, 'Vault integrity check failed: the encrypted index or its settings were modified', { code: 'TAMPERED' });
      throw e;
    }
    return { v, dek, index };
  }

  async unlock(walletId: string, passphrase: string) {
    const { v, dek, index } = await this.openVault(walletId, passphrase);
    if (!v.secondFactor) return this.newSession(walletId, dek, index);
    const id = randomBytes(16).toString('hex');
    const expires = Date.now() + 5 * 60_000;
    const message = `BTC Trust vault unlock\nwallet: ${walletId}\nnonce: ${id}\nexpires: ${new Date(expires).toISOString()}`;
    this.pending.set(id, { id, walletId, dek, index, message, expires, attempts: 0 });
    const sf = v.secondFactor;
    return { unlocked: false as const, challenge: { id, message, address: sf.address, cosigner: sf.cosigner, label: sf.label, kind: sf.kind, path: sf.path, expiresAt: new Date(expires).toISOString() } };
  }

  private getPending(walletId: string, id: string) {
    const p = this.pending.get(String(id));
    if (!p || p.walletId !== walletId || Date.now() > p.expires) throw new HttpError(401, 'Challenge expired or unknown; unlock again');
    return p;
  }

  /** Convenience: have a key on this node (software cosigner) or a connected hardware wallet sign the challenge. */
  async signChallenge(walletId: string, id: string) {
    const p = this.getPending(walletId, id);
    return this.ids.sign(walletId, this.read(walletId).secondFactor!, p.message);
  }

  async verifyChallenge(walletId: string, id: string, signature: string) {
    const p = this.getPending(walletId, id);
    const sf = this.read(walletId).secondFactor!;
    if (!(await this.ids.verify(sf.address, signature, p.message))) {
      if (++p.attempts >= 3) this.pending.delete(id);
      throw new HttpError(401, 'Signature does not prove control of the second-factor key', { code: 'BAD_SIGNATURE' });
    }
    this.pending.delete(id);
    return this.newSession(walletId, p.dek, p.index);
  }

  lock(token: string) {
    const s = this.sessions.get(token);
    if (s) { s.dek.fill(0); this.sessions.delete(token); }
    return { unlocked: false };
  }

  /** Validates the session for this wallet and refreshes the idle timer. */
  session(walletId: string, token: string | undefined): Session {
    const s = token ? this.sessions.get(token) : undefined;
    if (!s || s.walletId !== walletId) throw new HttpError(401, 'Vault is locked', { code: 'VAULT_LOCKED' });
    if (Date.now() - s.lastSeen > this.opts.idleMs) { this.lock(s.token); throw new HttpError(401, 'Vault auto-locked after inactivity', { code: 'VAULT_LOCKED' }); }
    s.lastSeen = Date.now();
    return s;
  }

  private persistIndex(s: Session) {
    const v = this.read(s.walletId);
    v.index = seal(s.dek, Buffer.from(JSON.stringify(s.index)), aadIndex(s.walletId, v.secondFactor));
    v.attachments = s.index.documents.flatMap((d) => d.attachments.map((a) => a.id));
    this.write(v);
    for (const o of this.sessions.values()) if (o !== s && o.walletId === s.walletId) o.index = s.index;
  }

  // ---------- documents ----------
  private doc(s: Session, docId: string) {
    const d = s.index.documents.find((x) => x.id === docId);
    if (!d) throw new HttpError(404, 'Document not found');
    return d;
  }
  private summary(d: Doc) {
    const last = d.versions.at(-1)!;
    return { id: d.id, type: d.type, title: d.title, createdAt: d.createdAt, updatedAt: d.updatedAt, versions: d.versions.length, latest: { v: last.v, sha256: last.sha256, size: last.size, anchored: !!last.anchor }, attachments: d.attachments.length };
  }
  private checkContent(type: DocType, content: unknown): string {
    if (typeof content !== 'string') throw new HttpError(400, 'content must be a string');
    if (Buffer.byteLength(content) > 1024 * 1024) throw new HttpError(413, 'Document too large (1 MB max)');
    assertNoPrivateKeys(content, 'vault documents');
    if (type === 'beneficiaries' || type === 'trustees') {
      try { if (!Array.isArray(JSON.parse(content))) throw new Error(); } catch { throw new HttpError(400, `${type} content must be a JSON array`); }
    }
    return content;
  }

  list(s: Session) { return s.index.documents.map((d) => this.summary(d)); }

  get(s: Session, docId: string) {
    const d = this.doc(s, docId);
    return { ...d, versions: d.versions.map((v) => ({ ...v, verified: sha256(v.content) === v.sha256 })) };
  }

  createDoc(s: Session, body: { type?: string; title?: string; content?: string }) {
    const type = body.type as DocType;
    if (!DOC_TYPES.includes(type)) throw new HttpError(400, `type must be one of ${DOC_TYPES.join(', ')}`);
    const content = this.checkContent(type, body.content ?? '');
    const title = String(body.title ?? '').trim() || type;
    const now = new Date().toISOString();
    const d: Doc = { id: newId(), type, title: title.slice(0, 120), createdAt: now, updatedAt: now, attachments: [],
      versions: [{ v: 1, createdAt: now, content, sha256: sha256(content), size: Buffer.byteLength(content) }] };
    s.index.documents.push(d);
    this.persistIndex(s);
    return this.get(s, d.id);
  }

  updateDoc(s: Session, docId: string, body: { title?: string; content?: string }) {
    const d = this.doc(s, docId);
    if (body.title !== undefined) d.title = String(body.title).trim().slice(0, 120) || d.title;
    if (body.content !== undefined) {
      const content = this.checkContent(d.type, body.content);
      const last = d.versions.at(-1)!;
      if (content !== last.content) {
        d.versions.push({ v: last.v + 1, createdAt: new Date().toISOString(), content, sha256: sha256(content), size: Buffer.byteLength(content) });
      }
    }
    d.updatedAt = new Date().toISOString();
    this.persistIndex(s);
    return this.get(s, d.id);
  }

  deleteDoc(s: Session, docId: string) {
    const d = this.doc(s, docId);
    s.index.documents = s.index.documents.filter((x) => x !== d);
    for (const a of d.attachments) rmSync(this.attFile(s.walletId, a.id), { force: true });
    this.persistIndex(s);
    return { deleted: docId };
  }

  template(walletId: string, type: string) {
    if (!DOC_TYPES.includes(type as DocType)) throw new HttpError(400, 'Unknown template type');
    const w = this.wallets.publicConfig(this.wallets.get(walletId));
    return { type, ...buildTemplate(type as DocType, w) };
  }

  // ---------- attachments ----------
  addAttachment(s: Session, docId: string, name: string, mime: string, data: Buffer) {
    const d = this.doc(s, docId);
    if (!Buffer.isBuffer(data) || !data.length) throw new HttpError(400, 'Empty upload');
    if (data.length > MAX_ATTACHMENT) throw new HttpError(413, 'Attachment too large (10 MB max)');
    const check = MIME_MAGIC[mime];
    if (!check) throw new HttpError(415, `Unsupported type ${mime}; allowed: ${Object.keys(MIME_MAGIC).join(', ')}`);
    if (!check(data)) throw new HttpError(415, `File content does not match ${mime}`);
    const id = newId();
    mkdirSync(this.attDir(s.walletId), { recursive: true });
    writeFileSync(this.attFile(s.walletId, id), sealBytes(s.dek, data, aadAtt(s.walletId, id)));
    const att: Attachment = { id, name: (name || 'file').replace(/[^\w.\- ()]/g, '_').slice(0, 100), mime, size: data.length, sha256: sha256(data), createdAt: new Date().toISOString() };
    d.attachments.push(att);
    d.updatedAt = att.createdAt;
    this.persistIndex(s);
    return att;
  }

  getAttachment(s: Session, docId: string, attId: string) {
    const a = this.doc(s, docId).attachments.find((x) => x.id === attId);
    if (!a) throw new HttpError(404, 'Attachment not found');
    let data: Buffer;
    try {
      data = openBytes(s.dek, readFileSync(this.attFile(s.walletId, a.id)), aadAtt(s.walletId, a.id));
    } catch {
      throw new HttpError(422, 'Attachment failed integrity check', { code: 'TAMPERED' });
    }
    if (sha256(data) !== a.sha256) throw new HttpError(422, 'Attachment hash mismatch', { code: 'TAMPERED' });
    return { meta: a, data };
  }

  // ---------- integrity & anchoring ----------
  verifyVersion(s: Session, docId: string, v: number) {
    const ver = this.doc(s, docId).versions.find((x) => x.v === v);
    if (!ver) throw new HttpError(404, 'Version not found');
    const actual = sha256(ver.content);
    return { v, sha256: ver.sha256, recomputed: actual, valid: actual === ver.sha256 };
  }

  async anchor(s: Session, docId: string, v: number, confirm = true) {
    if (this.opts.network !== 'regtest') throw new HttpError(403, 'Anchoring is only enabled on regtest');
    const d = this.doc(s, docId);
    const ver = d.versions.find((x) => x.v === v);
    if (!ver) throw new HttpError(404, 'Version not found');
    if (ver.anchor) throw new HttpError(409, 'This version is already anchored');
    if (sha256(ver.content) !== ver.sha256) throw new HttpError(422, 'Version hash mismatch; refusing to anchor');
    await this.faucet.address(); // ensures faucet wallet exists
    if ((await this.faucet.balance()) < 0.001) await this.faucet.mine(101);
    const raw = await this.rpc.call<string>('createrawtransaction', [[], [{ data: OP_RETURN_PREFIX + ver.sha256 }]]);
    const funded = await this.rpc.call<{ hex: string }>('fundrawtransaction', [raw, { fee_rate: 2 }], FAUCET_WALLET);
    const signed = await this.rpc.call<{ hex: string; complete: boolean }>('signrawtransactionwithwallet', [funded.hex], FAUCET_WALLET);
    const txid = await this.rpc.call<string>('sendrawtransaction', [signed.hex]);
    if (confirm) await this.faucet.mine(1);
    ver.anchor = { txid, hash: ver.sha256, anchoredAt: new Date().toISOString() };
    this.persistIndex(s);
    return this.verifyAnchor(s, docId, v);
  }

  async verifyAnchor(s: Session, docId: string, v: number) {
    const ver = this.doc(s, docId).versions.find((x) => x.v === v);
    if (!ver?.anchor) throw new HttpError(404, 'Version is not anchored');
    const tx = await this.rpc.call<{ vout: { scriptPubKey: { hex: string; type: string } }[]; confirmations?: number; blockhash?: string; blocktime?: number }>('getrawtransaction', [ver.anchor.txid, true]);
    const expected = `6a24${OP_RETURN_PREFIX}${ver.sha256}`;
    const onChain = tx.vout.some((o) => o.scriptPubKey.type === 'nulldata' && o.scriptPubKey.hex === expected);
    const contentOk = sha256(ver.content) === ver.sha256;
    let height: number | null = null;
    if (tx.blockhash) height = (await this.rpc.call<{ height: number }>('getblockheader', [tx.blockhash])).height;
    return {
      v, txid: ver.anchor.txid, hash: ver.sha256, opReturn: expected.slice(4), onChain, contentOk, valid: onChain && contentOk,
      confirmations: tx.confirmations ?? 0, blockHash: tx.blockhash ?? null, height, blockTime: tx.blocktime ?? null, anchoredAt: ver.anchor.anchoredAt,
    };
  }

  // ---------- passphrase / second factor / backup ----------
  /** Re-encrypts everything: new salt, new KEK, new random DEK, all attachments re-sealed. */
  async changePassphrase(s: Session, current: string, next: string) {
    const nextPass = this.checkPassphrase(next);
    const { v, dek } = await this.openVault(s.walletId, current);
    dek.fill(0);
    await this.reencrypt(s, v, nextPass, v.secondFactor);
    return { changed: true };
  }

  async setSecondFactor(s: Session, passphrase: string, spec: { cosigner?: number; address?: string } | null) {
    const { v, dek } = await this.openVault(s.walletId, passphrase);
    dek.fill(0);
    const sf = spec ? await this.resolveSecondFactor(s.walletId, spec) : null;
    await this.reencrypt(s, v, passphrase, sf);
    return this.status(s.walletId, s.token);
  }

  private async reencrypt(s: Session, v: VaultFile, pass: string, sf: SecondFactor | null) {
    const kdf = newKdfParams(this.opts.kdfN);
    const kek = await deriveKey(pass, kdf);
    const newDek = newDataKey();
    const atts = s.index.documents.flatMap((d) => d.attachments);
    const staged: [string, Buffer][] = atts.map((a) => {
      const plain = openBytes(s.dek, readFileSync(this.attFile(s.walletId, a.id)), aadAtt(s.walletId, a.id));
      return [this.attFile(s.walletId, a.id), sealBytes(newDek, plain, aadAtt(s.walletId, a.id))];
    });
    for (const [f, data] of staged) writeFileSync(`${f}.tmp`, data);
    const nv: VaultFile = { ...v, kdf, secondFactor: sf, wrappedKey: seal(kek, newDek, aadKey(s.walletId)),
      index: seal(newDek, Buffer.from(JSON.stringify(s.index)), aadIndex(s.walletId, sf)) };
    kek.fill(0);
    for (const [f] of staged) renameSync(`${f}.tmp`, f);
    this.write(nv);
    // Other sessions hold the old key: end them.
    for (const o of [...this.sessions.values()]) if (o.walletId === s.walletId && o !== s) this.lock(o.token);
    s.dek.fill(0);
    s.dek = newDek;
  }

  exportBackup(s: Session) {
    const v = this.read(s.walletId);
    const attachments: Record<string, string> = {};
    for (const id of v.attachments) attachments[id] = readFileSync(this.attFile(s.walletId, id)).toString('base64');
    return { format: 'btctrust-vault-backup', version: 1, exportedAt: new Date().toISOString(), walletId: s.walletId, vault: v, attachments,
      note: 'Encrypted with the vault passphrase (scrypt + AES-256-GCM). Contains no private keys.' };
  }

  async restoreBackup(walletId: string, body: { backup?: any; passphrase?: string; overwrite?: boolean }) {
    this.wallets.get(walletId);
    const b = body.backup;
    if (!b || b.format !== 'btctrust-vault-backup' || b.version !== 1 || !b.vault) throw new HttpError(400, 'Not a BTC Trust vault backup');
    if (b.vault.walletId !== walletId) throw new HttpError(400, `Backup belongs to wallet ${b.vault.walletId}`);
    if (existsSync(this.file(walletId)) && !body.overwrite) throw new HttpError(409, 'A vault already exists for this wallet (set overwrite)');
    const v = b.vault as VaultFile;
    // Verify the passphrase and every ciphertext BEFORE writing anything.
    const kek = await deriveKey(String(body.passphrase ?? ''), v.kdf);
    let dek: Buffer;
    try { dek = open(kek, v.wrappedKey, aadKey(walletId)); } catch { throw new HttpError(401, 'Wrong passphrase for this backup', { code: 'WRONG_PASSPHRASE' }); } finally { kek.fill(0); }
    let index: Index;
    try { index = JSON.parse(open(dek, v.index, aadIndex(walletId, v.secondFactor)).toString('utf8')); } catch { throw new HttpError(422, 'Backup failed integrity check', { code: 'TAMPERED' }); }
    for (const id of v.attachments) {
      const data = b.attachments?.[id];
      if (typeof data !== 'string') throw new HttpError(422, `Backup is missing attachment ${id}`);
      try { openBytes(dek, Buffer.from(data, 'base64'), aadAtt(walletId, id)); } catch { throw new HttpError(422, 'Backup attachment failed integrity check', { code: 'TAMPERED' }); }
    }
    for (const o of [...this.sessions.values()]) if (o.walletId === walletId) this.lock(o.token);
    rmSync(this.attDir(walletId), { recursive: true, force: true });
    mkdirSync(this.attDir(walletId), { recursive: true });
    for (const id of v.attachments) writeFileSync(this.attFile(walletId, this.safeId(id)), Buffer.from(b.attachments[id], 'base64'));
    this.write({ ...v });
    return { restored: true, documents: index.documents.length, attachments: v.attachments.length, ...(await Promise.resolve(this.newSession(walletId, dek, index))) };
  }

  /** For tests/diagnostics: raw on-disk files. */
  rawFiles(walletId: string) {
    const out: string[] = [this.file(walletId)];
    if (existsSync(this.attDir(walletId))) out.push(...readdirSync(this.attDir(walletId)).map((f) => join(this.attDir(walletId), f)));
    return out;
  }
}
