export interface AuthStatus { required: boolean; configured: boolean; authenticated: boolean; setupTokenRequired: boolean; minLength: number }

export const AUTH_EVENT = 'btctrust:auth-required'

async function send(path: string, body: unknown = {}) {
  const r = await fetch(`/api/auth/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw Object.assign(new Error(j.error ?? `HTTP ${r.status}`), { status: r.status })
  return j
}

export const authApi = {
  status: async (): Promise<AuthStatus> => {
    const r = await fetch('/api/auth/status')
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return r.json()
  },
  setup: (passphrase: string, setupToken: string) => send('setup', { passphrase, setupToken }),
  login: (passphrase: string) => send('login', { passphrase }),
  logout: () => send('logout'),
  change: (current: string, next: string) => send('passphrase', { current, next }),
}

/** Any /api response marked x-auth-required (session expired, server restarted) sends the app back to the login screen. */
export function installAuthInterceptor() {
  const orig = window.fetch.bind(window)
  window.fetch = async (...args: Parameters<typeof fetch>) => {
    const r = await orig(...args)
    if (r.status === 401 && r.headers.get('x-auth-required') === '1') window.dispatchEvent(new Event(AUTH_EVENT))
    return r
  }
}
