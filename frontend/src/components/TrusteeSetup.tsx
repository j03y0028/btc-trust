import { useState } from 'react'
import type { Wallet } from '../lib/api'
import { N, enrollTrustee, keyring, msgApi, type DirectoryEntry, type SecretIdentity } from '../lib/messaging'
import { newIdentity, signDetached } from '../../../shared/msgcrypto'
import { KindBadge } from './KindBadge'

interface Offline { entry: DirectoryEntry; address: string; id?: SecretIdentity; statement?: string; issuedAt?: string; sig: string }

/** Enroll a trustee on this device: browser-generated keys, bound to the cosigner with a signmessage attestation. */
export function TrusteeSetup({ wallet, dir, onDone }: { wallet: Wallet; dir: DirectoryEntry[]; onDone: (fp: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [offline, setOffline] = useState<Offline | null>(null)

  const run = async (fp: string, fn: () => Promise<void>) => { setBusy(fp); setError(null); try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(null) } }
  const done = (fp: string) => { keyring.setActing(wallet.id, fp); onDone(fp) }
  const enroll = (d: DirectoryEntry) => d.kind === 'airgapped'
    ? setOffline({ entry: d, address: '', sig: '' })
    : run(d.fingerprint, async () => { await enrollTrustee(wallet.id, d.cosigner, d.fingerprint); done(d.fingerprint) })
  const prepare = (o: Offline) => run(o.entry.fingerprint, async () => {
    const id = newIdentity(N, o.entry.fingerprint)
    const p = await msgApi.prepare(wallet.id, o.entry.cosigner, id, o.address.trim())
    setOffline({ ...o, id, statement: p.statement, issuedAt: p.issuedAt })
  })
  const submit = (o: Offline) => run(o.entry.fingerprint, async () => {
    await msgApi.register(wallet.id, { cosigner: o.entry.cosigner, signPub: o.id!.signPub, boxPub: o.id!.boxPub, issuedAt: o.issuedAt, btcSignature: o.sig.trim(), popSignature: signDetached(N, o.id!, o.statement!), address: o.address.trim() })
    keyring.put(wallet.id, o.id!); setOffline(null); done(o.entry.fingerprint)
  })

  return (
    <div className="trustee-setup" data-testid="trustee-setup">
      <p className="muted small">Each trustee gets an Ed25519 signing key and an X25519 encryption key, generated in this browser. Their cosigner key signs a statement binding them (Bitcoin signmessage, the same as the vault second factor). Other trustees see a ✓ verified badge and a safety number they can compare in person.</p>
      <ul className="setup-list">
        {dir.map((d) => {
          const local = !!keyring.get(wallet.id, d.fingerprint)
          return (
            <li key={d.fingerprint} className="setup-row">
              <span className="avatar">{d.label.slice(0, 1).toUpperCase()}</span>
              <div className="cos-body"><strong>{d.label}</strong><span className="muted small"><code>{d.fingerprint}</code> <KindBadge kind={d.kind as 'software'} /></span></div>
              {d.identity && local ? <span className="verified-badge">✓ On this device</span>
                : <button className="btn small" disabled={!!busy} onClick={() => enroll(d)} data-testid={`enroll-${d.fingerprint}`}>
                    {busy === d.fingerprint ? (d.kind === 'hardware' ? 'Confirm on device…' : 'Attesting…') : d.identity ? 'Re-key on this device' : d.kind === 'hardware' ? '⌁ Attest with device' : d.kind === 'airgapped' ? '✈ Attest offline' : '✍ Attest with node key'}
                  </button>}
            </li>
          )
        })}
      </ul>
      {offline && (
        <div className="form restore">
          {!offline.statement ? (
            <>
              <label>P2PKH address {offline.entry.label}'s offline wallet signs messages with<input value={offline.address} onChange={(e) => setOffline({ ...offline, address: e.target.value })} placeholder="m… / n…" /></label>
              <div className="row-actions"><button className="btn small" disabled={!offline.address.trim() || !!busy} onClick={() => prepare(offline)}>Prepare statement</button><button className="btn small ghost" onClick={() => setOffline(null)}>Cancel</button></div>
            </>
          ) : (
            <>
              <span className="field-label">Sign this exact text (signmessage) with {offline.address}</span>
              <pre className="challenge-msg">{offline.statement}</pre>
              <textarea rows={2} value={offline.sig} onChange={(e) => setOffline({ ...offline, sig: e.target.value })} placeholder="Signature (base64)" />
              <button className="btn small" disabled={!offline.sig.trim() || !!busy} onClick={() => submit(offline)}>Submit attestation</button>
            </>
          )}
        </div>
      )}
      {error && <div className="form-error" role="alert">{error}</div>}
      <p className="hint">Testing tip: on this regtest node you can enroll several trustees here and switch between them with “Acting as”.</p>
    </div>
  )
}
