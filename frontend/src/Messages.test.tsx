import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessagesPage } from './pages/Messages'
import { UrgentBanner } from './components/UrgentBanner'
import { RequestSignature } from './components/RequestSignature'
import { N, keyring, outbox, type DirectoryEntry, type SigRequest, type StoredMessage } from './lib/messaging'
import { newIdentity, openMessage, sealMessage, type Envelope, type SecretIdentity } from '../../shared/msgcrypto'
import type { PsbtInfo, Wallet } from './lib/api'
import { keyStore } from './lib/keystore'
import { attest } from './test-btc'

const W = 'w1'
const A = newIdentity(N, 'aaaaaaaa')
const B = newIdentity(N, 'bbbbbbbb')
const wallet: Wallet = {
  id: W, name: 'Family Trust Vault', type: 'multisig', network: 'regtest', m: 2, n: 3, watchWallet: 'x', canSign: true, createdAt: '', descriptors: { receive: 'wsh(...)' },
  cosigners: [
    { label: 'Jordan', fingerprint: 'aaaaaaaa', key: 'k1', local: true, kind: 'software' },
    { label: 'Avery', fingerprint: 'bbbbbbbb', key: 'k2', local: true, kind: 'software' },
    { label: 'Paper', fingerprint: 'cccccccc', key: 'k3', local: false, kind: 'airgapped' },
  ],
}
const ident = (i: SecretIdentity, cosigner: number, label: string) => ({ fingerprint: i.fingerprint, signPub: i.signPub, boxPub: i.boxPub, cosigner, label, kind: 'software', ...attest(W, { fingerprint: i.fingerprint, label, signPub: i.signPub, boxPub: i.boxPub }, cosigner), btcPath: 'm/44h/1h/0h/0/0', attestedAt: '', safetyNumber: '12345 67890 11111 22222 33333 44444', verified: true as const })
const dir: DirectoryEntry[] = [
  { cosigner: 0, fingerprint: 'aaaaaaaa', label: 'Jordan', kind: 'software', identity: ident(A, 0, 'Jordan'), previousKeys: [] },
  { cosigner: 1, fingerprint: 'bbbbbbbb', label: 'Avery', kind: 'software', identity: ident(B, 1, 'Avery'), previousKeys: [] },
  { cosigner: 2, fingerprint: 'cccccccc', label: 'Paper', kind: 'airgapped', identity: null, previousKeys: [] },
]
const stored = (env: Envelope, seq: number, extra: Partial<StoredMessage> = {}): StoredMessage => ({ seq, receivedAt: env.createdAt, envelope: env, deliveredTo: {}, readBy: {}, ...extra })
const msgFrom = (me: SecretIdentity, text: string, urgent = false) => sealMessage(N, { me, walletId: W, threadId: 'group', recipients: [A, B], body: { type: 'text', text }, urgent })
const threads = [{ id: 'group', kind: 'group', members: ['aaaaaaaa', 'bbbbbbbb'], count: 2, unread: 1, urgentUnread: 0, last: null }, { id: 'dm:aaaaaaaa:bbbbbbbb', kind: 'direct', members: ['aaaaaaaa', 'bbbbbbbb'], count: 0, unread: 0, urgentUnread: 0, last: null }]

class FakeWS {
  static last: FakeWS | null = null
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  sent: string[] = []
  constructor() { FakeWS.last = this; setTimeout(() => this.onopen?.(), 0) }
  send(s: string) { this.sent.push(s) }
  close() { this.onclose?.() }
  push(e: unknown) { this.onmessage?.({ data: JSON.stringify(e) }) }
}

type H = (url: string, init?: RequestInit) => { status?: number; body: unknown } | 'network-error'
const stub = (h: H) => {
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const r = h(url, init)
    if (r === 'network-error') throw new TypeError('Failed to fetch')
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
  })
  vi.stubGlobal('fetch', f)
  return f
}
beforeEach(async () => { FakeWS.last = null; keyStore.lock(); localStorage.clear(); vi.stubGlobal('WebSocket', FakeWS); await keyStore.create('correct horse battery'); await keyring.put(W, A); await keyring.put(W, B); keyring.setActing(W, 'aaaaaaaa') })
afterEach(() => vi.unstubAllGlobals())

const base = (msgs: StoredMessage[], extra?: H): H => (url, init) => {
  const x = extra?.(url, init); if (x) return x
  if (url === '/api/wallets') return { body: [wallet] }
  if (url.endsWith('/directory')) return { body: dir }
  if (url.endsWith('/threads')) return { body: threads }
  if (url.includes('/messages?since')) return { body: { messages: msgs, receipts: [] } }
  if (url.endsWith('/sigrequests')) return { body: [] }
  if (url.endsWith('/read')) return { body: { marked: 1 } }
  return { status: 404, body: {} }
}

