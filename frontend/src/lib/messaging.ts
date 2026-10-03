import nacl from 'tweetnacl'
import { ApiError, type PsbtInfo } from './api'
import {
  authToken, dmThreadId, newIdentity, openMessage, sealMessage, signDetached, signReceipt, TamperError,
  type Body, type Envelope, type Nacl, type PublicIdentity, type Receipt, type SecretIdentity,
} from '../../../shared/msgcrypto'

export const N = nacl as unknown as Nacl
export { dmThreadId, TamperError }
export type { Body, Envelope, SecretIdentity, Receipt }

export interface Identity extends PublicIdentity {
  cosigner: number; label: string; kind: string; issuedAt: string; statement: string; btcAddress: string; btcPath: string
  btcSignature: string; attestedAt: string; safetyNumber: string; verified: true
}
export interface DirectoryEntry { cosigner: number; fingerprint: string; label: string; kind: string; identity: Identity | null; previousKeys: string[] }
export interface Thread {
  id: string; kind: 'group' | 'direct'; members: string[]; count: number; unread: number; urgentUnread: number
  last: { seq: number; sender: string; createdAt: string; urgent: boolean } | null
}
export interface StoredMessage { seq: number; receivedAt: string; envelope: Envelope; deliveredTo: Record<string, string>; readBy: Record<string, string> }
export interface SigEvent { at: string; action: 'requested' | 'signed' | 'imported' | 'broadcast'; by: string; signatures: number; txid?: string }
export interface SigRequest {
  id: string; walletId: string; threadId: string; createdBy: string; requestedFrom: string[]; createdAt: string; psbt: string; txid: string
  required: number; signatures: number; signedBy: string[]; complete: boolean; fee: number | null; outputs: PsbtInfo['outputs']
  status: 'open' | 'ready' | 'broadcast'; broadcastTxid?: string; urgent: boolean; events: SigEvent[]
}
export interface Alert { walletId: string; walletName: string; threadId: string; seq: number; sender: string; senderLabel: string; createdAt: string; unreadBy: string[] }

// ---------------- keyring (this device) ----------------
// Secret keys never leave the browser. Each trustee would normally hold only their own key on their own device;
// this demo keyring can hold several so one browser can act as different trustees.
const KEYRING = 'btctrust-trustee-keys-v1'
const ACTING = 'btctrust-acting-v1'
type Ring = Record<string, Record<string, { current: SecretIdentity; previous: SecretIdentity[] }>>
const readRing = (): Ring => { try { return JSON.parse(localStorage.getItem(KEYRING) ?? '{}') } catch { return {} } }
export const keyring = {
  all: (walletId: string) => Object.values(readRing()[walletId] ?? {}).map((e) => e.current),
  get: (walletId: string, fp: string) => readRing()[walletId]?.[fp]?.current,
  candidates: (walletId: string, fp: string) => { const e = readRing()[walletId]?.[fp]; return e ? [e.current, ...e.previous] : [] },
  put: (walletId: string, id: SecretIdentity) => {
    const r = readRing(); r[walletId] ??= {}
    const prev = r[walletId][id.fingerprint]
    r[walletId][id.fingerprint] = { current: id, previous: prev ? [prev.current, ...prev.previous].filter((p) => p.signPub !== id.signPub) : [] }
    localStorage.setItem(KEYRING, JSON.stringify(r))
  },
  acting: (walletId: string): string | undefined => { try { return JSON.parse(localStorage.getItem(ACTING) ?? '{}')[walletId] } catch { return undefined } },
  setActing: (walletId: string, fp: string) => {
    let a: Record<string, string> = {}
    try { a = JSON.parse(localStorage.getItem(ACTING) ?? '{}') } catch { a = {} }
    a[walletId] = fp; localStorage.setItem(ACTING, JSON.stringify(a))
  },
}

