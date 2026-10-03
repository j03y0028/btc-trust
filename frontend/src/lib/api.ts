export interface ChainSummary {
  network: string
  height: number
  headers: number
  bestBlockHash: string
  difficulty: number
  verificationProgress: number
  syncProgressPct: number
  initialBlockDownload: boolean
  sizeOnDisk: number
  pruned: boolean
  mempool: { size: number; bytes: number; usage: number; totalFeeBtc: number }
  node: { version: number; subversion: string; connections: number }
  timestamp: string
}
export interface BlockSummary {
  height: number; hash: string; time: number; txCount: number; size: number; weight: number; difficulty: number
}
export type StageStatus = 'complete' | 'in-progress' | 'planned'
export interface Stage { id: number; title: string; description: string; status: StageStatus }

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path)
  if (!r.ok) {
    const body = await r.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${r.status}`)
  }
  return r.json() as Promise<T>
}

export const api = {
  blockchain: () => get<ChainSummary>('/api/blockchain'),
  blocks: (count = 8) => get<BlockSummary[]>(`/api/blocks?count=${count}`),
  stages: () => get<Stage[]>('/api/stages'),
}

export const fmt = {
  int: (n: number) => n.toLocaleString('en-US'),
  bytes: (b: number) => {
    const u = ['B', 'KB', 'MB', 'GB', 'TB']
    let i = 0
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++ }
    return `${b.toFixed(i ? 1 : 0)} ${u[i]}`
  },
  diff: (d: number) => {
    if (d > 0 && d < 0.001) return d.toExponential(3)
    if (d < 1000) return String(Number(d.toPrecision(4)))
    const u = ['', 'K', 'M', 'G', 'T', 'P', 'E']
    let i = 0
    while (d >= 1000 && i < u.length - 1) { d /= 1000; i++ }
    return `${d.toFixed(2)} ${u[i]}`
  },
  hash: (h: string, n = 10) => `${h.slice(0, n)}…${h.slice(-n)}`,
  ago: (unix: number, now = Date.now()) => {
    const s = Math.max(0, Math.round(now / 1000 - unix))
    if (s < 60) return `${s}s ago`
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    return `${Math.floor(s / 86400)}d ago`
  },
}

// ---------------- Wallets ----------------
export type WalletType = 'multisig' | 'singlesig' | 'watchonly'
export type SignerKind = 'software' | 'hardware' | 'airgapped'
export interface Cosigner { label: string; fingerprint: string; key: string; local: boolean; kind: SignerKind; device?: { type: string; model: string; label: string | null } }
export interface Balance { confirmed: number; pending: number; immature: number; total: number }
export interface Wallet {
  id: string; name: string; type: WalletType; network: string; m: number; n: number; watchWallet: string
  descriptors: { receive: string; change?: string }; cosigners: Cosigner[]; canSign: boolean; signable?: boolean; createdAt: string
  balance?: Balance | null
}
export interface HistoryItem { txid: string; type: 'sent' | 'received' | 'mined'; amount: number; fee: number; confirmations: number; time: number; addresses: string[] }
export interface Utxo { txid: string; vout: number; address: string; amount: number; confirmations: number }
export interface WalletDetail extends Wallet {
  balance: Balance; utxos: Utxo[]; addresses: { address: string; received: number; txCount: number }[]; history: HistoryItem[]
}
export interface PsbtInfo {
  psbt: string; txid: string; fee: number | null; required: number; signatures: number; signedBy: string[]; complete: boolean
  inputs: number; outputs: { address: string; amount: number; isChange: boolean }[]
}
export interface SignResult extends PsbtInfo {
  signer: { index: number; label: string; kind: SignerKind; fallback: boolean; reason?: string }
}
export interface CreateWalletInput {
  name: string; type: WalletType; m?: number; n?: number; cosignerLabels?: string[]; externalKeys?: string[]; descriptor?: string; xpub?: string
  hardware?: { fingerprint: string; label?: string }[]
}
export interface HwDevice {
  type: string; model: string; path: string; label: string | null; fingerprint: string | null
  needsPin: boolean; needsPassphrase: boolean; error: string | null; emulator: boolean
}
export interface HwStatus { available: boolean; mode: 'hwi' | 'mock' | 'off'; version: string | null }
export class ApiError extends Error {
  status: number
  details?: Record<string, unknown>
  constructor(message: string, status: number, details?: Record<string, unknown>) { super(message); this.status = status; this.details = details }
}

async function post<T>(path: string, body: unknown = {}): Promise<T> {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(data.error ?? `HTTP ${r.status}`, r.status, data.details)
  return data as T
}

export const walletApi = {
  list: () => get<Wallet[]>('/api/wallets'),
  create: (input: CreateWalletInput) => post<Wallet>('/api/wallets', input),
  get: (id: string) => get<WalletDetail>(`/api/wallets/${id}`),
  newAddress: (id: string) => post<{ address: string }>(`/api/wallets/${id}/address`),
  createPsbt: (id: string, outputs: { address: string; amount: number }[], feeRate?: number) =>
    post<PsbtInfo>(`/api/wallets/${id}/psbt`, { outputs, feeRate }),
  decode: (id: string, psbt: string) => post<PsbtInfo>(`/api/wallets/${id}/psbt/decode`, { psbt }),
  sign: (id: string, psbt: string, cosigner?: number, fallback = false) => post<SignResult>(`/api/wallets/${id}/psbt/sign`, { psbt, cosigner, fallback }),
  exportPsbt: async (id: string, psbt: string): Promise<{ blob: Blob; filename: string }> => {
    const r = await fetch(`/api/wallets/${id}/psbt/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ psbt }) })
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
    const filename = r.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'transaction.psbt'
    return { blob: await r.blob(), filename }
  },
  importPsbt: async (id: string, data: ArrayBuffer | string, base?: string): Promise<PsbtInfo> => {
    const q = base ? `?base=${encodeURIComponent(base)}` : ''
    const isBin = typeof data !== 'string'
    const r = await fetch(`/api/wallets/${id}/psbt/import${q}`, { method: 'POST', headers: { 'content-type': isBin ? 'application/octet-stream' : 'text/plain' }, body: data })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new ApiError(j.error ?? `HTTP ${r.status}`, r.status, j.details)
    return j as PsbtInfo
  },
  verifyAddress: (id: string, cosigner: number, address: string) =>
    post<{ index: number; expected: string; deviceAddress: string; match: boolean }>(`/api/wallets/${id}/verify-address`, { cosigner, address }),
  combine: (id: string, psbts: string[]) => post<PsbtInfo>(`/api/wallets/${id}/psbt/combine`, { psbts }),
  broadcast: (id: string, psbt: string) => post<{ txid: string }>(`/api/wallets/${id}/psbt/broadcast`, { psbt }),
  mine: (blocks: number, walletId?: string) => post<{ blocks: number }>('/api/regtest/mine', { walletId, blocks }),
  fund: (walletId: string, amount: number) => post<{ txid: string }>('/api/regtest/fund', { walletId, amount }),
}