describe('Messages page', () => {
  it('decrypts the thread, shows verification badges, urgent flag and flags tampered messages', async () => {
    const good = msgFrom(B, 'Meet at the bank Friday', true)
    const bad = msgFrom(B, 'original text')
    const ct = Uint8Array.from(atob(bad.ct), (c) => c.charCodeAt(0)); ct[2] ^= 1
    const tampered = { ...bad, ct: btoa(String.fromCharCode(...ct)) }
    const f = stub(base([stored(good, 1), stored(tampered, 2)]))
    render(<MessagesPage walletId={W} />)
    await waitFor(() => expect(screen.getByText('Meet at the bank Friday')).toBeInTheDocument())
    expect(document.querySelector('.urgent-tag')).toHaveTextContent('Urgent')
    expect(screen.getByTestId('tampered')).toHaveTextContent(/altered/)
    expect(screen.getByTestId('verified-aaaaaaaa')).toHaveTextContent('✓ Verified')
    expect(screen.getByTestId('verified-bbbbbbbb')).toBeInTheDocument()
    expect(screen.getByText('Not enrolled')).toBeInTheDocument()
    // auth header + a signed read receipt for what is on screen
    await waitFor(() => expect(f.mock.calls.some(([u]) => String(u).endsWith('/read'))).toBe(true))
    const call = f.mock.calls.find(([u]) => String(u).endsWith('/threads'))!
    expect((call[1]?.headers as Record<string, string>)['x-trustee-auth']).toMatch(/^aaaaaaaa\.\d+\./)
  })

  it('compose encrypts for every member; the server only receives ciphertext', async () => {
    let posted: Envelope | null = null
    stub(base([], (url, init) => {
      if (url.endsWith('/threads/group/messages') && init?.method === 'POST') { posted = JSON.parse(String(init.body)); return { status: 201, body: stored(posted!, 3) } }
      return undefined as never
    }))
    render(<MessagesPage walletId={W} />)
    await waitFor(() => expect(screen.getByTestId('compose')).toBeInTheDocument())
    fireEvent.change(screen.getByTestId('compose'), { target: { value: 'Key ceremony is tomorrow' } })
    fireEvent.click(screen.getByTestId('urgent-toggle'))
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(posted).not.toBeNull())
    const env = posted! as Envelope
    expect(JSON.stringify(env)).not.toContain('Key ceremony')
    expect(Object.keys(env.keys).sort()).toEqual(['aaaaaaaa', 'bbbbbbbb'])
    expect(env.urgent).toBe(true)
    expect(openMessage(N, env, B, A.signPub)).toEqual({ type: 'text', text: 'Key ceremony is tomorrow' })
    await waitFor(() => expect(screen.getByText('Key ceremony is tomorrow')).toBeInTheDocument())
  })

  it('receives live messages over the WebSocket after an authenticated hello', async () => {
    stub(base([]))
    render(<MessagesPage walletId={W} />)
    await waitFor(() => expect(FakeWS.last?.sent.length).toBe(1))
    const hello = JSON.parse(FakeWS.last!.sent[0])
    expect(hello).toMatchObject({ type: 'hello', walletId: W })
    expect(hello.token).toMatch(/^aaaaaaaa\./)
    act(() => { FakeWS.last!.push({ type: 'ready', fingerprint: 'aaaaaaaa' }) })
    await waitFor(() => expect(screen.getByText('Live')).toBeInTheDocument())
    act(() => { FakeWS.last!.push({ type: 'message', threadId: 'group', message: stored(msgFrom(B, 'pushed live'), 9) }) })
    await waitFor(() => expect(screen.getByText('pushed live')).toBeInTheDocument())
  })

  it('queues messages while the node is unreachable and flushes them later', async () => {
    let up = false
    const posts: Envelope[] = []
    stub(base([], (url, init) => {
      if (url.endsWith('/threads/group/messages') && init?.method === 'POST') {
        if (!up) return 'network-error'
        posts.push(JSON.parse(String(init.body))); return { status: 201, body: stored(posts[0], 4) }
      }
      return undefined as never
    }))
    render(<MessagesPage walletId={W} />)
    await waitFor(() => expect(screen.getByTestId('compose')).toBeInTheDocument())
    fireEvent.change(screen.getByTestId('compose'), { target: { value: 'sent from the cabin' } })
    fireEvent.click(screen.getByTestId('send'))
    await waitFor(() => expect(screen.getByText(/1 message queued offline/)).toBeInTheDocument())
    expect(outbox.list()).toHaveLength(1)
    up = true
    expect(await outbox.flush(W, A)).toBe(1)
    expect(outbox.list()).toHaveLength(0)
    expect(openMessage(N, posts[0], B, A.signPub)).toMatchObject({ text: 'sent from the cabin' })
  })

  it('signature request card: sign as trustee → 2/2 ready → broadcast', async () => {
    const req: SigRequest = { id: 'r1', walletId: W, threadId: 'group', createdBy: 'bbbbbbbb', requestedFrom: ['aaaaaaaa'], createdAt: '2026-10-02T20:00:00Z', psbt: 'cHNidP8=', txid: 't'.repeat(64), required: 2, signatures: 1, signedBy: ['bbbbbbbb'], complete: false, fee: 0.0000028, outputs: [{ address: 'bcrt1qdest000000000000', amount: 0.5, isChange: false }], status: 'open', urgent: false, events: [{ at: '2026-10-02T20:00:00Z', action: 'requested', by: 'bbbbbbbb', signatures: 0 }, { at: '2026-10-02T20:00:05Z', action: 'signed', by: 'bbbbbbbb', signatures: 1 }] }
    const card = sealMessage(N, { me: B, walletId: W, threadId: 'group', recipients: [A, B], body: { type: 'sigreq', requestId: 'r1', txid: req.txid, summary: '0.5 BTC', text: 'Q4 distribution' } })
    const updates: Envelope[] = []
    stub(base([stored(card, 1)], (url, init) => {
      if (url.endsWith('/sigrequests')) return { body: [req] }
      if (url.endsWith('/sigrequests/r1/sign')) return { body: { ...req, signatures: 2, signedBy: ['bbbbbbbb', 'aaaaaaaa'], complete: true, status: 'ready', events: [...req.events, { at: '2026-10-02T20:01:00Z', action: 'signed', by: 'aaaaaaaa', signatures: 2 }] } }
      if (url.endsWith('/sigrequests/r1/broadcast')) return { body: { ...req, signatures: 2, complete: true, status: 'broadcast', broadcastTxid: req.txid } }
      if (url.endsWith('/threads/group/messages') && init?.method === 'POST') { const e = JSON.parse(String(init.body)); updates.push(e); return { status: 201, body: stored(e, 10 + updates.length) } }
      return undefined as never
    }))
    render(<MessagesPage walletId={W} />)
    await waitFor(() => expect(screen.getByTestId('sigreq-status')).toHaveTextContent('Awaiting signatures · 1/2'))
    expect(screen.getByText('“Q4 distribution”')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('sigreq-sign'))
    await waitFor(() => expect(screen.getByTestId('sigreq-status')).toHaveTextContent('Ready to broadcast · 2/2'))
    expect(openMessage(N, updates[0], B, A.signPub)).toMatchObject({ type: 'sigreq-update', requestId: 'r1', action: 'signed', signatures: 2 })
    fireEvent.click(screen.getByTestId('sigreq-broadcast'))
    await waitFor(() => expect(screen.getByTestId('sigreq-status')).toHaveTextContent('Broadcast'))
  })
})

