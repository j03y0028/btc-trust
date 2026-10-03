import { useEffect, useMemo, useState } from 'react'
import { fmt } from '../lib/api'
import { DOC_META, saveBlob, vaultApi, type AnchorCheck, type Attachment, type Doc } from '../lib/vault'

type Row = Record<string, string | number>

function TableEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const rows = useMemo<Row[] | null>(() => { try { const r = JSON.parse(value); return Array.isArray(r) ? r : null } catch { return null } }, [value])
  if (!rows) return <p className="form-error">Content is not a valid table; switch to raw JSON to fix it.</p>
  const cols = Array.from(new Set(rows.flatMap((r) => Object.keys(r))))
  const set = (i: number, k: string, v: string) => onChange(JSON.stringify(rows.map((r, j) => (j === i ? { ...r, [k]: typeof r[k] === 'number' && v !== '' && !isNaN(Number(v)) ? Number(v) : v } : r)), null, 2))
  const label = (k: string) => k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())
  return (
    <div className="table-editor">
      <table>
        <thead><tr>{cols.map((c) => <th key={c}>{label(c)}</th>)}<th /></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => <td key={c}><input value={String(r[c] ?? '')} onChange={(e) => set(i, c, e.target.value)} aria-label={`${label(c)} row ${i + 1}`} /></td>)}
              <td><button className="icon-btn sm" onClick={() => onChange(JSON.stringify(rows.filter((_, j) => j !== i), null, 2))} aria-label="Remove row">✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="btn small ghost" onClick={() => onChange(JSON.stringify([...rows, Object.fromEntries(cols.map((c) => [c, typeof rows[0]?.[c] === 'number' ? 0 : '']))], null, 2))}>＋ Add row</button>
    </div>
  )
}

function AnchorView({ a }: { a: AnchorCheck }) {
  return (
    <div className={`anchor-view ${a.valid ? 'ok' : 'bad'}`} data-testid="anchor-view">
      <div className="anchor-head">
        <span className="anchor-seal">{a.valid ? '✓' : '✕'}</span>
        <div><strong>{a.valid ? 'Anchored & verified on regtest' : 'Anchor verification failed'}</strong>
          <span className="muted small">{a.onChain ? 'OP_RETURN commitment found' : 'Commitment missing on chain'} · {a.contentOk ? 'content hash matches' : 'content hash MISMATCH'}</span></div>
      </div>
      <dl className="anchor-grid">
        <dt>Block height</dt><dd data-testid="anchor-height">{a.height !== null ? `#${fmt.int(a.height)}` : 'mempool'}</dd>
        <dt>Confirmations</dt><dd>{a.confirmations}</dd>
        <dt>Txid</dt><dd><code data-testid="anchor-txid">{a.txid}</code></dd>
        {a.blockHash && <><dt>Block hash</dt><dd><code>{fmt.hash(a.blockHash, 12)}</code></dd></>}
        <dt>OP_RETURN</dt><dd><code>BTV1 · {fmt.hash(a.hash, 12)}</code></dd>
        {a.blockTime && <><dt>Block time</dt><dd>{new Date(a.blockTime * 1000).toLocaleString('en-US')}</dd></>}
      </dl>
    </div>
  )
}

const isImage = (m: string) => m.startsWith('image/')

function AttachmentRow({ walletId, docId, a }: { walletId: string; docId: string; a: Attachment }) {
  const [thumb, setThumb] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    if (!isImage(a.mime)) return
    let url: string | null = null
    vaultApi.download(walletId, docId, a.id).then((b) => { url = URL.createObjectURL(b); setThumb(url) }).catch((e) => setErr(e.message))
    return () => { if (url) URL.revokeObjectURL(url) }
  }, [walletId, docId, a.id, a.mime])
  const download = () => vaultApi.download(walletId, docId, a.id).then((b) => saveBlob(b, a.name)).catch((e) => setErr(e.message))
  return (
    <li className="att" data-testid="attachment">
      {thumb ? <img src={thumb} alt="" className="att-thumb" /> : <span className={`att-icon ${a.mime === 'application/pdf' ? 'pdf' : ''}`}>{a.mime === 'application/pdf' ? 'PDF' : 'IMG'}</span>}
      <div className="att-body"><strong>{a.name}</strong><span className="muted small">{fmt.bytes(a.size)} · sha256 <code>{a.sha256.slice(0, 12)}…</code>{err && <span className="warn-text"> · {err}</span>}</span></div>
      <button className="btn small ghost" onClick={download}>⤓ Decrypt & download</button>
    </li>
  )
}

