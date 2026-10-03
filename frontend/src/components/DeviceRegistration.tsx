import { useEffect, useState } from 'react'
import { QrCode } from './QrCode'

interface Reg { cosigner: number; fingerprint: string; device: 'ledger' | 'coldcard'; mock: boolean; at: string; policyId?: string; hmac?: string; fileSha256?: string; name?: string; valid?: boolean }
interface Cos { cosigner: number; label: string; fingerprint: string; kind: string; deviceType: string | null; connected: { type: string; model: string } | null; trezor: { required: false; reason: string } | null; registrations: Reg[] }
interface Status { walletId: string; name: string; coldcardName: string; policy: { name: string; template: string; keys: string[] }; policyId: string; hwi: { register: boolean; note: string }; cosigners: Cos[] }
interface CC { text: string; sha256: string; filename: string }

const j = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const r = await fetch(url, init); const b = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(b.error ?? `HTTP ${r.status}`)
  return b as T
}
const post = (_: string, body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

/** Register the multisig on signing devices: Coldcard setup file, Ledger wallet policy (BIP-388), Trezor (none needed). */
export function DeviceRegistration({ walletId }: { walletId: string }) {
  const [st, setSt] = useState<Status | null>(null)
  const [cc, setCc] = useState<CC | null>(null)
  const [view, setView] = useState<'coldcard' | 'ledger'>('coldcard')
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [verified, setVerified] = useState<Record<number, boolean>>({})
  const load = () => j<Status>(`/api/wallets/${walletId}/registration`).then(setSt).catch((e) => setError(e.message))
  useEffect(() => { load(); j<CC>(`/api/wallets/${walletId}/registration/coldcard`).then(setCc).catch((e) => setError(e.message)) }, [walletId]) // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (i: number, fn: () => Promise<unknown>) => { setBusy(i); setError(null); try { await fn(); await load() } catch (e) { setError((e as Error).message) } finally { setBusy(null) } }

  if (!st) return <div className="muted">{error ?? 'Loading…'}</div>
  return (
    <div className="devreg" data-testid="device-registration">
      <p className="muted small">Registering the multisig lets a signing device verify change outputs and show which wallet it is signing for. Do it once per device, then compare fingerprints and xpubs on the device screen.</p>
      {error && <div className="field-error" role="alert">{error}</div>}
      <div className="devreg-cos">
        {st.cosigners.map((c) => {
          const reg = c.registrations.find((r) => r.device === view)
          return (
            <div key={c.cosigner} className="dr-row">
              <span className="avatar sm">{c.label.slice(0, 1)}</span>
              <div className="dr-body"><strong>{c.label}</strong><span className="muted tiny"><code>{c.fingerprint}</code> · {c.deviceType ?? c.kind}{c.connected ? ` · ${c.connected.model} connected` : ''}</span></div>
              {c.trezor ? <span className="dr-pill none" title={c.trezor.reason}>Trezor · no registration needed</span>
                : reg ? <span className={`dr-pill ${reg.valid === false ? 'bad' : 'ok'}`}>{view === 'ledger' ? `✓ Registered${reg.mock ? ' (mock)' : ''}` : '✓ Imported'}</span>
                : view === 'ledger' ? <button className="btn small" disabled={busy !== null} onClick={() => act(c.cosigner, () => j(`/api/wallets/${walletId}/registration/ledger`, post('', { cosigner: c.cosigner })))}>{busy === c.cosigner ? 'Approve on device…' : 'Register (Ledger mock)'}</button>
                : <button className="btn small ghost" disabled={busy !== null} onClick={() => act(c.cosigner, () => j(`/api/wallets/${walletId}/registration/coldcard/confirm`, post('', { cosigner: c.cosigner })))}>Mark imported</button>}
              {view === 'ledger' && reg?.hmac && (
                <button className="link small" onClick={async () => { const v = await j<{ hmacValid: boolean }>(`/api/wallets/${walletId}/registration/ledger/${c.cosigner}/verify`); setVerified((x) => ({ ...x, [c.cosigner]: v.hmacValid })) }}>
                  {verified[c.cosigner] === undefined ? 'Verify HMAC' : verified[c.cosigner] ? 'HMAC ✓' : 'HMAC ✗'}
                </button>)}
            </div>
          )
        })}
      </div>
      <div className="tabs devreg-tabs" role="tablist">
        <button role="tab" aria-selected={view === 'coldcard'} className={view === 'coldcard' ? 'active' : ''} onClick={() => setView('coldcard')}>Coldcard · setup file</button>
        <button role="tab" aria-selected={view === 'ledger'} className={view === 'ledger' ? 'active' : ''} onClick={() => setView('ledger')}>Ledger · wallet policy</button>
      </div>
      {view === 'coldcard' && cc && (
        <div className="cc-grid">
          <div>
            <div className="cc-head"><span className="field-label">{cc.filename}</span><span className="mono tiny muted">sha256 {cc.sha256.slice(0, 16)}…</span></div>
            <pre className="cc-file" data-testid="coldcard-file">{cc.text}</pre>
            <div className="row-gap">
              <a className="btn small primary" href={`/api/wallets/${walletId}/registration/coldcard.txt`} download={cc.filename}>⬇ Download for SD card</a>
              <button className="btn small ghost" onClick={() => navigator.clipboard?.writeText(cc.text)}>Copy</button>
            </div>
          </div>
          <div className="cc-side">
            <QrCode value={cc.text.split('\n').filter((l) => l && !l.startsWith('#')).join('\n')} size={190} />
            <span className="muted tiny">Coldcard Q: scan to import (comments stripped)</span>
            <ol className="cc-steps muted small">
              <li>Copy the file to the MicroSD card</li>
              <li>Settings → Multisig Wallets → Import from File</li>
              <li>Check <b>{st.coldcardName}</b>, policy and every XFP on screen, then approve</li>
            </ol>
          </div>
        </div>
      )}
      {view === 'ledger' && (
        <div className="ledger-pol">
          <div className="lp-note">⚠ <span>{st.hwi.note} Ledger and Coldcard flows are tested against <b>mocks</b>; verify on real hardware before relying on them.</span></div>
          <span className="field-label">Policy name</span><code>{st.policy.name}</code>
          <span className="field-label">Descriptor template</span><code>{st.policy.template}</code>
          <span className="field-label">Keys</span>
          <ol className="lp-keys">{st.policy.keys.map((k) => <li key={k}><code>{k.slice(0, 30)}…{k.slice(-8)}</code></li>)}</ol>
          <span className="field-label">Wallet policy id (sha256, BIP-388 v2)</span><code className="mono">{st.policyId}</code>
        </div>
      )}
    </div>
  )
}
