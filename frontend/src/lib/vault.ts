import { ApiError } from './api'

export type DocType = 'deed' | 'beneficiaries' | 'trustees' | 'succession' | 'descriptor-backup' | 'note'
export const DOC_META: Record<DocType, { label: string; icon: string; blurb: string }> = {
  deed: { label: 'Trust deed', icon: '📜', blurb: 'Agreement establishing the trust' },
  beneficiaries: { label: 'Beneficiaries', icon: '👪', blurb: 'Who benefits and in what share' },
  trustees: { label: 'Trustees', icon: '🛡', blurb: 'Roles and cosigner key mapping' },
  succession: { label: 'Succession & recovery', icon: '🧭', blurb: 'What happens if a key or person is lost' },
  'descriptor-backup': { label: 'Descriptor backup', icon: '🧾', blurb: 'Public wallet data, never private keys' },
  note: { label: 'Note', icon: '🗒', blurb: 'Free-form notes and attachments' },
}
export const DOC_ORDER = Object.keys(DOC_META) as DocType[]

export interface SecondFactorInfo { cosigner: number; label: string; kind: string; address: string }
export interface VaultStatus {
  exists: boolean; unlocked: boolean; idleMs: number; createdAt?: string; updatedAt?: string; expiresInMs?: number
  kdf?: { name: string; N: number; r: number; p: number }; cipher?: string; secondFactor: SecondFactorInfo | null
}
export interface Challenge { id: string; message: string; address: string; cosigner: number; label: string; kind: string; path: string; expiresAt: string }
export type UnlockResult = { unlocked: true; session: string; idleMs: number } | { unlocked: false; challenge: Challenge }
export interface Anchor { txid: string; hash: string; anchoredAt: string }
export interface Version { v: number; createdAt: string; content: string; sha256: string; size: number; anchor?: Anchor; verified: boolean }
export interface Attachment { id: string; name: string; mime: string; size: number; sha256: string; createdAt: string }
export interface Doc { id: string; type: DocType; title: string; createdAt: string; updatedAt: string; versions: Version[]; attachments: Attachment[] }
export interface DocSummary { id: string; type: DocType; title: string; createdAt: string; updatedAt: string; versions: number; latest: { v: number; sha256: string; size: number; anchored: boolean }; attachments: number }
export interface AnchorCheck {
  v: number; txid: string; hash: string; opReturn: string; onChain: boolean; contentOk: boolean; valid: boolean
  confirmations: number; blockHash: string | null; height: number | null; blockTime: number | null; anchoredAt: string
}
export interface Template { type: DocType; title: string; content: string }

// Session tokens live in memory only: a reload locks the vault.
const sessions = new Map<string, string>()
const listeners = new Set<(walletId: string) => void>()
export const vaultSession = {
  get: (w: string) => sessions.get(w),
  set: (w: string, t: string) => { sessions.set(w, t) },
  clear: (w: string) => { sessions.delete(w); listeners.forEach((l) => l(w)) },
  onLocked: (fn: (walletId: string) => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
}

async function call<T>(walletId: string, path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) }
  const t = sessions.get(walletId)
  if (t) headers['x-vault-session'] = t
  let body = init.body
  if (init.json !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(init.json) }
  const r = await fetch(`/api/vaults/${walletId}${path}`, { ...init, headers, body })
  if (!r.ok) {
    const data = await r.json().catch(() => ({}))
    if (r.status === 401 && data.details?.code === 'VAULT_LOCKED' && t) vaultSession.clear(walletId)
    throw new ApiError(data.error ?? `HTTP ${r.status}`, r.status, data.details)
  }
  return r.json() as Promise<T>
}
const post = <T>(w: string, path: string, json: unknown = {}) => call<T>(w, path, { method: 'POST', json })

export const vaultApi = {
  status: (w: string) => call<VaultStatus>(w, '/status'),
  create: (w: string, passphrase: string, secondFactor?: { cosigner: number; address?: string } | null) =>
    post<{ unlocked: true; session: string; idleMs: number }>(w, '', { passphrase, secondFactor }),
  unlock: (w: string, passphrase: string) => post<UnlockResult>(w, '/unlock', { passphrase }),
  signChallenge: (w: string, challengeId: string) => post<{ signature: string; signer: 'node' | 'device' }>(w, '/unlock/sign', { challengeId }),
  verifyChallenge: (w: string, challengeId: string, signature: string) => post<{ unlocked: true; session: string; idleMs: number }>(w, '/unlock/verify', { challengeId, signature }),
  lock: (w: string) => post<{ locked: boolean }>(w, '/lock'),
  ping: (w: string) => post<VaultStatus>(w, '/ping'),
  list: (w: string) => call<DocSummary[]>(w, '/documents'),
  get: (w: string, id: string) => call<Doc>(w, `/documents/${id}`),
  template: (w: string, type: DocType) => call<Template>(w, `/templates/${type}`),
  createDoc: (w: string, doc: { type: DocType; title: string; content: string }) => post<Doc>(w, '/documents', doc),
  updateDoc: (w: string, id: string, patch: { title?: string; content?: string }) => call<Doc>(w, `/documents/${id}`, { method: 'PUT', json: patch }),
  deleteDoc: (w: string, id: string) => call<{ deleted: string }>(w, `/documents/${id}`, { method: 'DELETE' }),
  verifyVersion: (w: string, id: string, v: number) => call<{ v: number; sha256: string; recomputed: string; valid: boolean }>(w, `/documents/${id}/versions/${v}/verify`),
  anchor: (w: string, id: string, v: number) => post<AnchorCheck>(w, `/documents/${id}/versions/${v}/anchor`),
  verifyAnchor: (w: string, id: string, v: number) => call<AnchorCheck>(w, `/documents/${id}/versions/${v}/anchor`),
  upload: (w: string, id: string, file: File) =>
    call<Attachment>(w, `/documents/${id}/attachments`, { method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) } }),
  download: async (w: string, id: string, attId: string): Promise<Blob> => {
    const r = await fetch(`/api/vaults/${w}/documents/${id}/attachments/${attId}`, { headers: { 'x-vault-session': sessions.get(w) ?? '' } })
    if (!r.ok) { const d = await r.json().catch(() => ({})); throw new ApiError(d.error ?? `HTTP ${r.status}`, r.status, d.details) }
    return r.blob()
  },
  changePassphrase: (w: string, current: string, next: string) => post<{ changed: boolean }>(w, '/passphrase', { current, next }),
  setSecondFactor: (w: string, passphrase: string, secondFactor: { cosigner: number; address?: string } | null) => post<VaultStatus>(w, '/second-factor', { passphrase, secondFactor }),
  backup: (w: string) => call<Record<string, unknown>>(w, '/backup'),
  restore: (w: string, backup: unknown, passphrase: string, overwrite = false) =>
    post<{ restored: true; documents: number; attachments: number; session: string; idleMs: number }>(w, '/restore', { backup, passphrase, overwrite }),
}

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
export const mmss = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }
