import type { Stage } from '../lib/api'

export const DEFAULT_STAGES: Stage[] = [
  { id: 0, title: 'Foundation', description: 'Bitcoin Core on regtest, repo scaffold', status: 'complete' },
  { id: 1, title: 'Node Dashboard', description: 'Live chain stats via JSON-RPC', status: 'complete' },
  { id: 2, title: 'Multisig Wallet', description: '2-of-3 P2WSH descriptor wallet', status: 'complete' },
  { id: 3, title: 'Hardware Wallets', description: 'PSBT + HWI support', status: 'complete' },
  { id: 4, title: 'Trust Vault', description: 'Encrypted trust documentation', status: 'complete' },
  { id: 5, title: 'Trustee Messaging', description: 'Private trustee channel', status: 'planned' },
  { id: 6, title: 'Timeline & Goals', description: 'Economy milestones + white paper', status: 'planned' },
]

const LABEL = { complete: 'Complete', 'in-progress': 'In progress', planned: 'Planned' } as const

export function StageTracker({ stages }: { stages: Stage[] }) {
  const done = stages.filter((s) => s.status === 'complete').length
  const pct = stages.length ? Math.round((done / stages.length) * 100) : 0
  return (
    <div className="glass card stages">
      <div className="card-title">
        <h2>Build progress</h2>
        <span className="pill" data-testid="stage-count">{done}/{stages.length} stages</span>
      </div>
      <div className="bar"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>
      <ol className="stage-list">
        {stages.map((s) => (
          <li key={s.id} className={`stage stage-${s.status}`} data-testid={`stage-${s.id}`}>
            <span className="stage-dot">{s.status === 'complete' ? '✓' : s.id}</span>
            <div className="stage-body">
              <div className="stage-title">Stage {s.id} · {s.title}</div>
              <div className="stage-desc">{s.description}</div>
            </div>
            <span className={`badge badge-${s.status}`}>{LABEL[s.status]}</span>
          </li>
        ))}
      </ol>
    </div>
  )
}
