import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { walletApi, walletKind, type Wallet } from '../lib/api'
import { navigate } from '../lib/router'
import {
  LiveChannel, checkDirectory, decrypt, dmThreadId, keyring, msgApi, outbox, seal, sendEnvelope, timeOf,
  type Body, type Decrypted, type DirectoryEntry, type Identity, type LiveEvent, type SecretIdentity, type SigRequest, type StoredMessage, type Thread,
} from '../lib/messaging'
import { vaultApi, vaultSession, type Attachment } from '../lib/vault'
import { KindBadge } from '../components/KindBadge'
import { Modal } from '../components/Modal'
import { SigRequestCard } from '../components/SigRequestCard'
import { TrusteeSetup } from '../components/TrusteeSetup'

/** #/messages — choose the trust whose trustee channel to open. */
export function MessagesIndex() {
  const [rows, setRows] = useState<{ w: Wallet; dir: DirectoryEntry[] }[] | null>(null)
  useEffect(() => {
    walletApi.list().then(async (ws) => {
      const multi = ws.filter((w) => w.cosigners.length > 1)
      const dirs = await Promise.all(multi.map((w) => msgApi.directory(w.id).catch(() => [] as DirectoryEntry[])))
      setRows(multi.map((w, i) => ({ w, dir: dirs[i] })))
    }).catch(() => setRows([]))
  }, [])
  return (
    <main className="page">
      <div className="page-head"><div>
        <h2 className="page-title">Trustee Messages</h2>
        <p className="muted">Private, end-to-end encrypted channel between the key holders of each trust: signature requests, emergencies and succession.</p>
      </div></div>
      {!rows ? <div className="glass card skeleton">Loading…</div> : (
        <div className="wallet-grid">
          {rows.map(({ w, dir }) => {
            const n = dir.filter((d) => d.identity).length
            return (
              <button key={w.id} className="glass card wallet-card vault-pick" onClick={() => navigate(`/messages/${w.id}`)}>
                <div className="wc-head"><span className={`kind kind-${w.type}`}>{walletKind(w)}</span><span className={`vault-chip ${n ? 'on' : ''}`}>{n}/{dir.length} trustees verified</span></div>
                <div className="wc-name">{w.name}</div>
                <div className="wc-keys">{dir.map((d) => <span key={d.fingerprint} className={`trustee-dot ${d.identity ? 'ok' : ''}`} title={d.label}>{d.label.slice(0, 1)}</span>)}</div>
              </button>
            )
          })}
          {rows.length === 0 && <div className="glass card empty"><div className="empty-icon">💬</div><p>Trustee messaging needs a multisig wallet.</p></div>}
        </div>
      )}
    </main>
  )
}

const threadName = (t: Thread, me: string, dir: DirectoryEntry[]) => t.kind === 'group' ? 'All trustees' : dir.find((d) => d.fingerprint === t.members.find((m) => m !== me))?.label ?? 'Direct'

