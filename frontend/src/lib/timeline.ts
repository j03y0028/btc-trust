export interface FredPoint { date: string; value: number }
export interface Series { id: string; title: string; units: string; frequency: string; seasonal: string; kind: 'rate' | 'level'; fetchedAt: string; csvUrl: string; sourceUrl: string; points: FredPoint[]; stale?: boolean; error?: string }
export interface TimelineEvent { date: string; kind: 'us' | 'bitcoin'; title: string; detail: string; citation: string; source: string }
export interface Reference {
  fetchedAt: string; source: string
  genesis: { hash: string; time: number; timeISO: string; headline: string | null; coinbaseTxid: string; checks: Record<string, boolean>; verified: boolean }
  halvings: { height: number; hash: string; time: number; timeISO: string; verified: boolean }[]
}
export interface Whitepaper { title: string; author: string; date: string; url: string; announcement: string; sha256: string; localPath: string; bundled: boolean; matches: boolean; bytes: number }
export interface TimelineData { series: Series[]; events: TimelineEvent[]; reference: Reference | null; whitepaper: Whitepaper; errors: string[] }
export interface SourceTip { name: string; ok: boolean; height?: number; hash?: string; time?: number; difficulty?: number; latencyMs?: number; error?: string }
export interface Snapshot {
  date: string; takenAt: string; height: number; hash: string; time: number; timeISO: string; difficulty: number; primary: string
  check: { status: 'agree' | 'disagree' | 'single-source' | 'unavailable'; lagBlocks: number; notes: string[] }; sources: SourceTip[]
}
export interface DailyData {
  snapshots: Snapshot[]; latest: Snapshot | null; today: string; hasToday: boolean; streakDays: number; growing: boolean
  blocksSinceGenesis: number | null; daysSinceWhitepaper: number; daysSinceGenesis: number | null
  nextHalving: { target: number; remaining: number; avgBlockSeconds: number; estimatedTime: number; naiveTime: number } | null
  halvings: Reference['halvings']; genesis: { hash: string; time: number } | null; nodeConfigured: boolean; sources: string[]; fallbacks?: string[]
}
export interface StageProgress {
  id: number; title: string; status: string; achievements: string[]
  commit: { hash: string; short: string; date: string; subject: string } | null
  tests: { backend: number; frontend: number; source: string } | null
}
export interface ProgressData { stages: StageProgress[]; head: string | null; dirty: boolean; backlog: { title: string; detail: string }[] }

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, init)
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`)
  return body as T
}
export const timelineApi = {
  timeline: () => req<TimelineData>('/api/timeline'),
  refresh: () => req<TimelineData>('/api/timeline/refresh', { method: 'POST' }),
  daily: () => req<DailyData>('/api/mainnet/daily'),
  snapshot: () => req<{ created: boolean; snapshot: Snapshot }>('/api/mainnet/snapshot', { method: 'POST' }),
  progress: () => req<ProgressData>('/api/progress'),
}

export const TZ = 'America/Phoenix'
export const fmtTime = (ms: number) => new Date(ms).toLocaleString('en-US', { timeZone: TZ, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
export const fmtDate = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
export const fmtDiff = (d: number) => d >= 1e12 ? `${(d / 1e12).toFixed(2)} T` : d >= 1e9 ? `${(d / 1e9).toFixed(2)} G` : d >= 1e6 ? `${(d / 1e6).toFixed(2)} M` : d.toLocaleString('en-US')

export const SERIES_STYLE: Record<string, { color: string; short: string }> = {
  CPIAUCSL: { color: '#ff8a5c', short: 'CPI' },
  M2SL: { color: '#3dd6f5', short: 'M2' },
  GDP: { color: '#3ee59a', short: 'GDP' },
  FEDFUNDS: { color: '#ffd166', short: 'Fed funds' },
  UNRATE: { color: '#9b7bff', short: 'Unemployment' },
}
export const BASE_MONTH = '2008-10' // white paper month

export interface Row { t: number; month: string; [k: string]: number | string | null }
/**
 * Merge FRED series into monthly rows. Levels (CPI, M2, GDP) are rebased to Oct 2008 = 100 (white-paper month);
 * rates (fed funds, unemployment) stay in percent. Raw values are kept as `<ID>_raw` for the tooltip.
 */
export function buildRows(series: Series[]): Row[] {
  const rows = new Map<string, Row>()
  for (const s of series) {
    const base = s.points.find((p) => p.date.slice(0, 7) >= BASE_MONTH)?.value
    for (const p of s.points) {
      const month = p.date.slice(0, 7)
      const row = rows.get(month) ?? { t: Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1), month }
      row[`${s.id}_raw`] = p.value
      row[s.id] = s.kind === 'rate' || !base ? p.value : +(p.value / base * 100).toFixed(2)
      rows.set(month, row)
    }
  }
  return [...rows.values()].sort((a, b) => a.t - b.t)
}
