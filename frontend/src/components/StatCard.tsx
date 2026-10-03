import type { ReactNode } from 'react'

export function StatCard({ label, value, sub, icon, accent = 'orange', delay = 0 }: {
  label: string; value: ReactNode; sub?: ReactNode; icon?: ReactNode; accent?: 'orange' | 'violet' | 'cyan' | 'green'; delay?: number
}) {
  return (
    <div className={`glass card stat accent-${accent}`} style={{ animationDelay: `${delay}ms` }}>
      <div className="stat-head">
        <span className="stat-label">{label}</span>
        {icon && <span className="stat-icon">{icon}</span>}
      </div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  )
}