export function DocEditor({ walletId, docId, onChanged, onDeleted, touch }: { walletId: string; docId: string; onChanged: () => void; onDeleted: () => void; touch: () => void }) {
  const [doc, setDoc] = useState<Doc | null>(null)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [raw, setRaw] = useState(false)
  const [viewing, setViewing] = useState<number | null>(null)
  const [anchor, setAnchor] = useState<AnchorCheck | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  const apply = (d: Doc) => { setDoc(d); setTitle(d.title); setContent(d.versions[d.versions.length - 1].content); touch() }
  useEffect(() => {
    vaultApi.get(walletId, docId).then((d) => {
      apply(d)
      const last = [...d.versions].reverse().find((v) => v.anchor)
      if (last) vaultApi.verifyAnchor(walletId, docId, last.v).then(setAnchor).catch(() => {})
    }).catch((e) => setError(e.message))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletId, docId])

  if (!doc) return <div className="glass card skeleton">{error ?? 'Decrypting…'}</div>
  const latest = doc.versions[doc.versions.length - 1]
  const dirty = title !== doc.title || content !== latest.content
  const table = (doc.type === 'beneficiaries' || doc.type === 'trustees') && !raw
  const readOnly = doc.type === 'descriptor-backup'
  const shown = viewing !== null ? doc.versions.find((v) => v.v === viewing)! : null

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setError(null); setSaved(null)
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const save = () => run('save', async () => {
    const d = await vaultApi.updateDoc(walletId, docId, { title, content })
    apply(d); onChanged()
    const v = d.versions[d.versions.length - 1]
    setSaved(v.v !== latest.v ? `Saved as version ${v.v} · sha256 ${v.sha256.slice(0, 16)}…` : 'Saved')
  })
  const doAnchor = (v: number) => run(`anchor-${v}`, async () => {
    setAnchor(await vaultApi.anchor(walletId, docId, v))
    apply(await vaultApi.get(walletId, docId)); onChanged()
  })
  const verify = (v: number) => run(`verify-${v}`, async () => {
    const [h, a] = await Promise.all([vaultApi.verifyVersion(walletId, docId, v), doc.versions.find((x) => x.v === v)?.anchor ? vaultApi.verifyAnchor(walletId, docId, v) : Promise.resolve(null)])
    if (a) setAnchor(a)
    setSaved(h.valid ? `Version ${v}: SHA-256 recomputed and matches` : `Version ${v}: hash mismatch!`)
  })
  const upload = (files: FileList | null) => files?.length && run('upload', async () => {
    for (const f of Array.from(files)) await vaultApi.upload(walletId, docId, f)
    apply(await vaultApi.get(walletId, docId)); onChanged()
  })
  const remove = () => { if (confirm(`Delete “${doc.title}” and all its versions?`)) run('delete', async () => { await vaultApi.deleteDoc(walletId, docId); onDeleted() }) }

  return (
    <div className="doc-pane">
      <section className="glass card editor-card" data-testid="doc-editor">
        <div className="editor-head">
          <span className="doc-type">{DOC_META[doc.type].icon} {DOC_META[doc.type].label}</span>
          <input className="title-input" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Document title" disabled={readOnly} />
          <span className="muted small">v{latest.v} · {new Date(latest.createdAt).toLocaleString('en-US')}</span>
        </div>
        {shown ? (
          <div className="version-preview">
            <div className="row-actions"><span className="pill">Viewing version {shown.v} (read-only)</span><button className="btn small ghost" onClick={() => setViewing(null)}>Back to latest</button>
              {shown.v !== latest.v && <button className="btn small ghost" onClick={() => { setContent(shown.content); setViewing(null) }}>Restore into editor</button>}</div>
            <pre className="doc-pre">{shown.content}</pre>
          </div>
        ) : table ? <TableEditor value={content} onChange={setContent} />
          : <textarea className="doc-text" value={content} onChange={(e) => setContent(e.target.value)} readOnly={readOnly} rows={16} spellCheck={!readOnly} aria-label="Document content" data-testid="doc-content" />}
        {readOnly && <p className="hint">Descriptor backups are generated from the wallet’s public descriptors and are read-only. Private keys are rejected everywhere in the vault.</p>}
        <div className="row-actions">
          {!readOnly && <button className="btn primary" disabled={!dirty || !!busy} onClick={save} data-testid="doc-save">{busy === 'save' ? 'Encrypting…' : 'Save new version'}</button>}
          {(doc.type === 'beneficiaries' || doc.type === 'trustees') && <button className="btn small ghost" onClick={() => setRaw(!raw)}>{raw ? 'Table view' : 'Raw JSON'}</button>}
          <span className="spacer" />
          <button className="btn small ghost danger" onClick={remove}>Delete</button>
        </div>
        {saved && <div className="form-ok">{saved}</div>}
        {error && <div className="form-error" role="alert">{error}</div>}
      </section>

      <section className="glass card versions-card" data-testid="version-history">
        <div className="card-title"><h2>Version history</h2><span className="pill">SHA-256</span></div>
        <ol className="versions">
          {[...doc.versions].reverse().map((v) => (
            <li key={v.v} className={`ver ${viewing === v.v ? 'active' : ''}`}>
              <span className="ver-num">v{v.v}</span>
              <div className="ver-body">
                <code className="ver-hash" title={v.sha256}>{v.sha256.slice(0, 24)}…</code>
                <span className="muted small">{new Date(v.createdAt).toLocaleString('en-US')} · {fmt.bytes(v.size)}</span>
              </div>
              <span className={`ver-badge ${v.verified ? 'ok' : 'bad'}`}>{v.verified ? '✓ intact' : '✕ altered'}</span>
              {v.anchor ? <span className="ver-badge anchor">⚓ anchored</span> : null}
              <div className="ver-actions">
                <button className="btn small ghost" onClick={() => setViewing(v.v)}>View</button>
                <button className="btn small ghost" disabled={!!busy} onClick={() => verify(v.v)}>Verify</button>
                {!v.anchor && <button className="btn small" disabled={!!busy} onClick={() => doAnchor(v.v)} data-testid={`anchor-v${v.v}`}>{busy === `anchor-${v.v}` ? 'Anchoring…' : '⚓ Anchor'}</button>}
              </div>
            </li>
          ))}
        </ol>
        {anchor && <AnchorView a={anchor} />}
      </section>

      <section className="glass card att-card">
        <div className="card-title"><h2>Attachments</h2><span className="pill">encrypted</span></div>
        <ul className="atts">
          {doc.attachments.map((a) => <AttachmentRow key={a.id} walletId={walletId} docId={docId} a={a} />)}
          {doc.attachments.length === 0 && <li className="muted small">No files yet. Attach the signed deed (PDF) or photos of notarized pages.</li>}
        </ul>
        <label className="dropzone">
          <input type="file" accept="application/pdf,image/png,image/jpeg,image/gif,image/webp" multiple onChange={(e) => { upload(e.target.files); e.target.value = '' }} data-testid="att-input" />
          <span>{busy === 'upload' ? 'Encrypting upload…' : '⤒ Add PDF or image (max 10 MB) — encrypted with AES-256-GCM before it touches disk'}</span>
        </label>
      </section>
    </div>
  )
}
