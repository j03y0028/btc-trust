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