describe('Request signature from the PSBT screen', () => {
  it('creates a linked request and sends an encrypted card to the chosen trustee', async () => {
    const psbt: PsbtInfo = { psbt: 'cHNidP8=', txid: 'f'.repeat(64), fee: 0.00000282, required: 2, signatures: 0, signedBy: [], complete: false, inputs: 1, outputs: [{ address: 'bcrt1qdest', amount: 1.25, isChange: false }] }
    let created: Record<string, unknown> | null = null
    let env: Envelope | null = null
    stub((url, init) => {
      if (url.endsWith('/directory')) return { body: dir }
      if (url.endsWith('/sigrequests')) { created = JSON.parse(String(init!.body)); return { status: 201, body: { id: 'r9', txid: psbt.txid } } }
      if (url.includes('/messages') && init?.method === 'POST') { env = JSON.parse(String(init.body)); return { status: 201, body: stored(env!, 1) } }
      return { status: 404, body: {} }
    })
    render(<RequestSignature wallet={wallet} psbt={psbt} onClose={() => {}} />)
    await waitFor(() => expect(screen.getByTestId('sigreq-send')).toBeEnabled())
    fireEvent.click(screen.getByTestId('sigreq-send'))
    await waitFor(() => expect(screen.getByTestId('sigreq-sent')).toBeInTheDocument())
    expect(created).toMatchObject({ psbt: 'cHNidP8=', requestedFrom: ['bbbbbbbb'], threadId: 'dm:aaaaaaaa:bbbbbbbb' })
    expect(openMessage(N, env!, B, A.signPub)).toMatchObject({ type: 'sigreq', requestId: 'r9', txid: psbt.txid })
  })
})

describe('Urgent banner', () => {
  it('escalates unread urgent messages app-wide', async () => {
    stub(() => ({ body: [{ walletId: W, walletName: 'Family Trust Vault', threadId: 'group', seq: 3, sender: 'bbbbbbbb', senderLabel: 'Avery', createdAt: new Date().toISOString(), unreadBy: ['aaaaaaaa', 'cccccccc'] }] }))
    render(<UrgentBanner path="/" />)
    await waitFor(() => expect(screen.getByTestId('urgent-banner')).toHaveTextContent('Urgent message from Avery'))
    expect(screen.getByTestId('urgent-banner')).toHaveTextContent('unread by 2 trustees')
  })
})