export function MessagesPage({ walletId, initialThread }: { walletId: string; initialThread?: string }) {
  const [wallet, setWallet] = useState<Wallet | null>(null)
  const [dir, setDir] = useState<DirectoryEntry[] | null>(null)
  const [acting, setActing] = useState<string | undefined>(() => keyring.acting(walletId) ?? keyring.all(walletId)[0]?.fingerprint)
  const [threads, setThreads] = useState<Thread[]>([])
  const [active, setActive] = useState(initialThread ?? 'group')
  const [messages, setMessages] = useState<StoredMessage[]>([])
  const [requests, setRequests] = useState<Record<string, SigRequest>>({})
  const [live, setLive] = useState<'connecting' | 'live' | 'offline'>('connecting')
  const [setup, setSetup] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const me = acting ? keyring.get(walletId, acting) : undefined
  const activeRef = useRef(active); activeRef.current = active

  const loadDir = useCallback(() => msgApi.directory(walletId).then((d) => setDir(checkDirectory(walletId, d))).catch((e) => setError(e.message)), [walletId])
  useEffect(() => {
    walletApi.list().then((ws) => setWallet(ws.find((w) => w.id === walletId) ?? null)).catch((e) => setError(e.message))
    loadDir()
  }, [walletId, loadDir])

  const registered = !!(me && dir?.find((d) => d.fingerprint === me.fingerprint)?.identity?.signPub === me.signPub)
  const refreshThreads = useCallback(() => { if (me && registered) msgApi.threads(walletId, me).then(setThreads).catch((e) => setError(e.message)) }, [walletId, me, registered])

  useEffect(() => {
    if (!me || !registered) return
    refreshThreads()
    msgApi.sigRequests(walletId, me).then((rs) => setRequests(Object.fromEntries(rs.map((r) => [r.id, r])))).catch(() => {})
    const ch = new LiveChannel(walletId, me, (e: LiveEvent) => {
      if (e.type === 'message') {
        if (e.threadId === activeRef.current) setMessages((ms) => ms.some((m) => m.seq === e.message.seq) ? ms : [...ms, e.message].sort((a, b) => a.seq - b.seq))
        refreshThreads()
      } else if (e.type === 'sigrequest') setRequests((r) => ({ ...r, [e.request.id]: e.request }))
      else if (e.type === 'receipt') setMessages((ms) => ms.map((m) => m.seq <= e.receipt.upToSeq && !m.readBy[e.receipt.fingerprint] ? { ...m, readBy: { ...m.readBy, [e.receipt.fingerprint]: e.receipt.at } } : m))
      else if (e.type === 'delivered') setMessages((ms) => ms.map((m) => e.seqs.includes(m.seq) ? { ...m, deliveredTo: { ...m.deliveredTo, [e.fingerprint]: new Date().toISOString() } } : m))
      else if (e.type === 'identity') loadDir()
    }, setLive)
    const online = () => outbox.flush(walletId, me).then(refreshThreads).catch(() => {})
    window.addEventListener('online', online)
    return () => { ch.close(); window.removeEventListener('online', online) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletId, me?.signPub, registered])

  useEffect(() => {
    if (!me || !registered) return
    setMessages([])
    msgApi.messages(walletId, me, active).then((r) => setMessages(r.messages)).catch((e) => setError(e.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletId, me?.signPub, registered, active])

  // read receipts for what is on screen
  const maxSeq = messages.length ? messages[messages.length - 1].seq : 0
  useEffect(() => {
    if (!me || !maxSeq) return
    const unread = messages.some((m) => m.envelope.sender !== me.fingerprint && !m.readBy[me.fingerprint])
    if (unread && document.visibilityState !== 'hidden') msgApi.read(walletId, me, active, maxSeq).then(refreshThreads).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxSeq, active, me?.signPub])

  if (error && !dir) return <main className="page"><div className="glass alert" role="alert">⚠ {error}</div></main>
  if (!dir || !wallet) return <main className="page"><div className="glass card skeleton">Loading trustees…</div></main>

  const mine = keyring.all(walletId)
  const members = dir.filter((d) => d.identity).map((d) => d.identity!) as Identity[]
  const switchTo = (fp: string) => { keyring.setActing(walletId, fp); setActing(fp); setActive('group') }

  if (!me || !registered || setup) {
    return (
      <main className="page">
        <button className="back" onClick={() => navigate('/messages')}>← All trusts</button>
        <section className="glass card setup-card">
          <div className="card-title"><h2>Join the trustee channel · {wallet.name}</h2>{me && registered && <button className="btn small ghost" onClick={() => setSetup(false)}>Back to messages</button>}</div>
          <TrusteeSetup wallet={wallet} dir={dir} onDone={(fp) => { setSetup(false); loadDir().then(() => switchTo(fp)) }} />
        </section>
      </main>
    )
  }

  const thread = threads.find((t) => t.id === active)
  const peers = dir.filter((d) => d.identity && d.fingerprint !== me.fingerprint)
  return (
    <main className="page">
      <button className="back" onClick={() => navigate('/messages')}>← All trusts</button>
      <section className="msg-layout">
        <aside className="glass card msg-side">
          <div className="acting">
            <span className="field-label">Acting as</span>
            <div className="seg">
              {mine.map((k) => { const d = dir.find((x) => x.fingerprint === k.fingerprint); return d ? <button key={k.fingerprint} className={k.fingerprint === me.fingerprint ? 'active' : ''} onClick={() => switchTo(k.fingerprint)} data-testid={`act-${k.fingerprint}`}>{d.label}</button> : null })}
              <button className="add" onClick={() => setSetup(true)} title="Enroll another trustee on this device">＋</button>
            </div>
          </div>
          <div className="thread-list" role="list">
            {threads.map((t) => (
              <button key={t.id} role="listitem" className={`thread ${t.id === active ? 'active' : ''} ${t.urgentUnread ? 'urgent' : ''}`} onClick={() => setActive(t.id)} data-testid={`thread-${t.id}`}>
                <span className={`thread-avatar ${t.kind}`}>{t.kind === 'group' ? '👥' : threadName(t, me.fingerprint, dir).slice(0, 1)}</span>
                <span className="thread-body"><strong>{threadName(t, me.fingerprint, dir)}</strong><span className="muted small">{t.last ? `${dir.find((d) => d.fingerprint === t.last!.sender)?.label ?? ''} · ${timeOf(t.last.createdAt)}` : 'No messages yet'}</span></span>
                {t.urgentUnread > 0 ? <span className="unread urgent">!</span> : t.unread > 0 ? <span className="unread">{t.unread}</span> : null}
              </button>
            ))}
            {peers.length === 0 && <p className="hint">Only you are enrolled. Other trustees appear once they attest their keys.</p>}
          </div>
          <div className="directory">
            <span className="field-label">Trustees</span>
            {dir.map((d) => (
              <div key={d.fingerprint} className="dir-row" title={d.identity ? `Safety number ${d.identity.safetyNumber}\nAttested by ${d.identity.btcAddress} (${d.identity.btcPath})` : 'Not enrolled'}>
                <span className="avatar sm">{d.label.slice(0, 1)}</span>
                <span className="dir-name">{d.label}<KindBadge kind={d.kind as 'software'} /></span>
                {d.identity ? <span className="verified-badge" data-testid={`verified-${d.fingerprint}`} title="Server verifymessage ✓ · re-verified in this browser (BIP-137 signature + statement)">✓ Verified<i className="vb-local">browser ✓</i></span>
                  : d.rejected ? <span className="unverified bad" data-testid={`rejected-${d.fingerprint}`} title={d.browserCheck && !d.browserCheck.ok ? d.browserCheck.reason : ''}>⚠ Browser check failed</span>
                  : <span className="unverified">Not enrolled</span>}
                {d.identity && <code className="safety">{d.identity.safetyNumber.split(' ').slice(0, 3).join(' ')}…</code>}
                {d.identity && d.fingerprint !== me.fingerprint && <button className="link small" onClick={() => setActive(dmThreadId(me.fingerprint, d.fingerprint))}>Message</button>}
              </div>
            ))}
          </div>
        </aside>
        <ChatView key={`${me.signPub}:${active}`} walletId={walletId} me={me} dir={dir} members={active === 'group' ? members : members.filter((m) => active.includes(m.fingerprint))}
          threadId={active} title={thread ? threadName(thread, me.fingerprint, dir) : 'All trustees'} messages={messages} requests={requests} live={live}
          onSent={(m) => { if (m) setMessages((ms) => ms.some((x) => x.seq === m.seq) ? ms : [...ms, m]); refreshThreads() }}
          onRequest={(r) => setRequests((x) => ({ ...x, [r.id]: r }))} />
      </section>
    </main>
  )
}

function Ticks({ m, me }: { m: StoredMessage; me: string }) {
  const others = Object.keys(m.envelope.keys).filter((f) => f !== me)
  const read = others.filter((f) => m.readBy[f]).length
  const delivered = others.filter((f) => m.deliveredTo[f]).length
  const cls = others.length && read === others.length ? 'read' : delivered === others.length && others.length ? 'delivered' : 'sent'
  return <span className={`ticks ${cls}`} title={`Delivered ${delivered}/${others.length} · read ${read}/${others.length}`} data-testid="ticks">{cls === 'sent' ? '✓' : '✓✓'}{read > 0 && read < others.length && <em>{read}</em>}</span>
}

function ChatView({ walletId, me, dir, members, threadId, title, messages, requests, live, onSent, onRequest }: {
  walletId: string; me: SecretIdentity; dir: DirectoryEntry[]; members: Identity[]; threadId: string; title: string
  messages: StoredMessage[]; requests: Record<string, SigRequest>; live: string; onSent: (m?: StoredMessage) => void; onRequest: (r: SigRequest) => void
}) {
  const [text, setText] = useState('')
  const [urgent, setUrgent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [queued, setQueued] = useState(() => outbox.forWallet(walletId, me.fingerprint).filter((q) => q.env.threadId === threadId).length)
  const [attach, setAttach] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  const decrypted = useMemo(() => new Map<number, Decrypted>(messages.map((m) => [m.seq, decrypt(walletId, me, m, dir)])), [messages, walletId, me, dir])
  useEffect(() => { end.current?.scrollIntoView?.({ block: 'end' }) }, [messages.length])
  const label = (fp: string) => dir.find((d) => d.fingerprint === fp)?.label ?? fp

  const send = async (body: Body, isUrgent = urgent) => {
    setBusy(true); setError(null)
    try {
      const r = await sendEnvelope(walletId, me, seal(walletId, me, threadId, members, body, isUrgent))
      if (r.queued) setQueued(outbox.forWallet(walletId, me.fingerprint).filter((q) => q.env.threadId === threadId).length)
      setText(''); setUrgent(false); onSent(r.message)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const submit = (e?: React.FormEvent) => { e?.preventDefault(); if (text.trim()) send({ type: 'text', text: text.trim() }) }

  return (
    <section className="glass card chat" data-testid="chat">
      <header className="chat-head">
        <div><h2>{title}</h2><span className="muted small">{members.length} member{members.length === 1 ? '' : 's'} · end-to-end encrypted (X25519 · XSalsa20-Poly1305 · Ed25519)</span></div>
        <span className={`live-pill ${live}`}><i />{live === 'live' ? 'Live' : live === 'connecting' ? 'Connecting…' : 'Offline, queuing'}</span>
      </header>
      <div className="chat-scroll">
        {messages.length === 0 && <div className="empty small muted">No messages yet. Say hello, or request a signature from the Send screen.</div>}
        {messages.map((m) => {
          const d = decrypted.get(m.seq)!
          const mineMsg = m.envelope.sender === me.fingerprint
          if (d.ok && d.body.type === 'sigreq-update') {
            return <div key={m.seq} className="sys-line">✍ {label(m.envelope.sender)}: {d.body.text ?? `${d.body.action}${d.body.signatures !== undefined ? ` · ${d.body.signatures}/${d.body.required}` : ''}`} <span>{timeOf(m.envelope.createdAt)}</span></div>
          }
          return (
            <div key={m.seq} className={`bubble-row ${mineMsg ? 'mine' : ''}`} data-testid="message">
              {!mineMsg && <span className="avatar sm">{label(m.envelope.sender).slice(0, 1)}</span>}
              <div className={`bubble ${m.envelope.urgent ? 'urgent' : ''} ${!d.ok ? 'tampered' : ''} ${d.ok && d.body.type === 'sigreq' ? 'wide' : ''}`}>
                <div className="bubble-meta">
                  <strong>{mineMsg ? 'You' : label(m.envelope.sender)}</strong>
                  {m.envelope.urgent && <span className="urgent-tag">🚨 Urgent</span>}
                  {d.ok && <span className="sig-ok" title="Ed25519 signature verified against the attested key">✓ signed</span>}
                </div>
                {!d.ok ? <div className="tamper" data-testid="tampered">⚠ Cannot verify this message: {d.error}</div>
                  : d.body.type === 'text' ? <p className="bubble-text">{d.body.text}</p>
                  : d.body.type === 'sigreq' ? <SigRequestCard walletId={walletId} req={requests[d.body.requestId]} me={me} dir={dir} note={d.body.text} onUpdate={onRequest} />
                  : d.body.type === 'attachment' ? (
                    <div className="att-msg">
                      {d.body.text && <p className="bubble-text">{d.body.text}</p>}
                      <div className="att">
                        <span className={`att-icon ${d.body.vault.mime === 'application/pdf' ? 'pdf' : ''}`}>{d.body.vault.mime === 'application/pdf' ? 'PDF' : 'IMG'}</span>
                        <div className="att-body"><strong>{d.body.vault.name}</strong><span className="muted small">In the Trust Vault · sha256 <code>{d.body.vault.sha256.slice(0, 12)}…</code></span></div>
                        <button className="btn small ghost" onClick={() => navigate(`/vault/${walletId}`)}>Open in vault</button>
                      </div>
                    </div>
                  ) : null}
                <div className="bubble-foot">{timeOf(m.envelope.createdAt)}{mineMsg && <Ticks m={m} me={me.fingerprint} />}</div>
              </div>
            </div>
          )
        })}
        {queued > 0 && <div className="sys-line warn">⏳ {queued} message{queued > 1 ? 's' : ''} queued offline; they send automatically when the node is reachable.</div>}
        <div ref={end} />
      </div>
      <form className={`compose ${urgent ? 'urgent' : ''}`} onSubmit={submit}>
        <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={`Message ${title}… (encrypted for ${members.length} trustee${members.length === 1 ? '' : 's'})`}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }} data-testid="compose" />
        <div className="compose-actions">
          <label className={`urgent-toggle ${urgent ? 'on' : ''}`}><input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} data-testid="urgent-toggle" />🚨 Urgent</label>
          <button type="button" className="btn small ghost" onClick={() => setAttach(true)}>📎 From vault</button>
          <span className="spacer" />
          <button className="btn primary small" disabled={busy || !text.trim()} data-testid="send">{busy ? 'Encrypting…' : 'Send ↗'}</button>
        </div>
        {error && <div className="form-error" role="alert">{error}</div>}
      </form>
      {attach && <VaultAttachPicker walletId={walletId} onClose={() => setAttach(false)} onPick={(docId, a) => { setAttach(false); send({ type: 'attachment', text: text.trim() || undefined, vault: { docId, attId: a.id, name: a.name, mime: a.mime, sha256: a.sha256 } }) }} />}
    </section>
  )
}

function VaultAttachPicker({ walletId, onClose, onPick }: { walletId: string; onClose: () => void; onPick: (docId: string, a: Attachment) => void }) {
  const [items, setItems] = useState<{ docId: string; title: string; a: Attachment }[] | null>(null)
  const unlocked = !!vaultSession.get(walletId)
  useEffect(() => {
    if (!unlocked) return
    vaultApi.list(walletId).then(async (docs) => {
      const full = await Promise.all(docs.filter((d) => d.attachments > 0).map((d) => vaultApi.get(walletId, d.id)))
      setItems(full.flatMap((d) => d.attachments.map((a) => ({ docId: d.id, title: d.title, a }))))
    }).catch(() => setItems([]))
  }, [walletId, unlocked])
  return (
    <Modal title="Share a vault attachment" onClose={onClose}>
      <p className="hint">The message carries only a reference (document, file name and SHA-256). The file stays encrypted in the Trust Vault; recipients open it with the vault passphrase.</p>
      {!unlocked ? <div className="form-ok">Unlock the <button className="link" onClick={() => navigate(`/vault/${walletId}`)}>Trust Vault</button> first to pick a file.</div>
        : !items ? <div className="muted">Decrypting index…</div>
        : <ul className="atts">{items.map((i) => <li key={i.a.id} className="att"><span className="att-icon">{i.a.mime === 'application/pdf' ? 'PDF' : 'IMG'}</span><div className="att-body"><strong>{i.a.name}</strong><span className="muted small">{i.title}</span></div><button className="btn small" onClick={() => onPick(i.docId, i.a)}>Share</button></li>)}
            {items.length === 0 && <li className="muted">No attachments in the vault yet.</li>}</ul>}
    </Modal>
  )
}
