import { useCallback, useEffect, useState } from 'react'
import { fmt, initial, walletApi, walletKind, type WalletDetail as WD } from '../lib/api'
import { navigate } from '../lib/router'
import { QrCode } from '../components/QrCode'
import { DeviceRegistration } from '../components/DeviceRegistration'
import { Modal } from '../components/Modal'
import { SendFlow } from '../components/SendFlow'
import { KindBadge } from '../components/KindBadge'
import { WalletName } from '../components/WalletName'
import { DangerZone } from '../components/DangerZone'
import { Amount } from '../components/Amount'
import { useDisplay } from '../lib/display'
import { formatUnit, toSats } from '../lib/money'

type Tab = 'activity' | 'utxos' | 'keys' | 'devices'

export function WalletDetail({ id }: { id: string }) {
  const [w, setW] = useState<WD | null>(null)
  const [address, setAddress] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('activity')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const display = useDisplay()
  /** amount in the chosen unit, with its label */
  const u = (btcAmount: number, digits: number) => `${formatUnit(toSats(btcAmount), display.unit, digits)} ${display.unit}`
  const [verify, setVerify] = useState<{ state: 'busy' | 'ok' | 'bad' | 'err'; text: string } | null>(null)

  const verifyOnDevice = async (cosigner: number) => {
    if (!address) return
    setVerify({ state: 'busy', text: 'Check the address on the device screen…' })
    try {
      const r = await walletApi.verifyAddress(id, cosigner, address)
      setVerify(r.match ? { state: 'ok', text: `Device shows ${r.deviceAddress.slice(0, 12)}…${r.deviceAddress.slice(-6)}, which matches (index ${r.index})` } : { state: 'bad', text: `MISMATCH: device shows ${r.deviceAddress}` })
    } catch (e) { setVerify({ state: 'err', text: (e as Error).message }) }
  }

  const load = useCallback(() => walletApi.get(id).then((d) => { setW(d); setError(null) }).catch((e) => setError(e.message)), [id])
  useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [load])
  useEffect(() => {
    walletApi.newAddress(id).then((a) => setAddress(a.address)).catch(() => {})
  }, [id])

  const regtest = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try { await fn(); await load() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  if (error && !w) return <main className="page"><div className="glass alert" role="alert">⚠ {error}</div></main>
  if (!w) return <main className="page"><div className="glass card skeleton">Loading wallet…</div></main>

  return (
    <main className="page">
      <button className="back" onClick={() => navigate('/wallets')}>← All wallets</button>
      {error && <div className="glass alert" role="alert">⚠ {error}</div>}
      <section className="detail-grid">
        <div className="glass card balance-card">
          <div className="wc-head">
            <span className={`kind kind-${w.type}`}>{walletKind(w)}</span>
            <span className="muted small">{w.type === 'multisig' ? 'P2WSH · wsh(sortedmulti)' : w.type === 'singlesig' ? 'P2WPKH' : 'Watch-only'}</span>
          </div>
          <WalletName id={w.id} name={w.name} onRenamed={(name) => setW((cur) => (cur ? { ...cur, name } : cur))} />
          <div className="detail-balance"><Amount btc={w.balance.confirmed} variant="hero" network={w.network} meta testId="balance" /></div>
          <div className="balance-split">
            <span><i className="dot green" />Confirmed {u(w.balance.confirmed, 4)}</span>
            <span><i className="dot orange" />Pending {u(w.balance.pending, 4)}</span>
            <span><i className="dot violet" />Immature {u(w.balance.immature, 4)}</span>
          </div>
          <div className="quorum" data-testid="quorum">
            <div className="quorum-keys">
              {w.cosigners.map((c, i) => (
                <span key={i} className={`q-key ${c.local ? 'local' : 'ext'}`} title={`${c.label} · ${c.fingerprint}`}>
                  <i>{initial(c.label)}</i>{c.label}
                </span>
              ))}
            </div>
            <span className="quorum-text">{w.type === 'watchonly' ? 'Watch-only · sign externally' : `${w.m} of ${w.n} signature${w.m > 1 ? 's' : ''} required to spend`}</span>
          </div>
          <div className="detail-actions">
            <button className="btn primary" onClick={() => setSending(true)}>↗ Send</button>
            <button className="btn ghost" disabled={busy} onClick={() => regtest(() => walletApi.fund(id, 5))} title="Regtest faucet: send 5 BTC and confirm">⛲ Faucet 5 BTC</button>
            <button className="btn ghost" disabled={busy} onClick={() => regtest(() => walletApi.mine(1))}>⛏ Mine 1 block</button>
            <button className="btn ghost" onClick={() => navigate(`/vault/${id}`)} data-testid="open-vault">🔐 Trust vault</button>
          </div>
        </div>

        <div className="glass card receive-card">
          <div className="card-title"><h2>Receive</h2><span className="pill">bech32</span></div>
          {address ? (
            <>
              <QrCode value={`bitcoin:${address}`} size={168} />
              <code className="addr" data-testid="receive-address">{address}</code>
              <div className="row-actions">
                <button className="btn small ghost" onClick={() => { navigator.clipboard?.writeText(address); setCopied(true); setTimeout(() => setCopied(false), 1500) }}>{copied ? 'Copied ✓' : 'Copy'}</button>
                <button className="btn small ghost" onClick={() => walletApi.newAddress(id).then((a) => { setAddress(a.address); setVerify(null) })}>New address</button>
                {w.cosigners.some((c) => c.kind === 'hardware') && (
                  <button className="btn small hw" onClick={() => verifyOnDevice(w.cosigners.findIndex((c) => c.kind === 'hardware'))} data-testid="verify-device">⌁ Verify on device</button>
                )}
              </div>
              {verify && <div className={`verify v-${verify.state}`} role="status">{verify.state === 'ok' ? '✓ ' : verify.state === 'busy' ? '⌁ ' : '⚠ '}{verify.text}</div>}
            </>
          ) : <div className="muted">Generating address…</div>}
        </div>
      </section>

      <section className="glass card tabs-card">
        <div className="tabs" role="tablist">
          {((w.type === 'multisig' || w.type === 'watchonly' ? ['activity', 'utxos', 'keys', 'devices'] : ['activity', 'utxos', 'keys']) as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {t === 'activity' ? `Activity (${w.history.length})` : t === 'utxos' ? `UTXOs (${w.utxos.length})` : t === 'keys' ? `Keys (${w.n})` : 'Device registration'}
            </button>
          ))}
        </div>

        {tab === 'devices' && <DeviceRegistration walletId={w.id} />}
        {tab === 'activity' && (
          <ul className="history">
            {w.history.length === 0 && <li className="muted">No transactions yet. Use the regtest faucet to fund this wallet.</li>}
            {w.history.map((h) => (
              <li key={h.txid} className={`tx tx-${h.type}`}>
                <span className="tx-icon">{h.type === 'sent' ? '↗' : h.type === 'mined' ? '⛏' : '↙'}</span>
                <div className="tx-main">
                  <strong>{h.type === 'sent' ? 'Sent' : h.type === 'mined' ? 'Mined' : 'Received'}</strong>
                  <code title={h.txid}>{fmt.hash(h.txid, 8)}</code>
                </div>
                <div className="tx-conf">
                  {h.confirmations > 0 ? <span className="conf ok">{h.confirmations >= 6 ? '6+' : h.confirmations} conf</span> : <span className="conf pending">Pending</span>}
                  <span className="muted">{fmt.ago(h.time)}</span>
                </div>
                <div className={`tx-amt ${h.amount < 0 ? 'neg' : 'pos'}`}><Amount btc={h.amount} signed network={w.network} interactive={false} /></div>
              </li>
            ))}
          </ul>
        )}

        {tab === 'utxos' && (
          <table className="utxo-table">
            <thead><tr><th>Outpoint</th><th>Address</th><th>Conf</th><th className="r">Amount</th></tr></thead>
            <tbody>
              {w.utxos.map((x) => (
                <tr key={`${x.txid}:${x.vout}`}><td><code>{fmt.hash(x.txid, 6)}:{x.vout}</code></td><td><code>{x.address.slice(0, 16)}…</code></td><td>{x.confirmations}</td><td className="r">{u(x.amount, 8)}</td></tr>
              ))}
              {w.utxos.length === 0 && <tr><td colSpan={4} className="muted">No unspent outputs.</td></tr>}
            </tbody>
          </table>
        )}

        {tab === 'keys' && (
          <div className="keys">
            <ul className="cosigners">
              {w.cosigners.map((c, i) => (
                <li key={i} className="cosigner">
                  <span className="avatar">{c.label.slice(0, 1).toUpperCase()}</span>
                  <div className="cos-body"><strong>{c.label}</strong><code title={c.key}>{c.key.match(/^\[([^\]]+)\]/)?.[1] ?? 'no origin'} · {c.key.replace(/^\[[^\]]+\]/, '').slice(0, 22)}…</code></div>
                  <KindBadge kind={c.kind} />
                  {c.kind === 'hardware' && <button className="btn small ghost" onClick={() => verifyOnDevice(i)}>Verify address</button>}
                </li>
              ))}
            </ul>
            <span className="field-label">Receive descriptor (public)</span>
            <code className="descriptor">{w.descriptors.receive}</code>
          </div>
        )}
      </section>

      <DangerZone id={w.id} name={w.name} network={w.network} onDeleted={() => navigate('/wallets')} />

      {sending && (
        <Modal title={`Send from ${w.name}`} onClose={() => setSending(false)} wide>
          <SendFlow wallet={w} onDone={() => { setSending(false); load() }} />
        </Modal>
      )}
    </main>
  )
}