export const btc = (n: number, digits = 8) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: digits })
export const walletKind = (w: Pick<Wallet, 'type' | 'm' | 'n'>) =>
  w.type === 'multisig' ? `${w.m}-of-${w.n} Multisig` : w.type === 'singlesig' ? 'Single-sig' : w.n > 1 ? `Watch-only ${w.m}-of-${w.n}` : 'Watch-only'

export const initial = (label: string) => label.replace(/^(Key|Cosigner) (?=\S)/, '').slice(0, 1).toUpperCase()

export const deviceApi = {
  status: () => get<HwStatus>('/api/devices/status'),
  list: (refresh = false) => get<HwDevice[]>(`/api/devices${refresh ? '?refresh=1' : ''}`),
  xpub: (fingerprint: string, purpose: 'multisig' | 'singlesig') =>
    post<{ fingerprint: string; path: string; xpub: string; key: string }>(`/api/devices/${fingerprint}/xpub`, { purpose }),
}

export const KIND_LABEL: Record<SignerKind, string> = { hardware: 'Hardware', software: 'Software', airgapped: 'Air-gapped' }

export function deviceName(d: Pick<HwDevice, 'type' | 'model' | 'emulator'>) {
  const brand: Record<string, string> = { trezor: 'Trezor', ledger: 'Ledger', coldcard: 'Coldcard', bitbox02: 'BitBox02', keepkey: 'KeepKey', jade: 'Jade', mock: 'Mock' }
  const model = d.model.replace(/_simulator$/, '').replace(/^trezor_/, 'Model ').replace(/^ledger_/, '').replace(/_/g, ' ')
  const name = `${brand[d.type] ?? d.type} ${model.replace(/^model t$/i, 'Model T').replace(/^mock device$/, 'Signer')}`.trim()
  return d.emulator ? `${name} · Emulator` : name
}
