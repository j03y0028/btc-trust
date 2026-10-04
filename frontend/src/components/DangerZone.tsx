import { useState } from 'react'
import { ApiError, btc, walletApi, type DeleteImpact } from '../lib/api'
import { Modal } from './Modal'

/** Delete a TEST wallet (regtest only): impact preview, type-the-name confirmation, explicit acknowledgement. */
export function DangerZone({ id, name, network, onDeleted }: { id: string; name: string; network: string; onDeleted: () => void }) {
  const [open, setOpen] = useState(false)
  const [impact, setImpact] = useState<DeleteImpact | null>(null)
  const [typed, setTyped] = useState('')
  const [ack, setAck] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const regtest = network === 'regtest'

  const start = async () => {
    setOpen(true); setTyped(''); setAck(false); setError(null); setImpact(null)
    try { setImpact(await walletApi.deleteCheck(id)) } catch (e) { setError((e as Error).message) }
  }
  const matches = typed.trim() === name
  const canDelete = !!impact?.deletable && matches && (!impact.needsAcknowledge || ack) && !busy
  const doDelete = async () => {
    setBusy(true); setError(null)
    try { await walletApi.remove(id, typed.trim(), ack); setOpen(false); onDeleted() }
    catch (e) { setError(e instanceof ApiError || e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }

  return (
    <section className="glass card danger-zone" aria-labelledby="dz-title">
      <div className="dz-body">
        <div>
          <h2 id="dz-title">Danger zone</h2>
          <p className="muted small">
            {regtest
              ? 'Delete this test wallet from BTC Trust. Its regtest coins are worthless test coins.'
              : `Deleting is only available for regtest test wallets. This wallet is on ${network}.`}
          </p>
        </div>
        <button className="btn danger-solid" onClick={start} disabled={!regtest} data-testid="delete-wallet">Delete test wallet</button>
      </div>

      {open && (
        <Modal title="Delete test wallet" onClose={() => !busy && setOpen(false)}>
          <div className="dz-modal">
            <div className="dz-warning" role="note">
              <strong>This cannot be undone.</strong> “{name}” is a <b>{network}</b> test wallet. It will disappear from BTC Trust and its
              wallets on the bundled test node will be unloaded. Your myNode and mainnet are never touched.
            </div>
            {!impact && !error && <div className="muted small">Checking what this wallet is linked to…</div>}
            {impact && !impact.deletable && <div className="glass alert" role="alert">⚠ {impact.reason}</div>}
            {impact && impact.deletable && (
              <ul className="dz-impact">
                <li><span>Test balance</span><b>{impact.balance ? `${btc(impact.balance.total, 8)} BTC (test coins)` : 'unknown'}</b></li>
                <li><span>Trust vault</span><b>{impact.vault ? 'Yes, will be archived' : 'None'}</b></li>
                <li><span>Open signature requests</span><b>{impact.openSigRequests}</b></li>
                <li><span>Messages · trustees</span><b>{impact.messages} · {impact.trustees}</b></li>
                <li><span>Test-node wallets to unload</span><b>{impact.bitcoindWallets.length}</b></li>
              </ul>
            )}
            {impact?.deletable && impact.needsAcknowledge && (
              <label className="dz-ack">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>
                  I understand that {[impact.vault && 'the encrypted trust vault', impact.openSigRequests > 0 && `${impact.openSigRequests} open signature request(s)`].filter(Boolean).join(' and ')} will
                  be removed from the app with this wallet (moved to an archive folder in the app data, not shown in BTC Trust again).
                </span>
              </label>
            )}
            {impact?.deletable && (
              <label className="dz-confirm">
                <span>Type <code>{name}</code> to confirm</span>
                <input aria-label="Type the wallet name to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false}
                  onKeyDown={(e) => { if (e.key === 'Enter' && canDelete) doDelete() }} />
              </label>
            )}
            {error && <div className="field-error" role="alert">{error}</div>}
            <div className="dz-actions">
              <button className="btn ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
              <button className="btn danger-solid" onClick={doDelete} disabled={!canDelete} data-testid="confirm-delete">
                {busy ? 'Deleting…' : 'Delete this test wallet'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  )
}
