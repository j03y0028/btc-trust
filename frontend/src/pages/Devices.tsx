import { useCallback, useEffect, useState } from 'react'
import { deviceApi, deviceName, walletApi, type HwDevice, type HwStatus, type Wallet } from '../lib/api'
import { navigate } from '../lib/router'
import { KindBadge } from '../components/KindBadge'
import { CopyButton } from '../components/CopyButton'

export function Devices() {
  const [status, setStatus] = useState<HwStatus | null>(null)
  const [devices, setDevices] = useState<HwDevice[] | null>(null)
  const [wallets, setWallets] = useState<Wallet[]>([])
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [xpubs, setXpubs] = useState<Record<string, string>>({})

  const scan = useCallback(async (refresh: boolean) => {
    setScanning(true)
    try {
      const [st, list] = await Promise.all([deviceApi.status(), deviceApi.list(refresh)])
      setStatus(st); setDevices(list); setError(null)
    } catch (e) { setError((e as Error).message); setDevices([]) } finally { setScanning(false) }
  }, [])

  useEffect(() => {
    scan(true)
    walletApi.list().then(setWallets).catch(() => {})
  }, [scan])

  const showXpub = async (fp: string) => {
    try {
      const x = await deviceApi.xpub(fp, 'multisig')
      setXpubs((m) => ({ ...m, [fp]: x.key }))
    } catch (e) { setError((e as Error).message) }
  }

  return (
    <main className="page">
      <section className="page-head">
        <div>
          <span className="eyebrow">Hardware wallets</span>
          <h2 className="page-title">{devices ? devices.length : '—'} <small>connected</small></h2>
          <p className="muted">
            {status?.available ? <>HWI {status.version} · {status.mode === 'mock' ? 'mock adapter' : 'USB + emulators'} · regtest</> : status ? 'HWI not installed: hardware cosigners fall back to the software signer' : 'Checking HWI…'}
          </p>
        </div>
        <button className={`btn ghost ${scanning ? 'scanning' : ''}`} onClick={() => scan(true)} disabled={scanning}>
          <span className="spin-icon">⟳</span> {scanning ? 'Scanning…' : 'Refresh'}
        </button>
      </section>

      {error && <div className="glass alert" role="alert">⚠ {error}</div>}

      {devices && devices.length === 0 && (
        <div className="glass card empty">
          <div className="empty-icon">⌁</div>
          <h3>No hardware wallet detected</h3>
          <p className="muted">Plug in and unlock a Trezor, Ledger, Coldcard, BitBox02 or Jade, then press Refresh. Until then, software cosigners on this node sign, and air-gapped devices can sign via PSBT file or QR.</p>
        </div>
      )}

      <div className="device-grid">
        {devices?.map((d, i) => {
          const uses = wallets.filter((w) => w.cosigners.some((c) => c.fingerprint === d.fingerprint))
          const ready = !d.error && !!d.fingerprint
          return (
            <article key={d.path} className="glass card device-card" style={{ animationDelay: `${i * 70}ms` }} data-testid="device-card">
              <div className="device-visual" aria-hidden>
                <div className="device-body"><div className="device-screen"><span>₿</span></div><div className="device-btns"><i /><i /></div></div>
              </div>
              <div className="device-info">
                <div className="wc-head">
                  <KindBadge kind="hardware" />
                  <span className={`dev-state ${ready ? 'ok' : 'warn'}`}><i />{ready ? 'Ready' : d.needsPin ? 'Needs PIN' : d.error ?? 'Locked'}</span>
                </div>
                <h3 className="device-name">{deviceName(d)}</h3>
                <div className="device-meta">
                  <span>Label <strong>{d.label ?? '—'}</strong></span>
                  <span>Fingerprint <code>{d.fingerprint ?? '—'}</code></span>
                  <span>Path <code>{d.path}</code></span>
                </div>
                {uses.length > 0 && (
                  <div className="device-uses">Cosigner in {uses.map((w) => <button key={w.id} className="link" onClick={() => navigate(`/wallets/${w.id}`)}>{w.name}</button>)}</div>
                )}
                {d.fingerprint && xpubs[d.fingerprint] && (
                  <div className="xpub-box">
                    <span className="field-label">BIP48 multisig key (m/48h/1h/0h/2h)</span>
                    <code>{xpubs[d.fingerprint]}</code>
                    <CopyButton text={xpubs[d.fingerprint!]} />
                  </div>
                )}
                <div className="detail-actions">
                  <button className="btn primary" disabled={!ready} onClick={() => navigate(`/wallets?new=multisig&hw=${d.fingerprint}`)}>＋ Add as multisig cosigner</button>
                  <button className="btn ghost" disabled={!ready} onClick={() => navigate(`/wallets?new=singlesig&hw=${d.fingerprint}`)}>Single-sig wallet</button>
                  <button className="btn ghost" disabled={!ready} onClick={() => showXpub(d.fingerprint!)}>Show xpub</button>
                </div>
              </div>
            </article>
          )
        })}
      </div>

      <section className="assurances">
        {([
          ['hardware', 'Hardware', 'Keys stay on the device. The device signs over USB through HWI after you confirm on its screen.'],
          ['software', 'Software', 'Keys live in a bitcoind wallet on this node. It also steps in as the fallback when a device is unplugged.'],
          ['airgapped', 'Air-gapped', 'The device never connects. Export the PSBT as a file or QR, sign offline, then import the signed PSBT.'],
        ] as const).map(([kind, title, desc], i) => (
          <div key={kind} className="glass card assurance" style={{ animationDelay: `${200 + i * 80}ms` }}>
            <KindBadge kind={kind} />
            <div><strong>{title} signer</strong><p className="muted">{desc}</p></div>
          </div>
        ))}
      </section>
    </main>
  )
}
