import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { AUTH_EVENT, authApi, type AuthStatus } from '../lib/auth'
import { StrengthMeter } from './VaultParts'

const OPEN: AuthStatus = { required: false, configured: false, authenticated: true, setupTokenRequired: false, minLength: 12 }

/** App login (myNode / any non-localhost deployment): first-run setup, then passphrase login. */
export function AuthGate({ children }: { children: (s: { status: AuthStatus; logout: () => void }) => ReactNode }) {
  const [status, setStatus] = useState<AuthStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  // If the status endpoint is unreachable (older API, offline), render the app: the server enforces the login on every
  // /api call anyway, and a 401 there sends us back here through AUTH_EVENT.
  const check = useCallback(() => authApi.status().then((s) => { setStatus(s && typeof s === 'object' && 'required' in s ? s : OPEN); setError(null) }).catch((e) => { setError((e as Error).message); setStatus((s) => s ?? OPEN) }), [])
  useEffect(() => {
    check()
    window.addEventListener(AUTH_EVENT, check)
    return () => window.removeEventListener(AUTH_EVENT, check)
  }, [check])
  const logout = useCallback(() => { authApi.logout().finally(check) }, [check])
  if (!status) return <div className="login-wrap"><div className="glass card login">{error ? <p className="form-error">⚠ Cannot reach the app: {error}</p> : <p className="muted">Connecting…</p>}</div></div>
  if (!status.required || status.authenticated) return <>{children({ status, logout })}</>
  return <LoginScreen status={status} onDone={check} />
}

function LoginScreen({ status, onDone }: { status: AuthStatus; onDone: () => void }) {
  const setup = !status.configured
  const [token, setToken] = useState('')
  const [pass, setPass] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const valid = setup ? token.trim().length > 0 && pass.length >= status.minLength && pass === confirm : pass.length > 0
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null)
    try {
      if (setup) await authApi.setup(pass, token.trim())
      else await authApi.login(pass)
      setPass(''); setConfirm(''); onDone()
    } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="login-wrap">
      <div className="bg-orbs" aria-hidden><span /><span /><span /></div>
      <form className="glass card login" onSubmit={submit} data-testid={setup ? 'login-setup' : 'login'}>
        <div className="login-brand"><div className="logo">₿</div><div><h1>BTC Trust</h1><p className="muted">Sovereign family trust</p></div></div>
        <h2>{setup ? 'Set the app passphrase' : 'Sign in'}</h2>
        <p className="muted small">
          {setup
            ? <>First run on this node. Enter the one-time <b>setup token</b> shown on the myNode app page (App Default Credentials) or in <code>/mnt/hdd/mynode/btctrust/setup-token</code>, then choose a passphrase for everyone who uses this app.</>
            : <>This app is reachable from your network, so it needs the app passphrase. Vault documents and trustee keys stay separately encrypted.</>}
        </p>
        {setup && <>
          <label className="field-label" htmlFor="lg-token">Setup token</label>
          <input id="lg-token" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="one-time-code" spellCheck={false} autoFocus />
        </>}
        <label className="field-label" htmlFor="lg-pass">{setup ? 'New app passphrase' : 'App passphrase'}</label>
        <input id="lg-pass" type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete={setup ? 'new-password' : 'current-password'} autoFocus={!setup} />
        {setup && <>
          <StrengthMeter value={pass} />
          <label className="field-label" htmlFor="lg-confirm">Confirm passphrase</label>
          <input id="lg-confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
          {confirm && pass !== confirm && <span className="field-error">Passphrases don’t match</span>}
          {pass && pass.length < status.minLength && <span className="hint">At least {status.minLength} characters</span>}
        </>}
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="btn primary" disabled={!valid || busy}>{busy ? (setup ? 'Saving…' : 'Checking…') : setup ? 'Set passphrase & sign in' : 'Sign in'}</button>
        <div className="kg-spec">
          <span>scrypt-hashed on the node</span><span>HttpOnly session cookie</span><span>locks out after 5 wrong tries</span>
        </div>
      </form>
    </div>
  )
}
