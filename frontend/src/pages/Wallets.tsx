import { useEffect, useState } from 'react'
import { initial, walletApi, walletKind, type Wallet } from '../lib/api'
import { navigate } from '../lib/router'
import { Modal } from '../components/Modal'
import { CreateWalletWizard, type WizardPreset } from '../components/CreateWalletWizard'
import { Amount } from '../components/Amount'

export function Wallets({ preset }: { preset?: WizardPreset } = {}) {
  const [wallets, setWallets] = useState<Wallet[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(!!preset?.choice)

  const load = () => walletApi.list().then((w) => { setWallets(w); setError(null) }).catch((e) => setError(e.message))
  useEffect(() => { load() }, [])

  // sum in integer sats (no float drift), back to BTC for display
  const total = Number((wallets ?? []).reduce((s, w) => s + BigInt(Math.round((w.balance?.total ?? 0) * 1e8)), 0n)) / 1e8
  const net = wallets?.[0]?.network ?? 'regtest'

  return (
    <main className="page">
      <section className="page-head">
        <div>
          <span className="eyebrow">Wallets</span>
          <h2 className="page-title"><Amount btc={total} digits={4} variant="title" network={net} testId="wallets-total" /></h2>
          <p className="muted">Total across {wallets?.length ?? 0} wallet{wallets?.length === 1 ? '' : 's'} · {net}</p>
        </div>
        <button className="btn primary" onClick={() => setCreating(true)}>＋ New wallet</button>
      </section>

      {error && <div className="glass alert" role="alert">⚠ {error}</div>}

      {wallets && wallets.length === 0 && (
        <div className="glass card empty">
          <div className="empty-icon">⛬</div>
          <h3>No wallets yet</h3>
          <p className="muted">Start with a 2-of-3 multisig vault. Any two keys can move funds, so one lost key never locks the trust.</p>
          <button className="btn primary" onClick={() => setCreating(true)}>Create 2-of-3 vault</button>
        </div>
      )}

      <div className="wallet-grid">
        {wallets?.map((w, i) => (
          <button key={w.id} className={`glass card wallet-card type-${w.type}`} style={{ animationDelay: `${i * 60}ms` }}
            onClick={() => navigate(`/wallets/${w.id}`)} data-testid="wallet-card">
            <div className="wc-head">
              <span className={`kind kind-${w.type}`}>{walletKind(w)}</span>
              {w.cosigners.some((c) => c.kind === 'hardware') && <span className="badge badge-hw">⌁ Hardware</span>}
              {!w.canSign && !w.signable && w.type !== 'watchonly' && <span className="badge badge-planned">View only</span>}
            </div>
            <div className="wc-name">{w.name}</div>
            <div className="wc-balance">{w.balance ? <Amount btc={w.balance.total} digits={4} variant="card" interactive={false} network={w.network} /> : <>— <small>BTC</small></>}</div>
            {w.balance && w.balance.immature > 0 && <div className="wc-sub muted">+<Amount btc={w.balance.immature} digits={4} interactive={false} /> immature</div>}
            <div className="wc-keys">
              {w.cosigners.slice(0, 15).map((c, j) => (
                <span key={j} className={`key-dot kd-${c.kind}`} title={`${c.label} · ${c.fingerprint}`}>{initial(c.label)}</span>
              ))}
            </div>
          </button>
        ))}
      </div>

      {wallets && wallets.length > 0 && (
        <section className="assurances">
          {[
            ['🔐', 'Keys stay in bitcoind', 'Cosigner private keys live in separate regtest wallets. The API only ever returns xpubs and descriptors.'],
            ['✍️', 'PSBT-native signing', 'Every spend is a BIP-174 PSBT, so cosigners sign independently and signatures combine before broadcast.'],
            ['🛡️', 'Survives a lost key', 'With 2-of-3, any single key can be lost or stolen without losing or moving the funds.'],
          ].map(([icon, title, desc], i) => (
            <div key={title} className="glass card assurance" style={{ animationDelay: `${200 + i * 80}ms` }}>
              <span className="a-icon">{icon}</span>
              <div><strong>{title}</strong><p className="muted">{desc}</p></div>
            </div>
          ))}
        </section>
      )}

      {creating && (
        <Modal title="Create wallet" onClose={() => setCreating(false)} wide>
          <CreateWalletWizard preset={preset} onCancel={() => { setCreating(false); if (preset) navigate('/wallets') }} onCreated={(w) => { setCreating(false); navigate(`/wallets/${w.id}`) }} />
        </Modal>
      )}
    </main>
  )
}
