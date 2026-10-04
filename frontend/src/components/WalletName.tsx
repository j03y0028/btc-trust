import { useEffect, useRef, useState } from 'react'
import { walletApi } from '../lib/api'

const MAX = 64

/** Wallet display name with inline rename (pencil → input; Enter saves, Escape cancels). */
export function WalletName({ id, name, onRenamed }: { id: string; name: string; onRenamed: (name: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(name)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { if (!editing) setValue(name) }, [name, editing])
  useEffect(() => { if (editing) input.current?.select() }, [editing])

  const trimmed = value.trim()
  const invalid = !trimmed ? 'Name cannot be empty' : trimmed.length > MAX ? `Max ${MAX} characters` : null
  const save = async () => {
    if (invalid) { setError(invalid); return }
    if (trimmed === name) { setEditing(false); return }
    setSaving(true)
    try {
      const w = await walletApi.rename(id, trimmed)
      onRenamed(w.name); setEditing(false); setError(null)
    } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
  }
  const cancel = () => { setEditing(false); setError(null); setValue(name) }

  if (!editing) {
    return (
      <div className="name-row">
        <h2 className="detail-name">{name}</h2>
        <button className="icon-btn pencil" onClick={() => setEditing(true)} aria-label="Rename wallet" title="Rename wallet">
          <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M15.2 4.3a2.2 2.2 0 0 1 3.1 0l1.4 1.4a2.2 2.2 0 0 1 0 3.1L9.5 19l-4.6 1.2a.8.8 0 0 1-1-1L5 14.6 15.2 4.3Zm-8.6 11.2-.6 2.5 2.5-.6 8.7-8.7-1.9-1.9-8.7 8.7Z"/></svg>
        </button>
      </div>
    )
  }
  return (
    <form className="name-edit" onSubmit={(e) => { e.preventDefault(); save() }}>
      <div className="name-edit-row">
        <input ref={input} aria-label="Wallet name" value={value} maxLength={MAX + 8} disabled={saving} aria-invalid={!!invalid}
          onChange={(e) => { setValue(e.target.value); setError(null) }} onKeyDown={(e) => { if (e.key === 'Escape') cancel() }} />
        <button type="submit" className="btn small primary" disabled={saving || !!invalid}>{saving ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn small ghost" onClick={cancel} disabled={saving}>Cancel</button>
      </div>
      <div className="name-edit-meta">
        <span className={`counter ${trimmed.length > MAX ? 'over' : ''}`}>{trimmed.length}/{MAX}</span>
        <span className="muted small">Only the display name changes. Addresses and keys stay the same.</span>
      </div>
      {(error || (invalid && value !== name)) && <div className="field-error" role="alert">{error ?? invalid}</div>}
    </form>
  )
}
