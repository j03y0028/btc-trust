import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, btc, deviceApi, deviceName, walletApi, type HwDevice, type PsbtInfo, type SignResult, type WalletDetail } from '../lib/api'
import { SigRing } from './SigRing'
import { KindBadge } from './KindBadge'
import { QrCode } from './QrCode'
import { AnimatedQr, UrScanner } from './AnimatedQr'
import { RequestSignature } from './RequestSignature'

/** Single-frame QR limit for base64 PSBTs (version 40, low ECC ≈ 2.9 KB; keep margin for scanners). */
export const QR_MAX = 2200
/** Above this size an animated UR is easier to scan than one dense QR. */
export const UR_FROM = 600

export function SendFlow({ wallet, onDone }: { wallet: WalletDetail; onDone: () => void }) {
  const [address, setAddress] = useState('')
  const [amount, setAmount] = useState('')
  const [feeRate, setFeeRate] = useState('2')
  const [psbt, setPsbt] = useState<PsbtInfo | null>(null)
  const [imported, setImported] = useState('')
  const [txid, setTxid] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [devices, setDevices] = useState<HwDevice[]>([])
  const [offline, setOffline] = useState<Record<number, boolean>>({})
  const [log, setLog] = useState<{ text: string; tone: 'ok' | 'warn' }[]>([])
  const [airgap, setAirgap] = useState(false)
  const [showQr, setShowQr] = useState(false)
  const [qrMode, setQrMode] = useState<'auto' | 'ur' | 'single'>('auto')
  const [scan, setScan] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const refreshDevices = useCallback(async () => {
    try { const d = await deviceApi.list(true); setDevices(Array.isArray(d) ? d : []) } catch { setDevices([]) }
  }, [])
  useEffect(() => { refreshDevices() }, [refreshDevices])

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key); setError(null)
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }
  const step = txid ? 2 : psbt ? 1 : 0
  const connected = (fp: string) => devices.some((d) => d.fingerprint === fp && !d.error)
  const hasSoftwareLeft = (p: PsbtInfo) => wallet.cosigners.some((c) => c.kind === 'software' && !p.signedBy.includes(c.fingerprint))

  const applySign = (r: SignResult) => {
    setPsbt(r)
    const c = wallet.cosigners[r.signer.index]
    setLog((l) => [...l, r.signer.fallback
      ? { text: `${c.label} signed as software fallback (${r.signer.reason ?? 'device not connected'})`, tone: 'warn' }
      : { text: `${c.label} signed${r.signer.kind === 'hardware' ? ' on device' : ''}`, tone: 'ok' }])
  }

  const sign = (i: number, fallback = false) => run(`sign${i}`, async () => {
    try {
      applySign(await walletApi.sign(wallet.id, psbt!.psbt, i, fallback))
    } catch (e) {
      if (e instanceof ApiError && e.details?.code === 'DEVICE_NOT_CONNECTED') { setOffline((o) => ({ ...o, [i]: true })); refreshDevices() }
      throw e
    }
  })

  const download = () => run('export', async () => {
    const { blob, filename } = await walletApi.exportPsbt(wallet.id, psbt!.psbt)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = filename; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  })

  const importData = (data: ArrayBuffer | string, source: string) => run('import', async () => {
    const before = psbt!.signatures
    const r = await walletApi.importPsbt(wallet.id, data, psbt!.psbt)
    setPsbt(r); setImported('')
    setLog((l) => [...l, { text: `Imported ${source}: ${r.signatures - before} new signature${r.signatures - before === 1 ? '' : 's'}`, tone: r.signatures > before ? 'ok' : 'warn' }])
  })

  return (
    <div className="send">
      <ol className="steps">
        {['Compose', 'Sign', 'Broadcast'].map((s, i) => (
          <li key={s} className={i === step ? 'active' : i < step ? 'done' : ''}><span>{i < step ? '✓' : i + 1}</span>{s}</li>
        ))}
      </ol>

      {step === 0 && (
        <form className="form" onSubmit={(e) => {
          e.preventDefault()
          run('create', async () => { setPsbt(await walletApi.createPsbt(wallet.id, [{ address: address.trim(), amount: Number(amount) }], Number(feeRate) || undefined)); setLog([]) })
        }}>
          <label>Recipient address<input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="bcrt1…" spellCheck={false} required /></label>
          <div className="row2">
            <label>Amount (BTC)<input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00" required /></label>
            <label>Fee rate (sat/vB)<input value={feeRate} onChange={(e) => setFeeRate(e.target.value)} inputMode="decimal" /></label>
          </div>
          <p className="hint">Available: {btc(wallet.balance.confirmed)} BTC confirmed</p>
          <div className="wizard-actions"><span />
            <button className="btn primary" disabled={!!busy}>{busy ? 'Building PSBT…' : 'Create PSBT'}</button>
          </div>
        </form>
      )}

      {step === 1 && psbt && (
        <div className="sign-step">
          <div className="sign-top">
            <SigRing have={psbt.signatures} need={psbt.required} />
            <div className="tx-summary">
              {psbt.outputs.map((o, i) => (
                <div key={i} className={`out ${o.isChange ? 'change' : ''}`}>
                  <span>{o.isChange ? 'Change' : 'To'}</span>
                  <code title={o.address}>{o.address.slice(0, 14)}…{o.address.slice(-8)}</code>
                  <strong>{btc(o.amount)} BTC</strong>
                </div>
              ))}
              <div className="out fee"><span>Network fee</span><code>{psbt.inputs} input{psbt.inputs > 1 ? 's' : ''}</code><strong>{psbt.fee !== null ? btc(psbt.fee) : '?'} BTC</strong></div>
            </div>
          </div>

          <ul className="cosigners">
            {wallet.cosigners.map((c, i) => {
              const signed = psbt.signedBy.includes(c.fingerprint)
              const dev = devices.find((d) => d.fingerprint === c.fingerprint)
              const isOnline = c.kind === 'hardware' && connected(c.fingerprint) && !offline[i]
              return (
                <li key={c.fingerprint + i} className={`cosigner ${signed ? 'signed' : ''} ck-${c.kind}`} data-testid={`cosigner-${i}`}>
                  <span className="avatar">{signed ? '✓' : c.label.slice(0, 1).toUpperCase()}</span>
                  <div className="cos-body">
                    <strong>{c.label} <KindBadge kind={c.kind} /></strong>
                    <code>{c.fingerprint}{c.kind === 'hardware' ? ` · ${dev ? deviceName(dev) : c.device ? deviceName({ ...c.device, emulator: false }) : 'device'}${isOnline ? ' · connected' : ' · not connected'}` : ''}</code>
                  </div>
                  {signed ? <span className="badge badge-complete">Signed</span>
                    : psbt.complete ? <span className="badge badge-planned">Not needed</span>
                    : c.kind === 'software' ? <button className="btn small" disabled={!!busy} onClick={() => sign(i)}>{busy === `sign${i}` ? 'Signing…' : 'Sign'}</button>
                    : c.kind === 'hardware' ? (
                      isOnline
                        ? <button className="btn small hw" disabled={!!busy} onClick={() => sign(i)}>{busy === `sign${i}` ? 'Confirm on device…' : '⌁ Sign on device'}</button>
                        : <div className="hw-offline">
                            <button className="btn small ghost" disabled={!!busy} onClick={() => { setOffline((o) => ({ ...o, [i]: false })); refreshDevices() }}>Retry</button>
                            {hasSoftwareLeft(psbt) && <button className="btn small warnbtn" disabled={!!busy} onClick={() => sign(i, true)} data-testid={`fallback-${i}`}>{busy === `sign${i}` ? 'Signing…' : 'Use software fallback'}</button>}
                          </div>
                    )
                    : <button className="btn small ghost" onClick={() => setAirgap(true)}>✈ Export / Import</button>}
                </li>
              )
            })}
          </ul>

          {log.length > 0 && (
            <ul className="sign-log" aria-label="Signing activity">
              {log.map((e, i) => <li key={i} className={e.tone}><i />{e.text}</li>)}
            </ul>
          )}

          <details className="psbt-box" open={airgap} onToggle={(e) => setAirgap((e.target as HTMLDetailsElement).open)}>
            <summary>✈ Air-gapped signing · PSBT file / QR</summary>
            <div className="airgap">
              <div className="airgap-col">
                <span className="field-label">1 · Export</span>
                <div className="psbt-actions">
                  <button className="btn small" onClick={download} disabled={!!busy}>⬇ Download .psbt</button>
                  <button className="btn small ghost" onClick={() => setShowQr((v) => !v)}>{showQr ? 'Hide QR' : '▦ Show QR'}</button>
                  <button className="btn small ghost" onClick={() => { navigator.clipboard?.writeText(psbt.psbt); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>{copied ? 'Copied ✓' : 'Copy base64'}</button>
                </div>
                {showQr && (psbt.psbt.length > QR_MAX || qrMode === 'ur' || (qrMode === 'auto' && psbt.psbt.length > UR_FROM)
                  ? <div className="psbt-qr"><AnimatedQr psbt={psbt.psbt} size={220} /><span className="hint">{psbt.psbt.length} chars · animated BC-UR (fountain codes) · scan with Sparrow, Keystone, Passport…</span>
                      {psbt.psbt.length <= QR_MAX && <button className="link small" onClick={() => setQrMode('single')}>Show as one QR</button>}</div>
                  : <div className="psbt-qr"><QrCode value={psbt.psbt} size={200} /><span className="hint">{psbt.psbt.length} chars · single-frame QR</span><button className="link small" onClick={() => setQrMode('ur')}>Animated UR</button></div>)}
              </div>
              <div className="airgap-col">
                <span className="field-label">2 · Import signed PSBT</span>
                <input ref={fileRef} type="file" accept=".psbt,.txt,application/octet-stream,text/plain" hidden data-testid="psbt-file"
                  onChange={async (e) => { const f = e.target.files?.[0]; if (f) importData(await f.arrayBuffer(), f.name); e.target.value = '' }} />
                <div className="psbt-actions">
                  <button className="btn small" onClick={() => fileRef.current?.click()} disabled={!!busy}>⬆ Import .psbt file</button>
                  <button className="btn small ghost" onClick={() => setScan((v) => !v)} disabled={!!busy}>{scan ? 'Stop scanning' : '◫ Scan animated QR'}</button>
                </div>
                {scan && <UrScanner onClose={() => setScan(false)} onPsbt={(b64) => { setScan(false); importData(b64, 'scanned UR QR') }} />}
                <textarea rows={3} value={imported} onChange={(e) => setImported(e.target.value)} placeholder="…or paste base64 / hex PSBT" spellCheck={false} />
                <button className="btn small ghost" disabled={!imported.trim() || !!busy} onClick={() => importData(imported.trim(), 'pasted PSBT')}>Merge signatures</button>
              </div>
            </div>
          </details>

          <div className="wizard-actions">
            <button className="btn ghost" onClick={() => setPsbt(null)}>Discard</button>
            {!psbt.complete && wallet.cosigners.length > 1 && <button className="btn ghost" onClick={() => setRequesting(true)} data-testid="request-signature">✉ Request signature</button>}
            <button className="btn primary" disabled={!psbt.complete || !!busy}
              onClick={() => run('broadcast', async () => setTxid((await walletApi.broadcast(wallet.id, psbt.psbt)).txid))}>
              {psbt.complete ? (busy === 'broadcast' ? 'Broadcasting…' : 'Finalize & broadcast') : `Needs ${psbt.required - psbt.signatures} more signature${psbt.required - psbt.signatures > 1 ? 's' : ''}`}
            </button>
          </div>
        </div>
      )}

      {step === 2 && txid && (
        <div className="done">
          <div className="done-check">✓</div>
          <h3>Transaction broadcast</h3>
          <code className="txid">{txid}</code>
          <p className="hint">Mine a block on regtest to confirm it.</p>
          <div className="wizard-actions"><span /><button className="btn primary" onClick={onDone}>Done</button></div>
        </div>
      )}

      {error && <div className="form-error" role="alert">{error}</div>}
      {requesting && psbt && <RequestSignature wallet={wallet} psbt={psbt} onClose={() => setRequesting(false)} />}
    </div>
  )
}