// ---------------- HTTP ----------------
async function call<T>(path: string, init: RequestInit & { json?: unknown; me?: { walletId: string; id: SecretIdentity } } = {}): Promise<T> {
  const headers: Record<string, string> = {}
  if (init.me) headers['x-trustee-auth'] = authToken(N, init.me.walletId, init.me.id)
  if (init.json !== undefined) headers['content-type'] = 'application/json'
  const r = await fetch(`/api/messaging${path}`, { method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'), headers, body: init.json !== undefined ? JSON.stringify(init.json) : undefined })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(data.error ?? `HTTP ${r.status}`, r.status, data.details)
  return data as T
}

export const msgApi = {
  alerts: () => call<Alert[]>('/alerts'),
  directory: (w: string) => call<DirectoryEntry[]>(`/${w}/directory`),
  prepare: (w: string, cosigner: number, id: SecretIdentity, address?: string) =>
    call<{ statement: string; issuedAt: string; address: string; path: string; kind: string; fingerprint: string }>(`/${w}/identities/prepare`, { json: { cosigner, signPub: id.signPub, boxPub: id.boxPub, address } }),
  signAttestation: (w: string, cosigner: number, statement: string) => call<{ signature: string; signer: 'node' | 'device' }>(`/${w}/identities/sign`, { json: { cosigner, statement } }),
  register: (w: string, body: Record<string, unknown>) => call<Identity & { rotated: boolean }>(`/${w}/identities`, { json: body }),
  threads: (w: string, me: SecretIdentity) => call<Thread[]>(`/${w}/threads`, { me: { walletId: w, id: me } }),
  messages: (w: string, me: SecretIdentity, threadId: string, since = 0) =>
    call<{ messages: StoredMessage[]; receipts: Receipt[] }>(`/${w}/threads/${encodeURIComponent(threadId)}/messages?since=${since}`, { me: { walletId: w, id: me } }),
  post: (w: string, me: SecretIdentity, env: Envelope) => call<StoredMessage>(`/${w}/threads/${encodeURIComponent(env.threadId)}/messages`, { json: env, me: { walletId: w, id: me } }),
  read: (w: string, me: SecretIdentity, threadId: string, upToSeq: number) =>
    call<{ marked: number }>(`/${w}/threads/${encodeURIComponent(threadId)}/read`, { json: signReceipt(N, me, { walletId: w, threadId, upToSeq, at: new Date().toISOString() }), me: { walletId: w, id: me } }),
  sigRequests: (w: string, me: SecretIdentity) => call<SigRequest[]>(`/${w}/sigrequests`, { me: { walletId: w, id: me } }),
  createSigRequest: (w: string, me: SecretIdentity, body: { psbt: string; threadId: string; requestedFrom: string[]; urgent: boolean }) =>
    call<SigRequest>(`/${w}/sigrequests`, { json: body, me: { walletId: w, id: me } }),
  signSigRequest: (w: string, me: SecretIdentity, rid: string) => call<SigRequest>(`/${w}/sigrequests/${rid}/sign`, { json: {}, me: { walletId: w, id: me } }),
  importSigned: (w: string, me: SecretIdentity, rid: string, psbt: string) => call<SigRequest>(`/${w}/sigrequests/${rid}/import`, { json: { psbt }, me: { walletId: w, id: me } }),
  broadcast: (w: string, me: SecretIdentity, rid: string) => call<SigRequest>(`/${w}/sigrequests/${rid}/broadcast`, { json: {}, me: { walletId: w, id: me } }),
}

/** Create keys in the browser, have the cosigner's Bitcoin key sign the binding, and register the public half. */
export async function enrollTrustee(walletId: string, cosigner: number, fingerprint: string, signature?: (statement: string, address: string) => Promise<string>, address?: string) {
  const id = newIdentity(N, fingerprint)
  const prep = await msgApi.prepare(walletId, cosigner, id, address)
  const btcSignature = signature ? await signature(prep.statement, prep.address) : (await msgApi.signAttestation(walletId, cosigner, prep.statement)).signature
  const reg = await msgApi.register(walletId, { cosigner, signPub: id.signPub, boxPub: id.boxPub, issuedAt: prep.issuedAt, btcSignature, popSignature: signDetached(N, id, prep.statement), address })
  keyring.put(walletId, id)
  return reg
}

// ---------------- encryption helpers ----------------
export type Decrypted = { ok: true; body: Body } | { ok: false; error: string }
export function decrypt(walletId: string, me: SecretIdentity, m: StoredMessage, dir: DirectoryEntry[]): Decrypted {
  const sender = dir.find((d) => d.fingerprint === m.envelope.sender)
  const trusted = [sender?.identity?.signPub, ...(sender?.previousKeys ?? [])].filter(Boolean) as string[]
  if (!trusted.includes(m.envelope.senderKey)) return { ok: false, error: 'Unknown sender key: not attested for this cosigner' }
  const mine = keyring.candidates(walletId, me.fingerprint).find((k) => m.envelope.keys[me.fingerprint]?.pub === k.boxPub) ?? me
  try { return { ok: true, body: openMessage(N, m.envelope, mine, m.envelope.senderKey) } } catch (e) { return { ok: false, error: (e as Error).message } }
}
export function seal(walletId: string, me: SecretIdentity, threadId: string, recipients: Identity[], body: Body, urgent = false) {
  return sealMessage(N, { me, walletId, threadId, recipients, body, urgent })
}

// ---------------- offline outbox ----------------
const OUTBOX = 'btctrust-outbox-v1'
interface Queued { walletId: string; fingerprint: string; env: Envelope; queuedAt: string }
export const outbox = {
  list: (): Queued[] => { try { return JSON.parse(localStorage.getItem(OUTBOX) ?? '[]') } catch { return [] } },
  save: (q: Queued[]) => localStorage.setItem(OUTBOX, JSON.stringify(q)),
  add(q: Queued) { this.save([...this.list().filter((x) => x.env.id !== q.env.id), q]) },
  forWallet(walletId: string, fp: string) { return this.list().filter((q) => q.walletId === walletId && q.fingerprint === fp) },
  /** Retry queued envelopes (idempotent on the server: same id → same message). */
  async flush(walletId: string, me: SecretIdentity) {
    let sent = 0
    for (const q of this.forWallet(walletId, me.fingerprint)) {
      try { await msgApi.post(walletId, me, q.env); sent++; this.save(this.list().filter((x) => x.env.id !== q.env.id)) } catch (e) {
        if (e instanceof ApiError && e.status < 500) this.save(this.list().filter((x) => x.env.id !== q.env.id)) // permanently rejected
        else break
      }
    }
    return sent
  },
}
/** POST now, or queue when the server is unreachable. */
export async function sendEnvelope(walletId: string, me: SecretIdentity, env: Envelope): Promise<{ queued: boolean; message?: StoredMessage }> {
  try { return { queued: false, message: await msgApi.post(walletId, me, env) } } catch (e) {
    if (e instanceof ApiError && e.status < 500) throw e
    outbox.add({ walletId, fingerprint: me.fingerprint, env, queuedAt: new Date().toISOString() })
    return { queued: true }
  }
}

// ---------------- WebSocket ----------------
export type LiveEvent =
  | { type: 'ready'; fingerprint: string }
  | { type: 'message'; threadId: string; message: StoredMessage }
  | { type: 'receipt'; threadId: string; receipt: Receipt }
  | { type: 'delivered'; threadId: string; fingerprint: string; seqs: number[] }
  | { type: 'identity'; identity: Identity }
  | { type: 'sigrequest'; request: SigRequest }

export class LiveChannel {
  private ws: WebSocket | null = null
  private closed = false
  private retry = 500
  private walletId: string
  private me: SecretIdentity
  private onEvent: (e: LiveEvent) => void
  private onStatus: (s: 'connecting' | 'live' | 'offline') => void
  constructor(walletId: string, me: SecretIdentity, onEvent: (e: LiveEvent) => void, onStatus: (s: 'connecting' | 'live' | 'offline') => void) {
    this.walletId = walletId; this.me = me; this.onEvent = onEvent; this.onStatus = onStatus
    this.connect()
  }
  private connect() {
    if (this.closed || typeof WebSocket === 'undefined') return
    this.onStatus('connecting')
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/api/ws`)
    this.ws = ws
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', walletId: this.walletId, token: authToken(N, this.walletId, this.me) }))
    ws.onmessage = (ev) => {
      let e: LiveEvent
      try { e = JSON.parse(String(ev.data)) } catch { return }
      if (e.type === 'ready') { this.retry = 500; this.onStatus('live'); outbox.flush(this.walletId, this.me).catch(() => {}) }
      this.onEvent(e)
    }
    ws.onclose = () => {
      this.onStatus('offline')
      if (!this.closed) { setTimeout(() => this.connect(), this.retry); this.retry = Math.min(this.retry * 2, 15000) }
    }
  }
  close() { this.closed = true; this.ws?.close() }
}

export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
