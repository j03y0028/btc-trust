import { useEffect, useState } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { timelineApi, type ProgressData } from '../lib/timeline'

const ICONS = ['⚙', '◉', '⛓', '🔐', '📜', '✉', '⏳', '🛡']
const BACKLOG_ICONS = ['🧅', '📦', '🛡', '🔌', '🔑']

export function Goals() {
  const [p, setP] = useState<ProgressData | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { timelineApi.progress().then(setP).catch((e) => setError(e.message)) }, [])

  const done = p?.stages.filter((s) => s.status === 'complete').length ?? 0
  const total = p?.stages.length ?? 8
  const latest = p?.stages.filter((s) => s.tests).at(-1)?.tests
  const chart = (p?.stages ?? []).filter((s) => s.tests).map((s) => ({ name: `S${s.id}`, backend: s.tests!.backend, frontend: s.tests!.frontend }))
  const pct = Math.round((done / total) * 100)

  return (
    <div className="page goals-page">
      <div className="page-head">
        <div>
          <h2 className="page-title">Goals & accomplishments</h2>
          <p className="muted">Every stage shipped with tests and a commit. Hashes and test counts are read live from git.</p>
        </div>
      </div>
      {error && <div className="glass alert" role="alert">⚠ {error}</div>}

      <div className="goals-hero glass card">
        <div className="ring" style={{ ['--p' as string]: `${pct}` }}>
          <svg viewBox="0 0 120 120" aria-hidden>
            <defs><linearGradient id="gRing" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stopColor="#ffd29a" /><stop offset="100%" stopColor="#f7931a" /></linearGradient></defs>
            <circle cx="60" cy="60" r="52" className="ring-bg" />
            <circle cx="60" cy="60" r="52" className="ring-fg" style={{ strokeDasharray: `${(pct / 100) * 326.7} 326.7` }} />
          </svg>
          <div className="ring-label"><b>{done}/{total}</b><span>stages</span></div>
        </div>
        <div className="goals-summary">
          <div><span className="eyebrow">Tests passing</span><b>{latest ? latest.backend + latest.frontend : '—'}</b><small className="muted">{latest ? `${latest.backend} backend · ${latest.frontend} frontend` : ''}</small></div>
          <div><span className="eyebrow">Commits</span><b>{p ? new Set(p.stages.filter((s) => s.commit).map((s) => s.commit!.hash)).size : '—'}</b><small className="muted">local · main</small></div>
          <div><span className="eyebrow">HEAD</span><b className="mono">{p?.head?.slice(0, 7) ?? '—'}</b><small className="muted">{p?.dirty ? 'uncommitted changes' : 'clean tree'}</small></div>
          <div><span className="eyebrow">Network</span><b>regtest</b><small className="muted">mainnet read-only</small></div>
        </div>
        <div className="goals-chart">
          <ResponsiveContainer width="100%" height={150}>
            <BarChart data={chart} margin={{ top: 6, right: 0, left: -18, bottom: 0 }}>
              <CartesianGrid stroke="rgba(255,255,255,.05)" vertical={false} />
              <XAxis dataKey="name" stroke="#555b70" tick={{ fontSize: 11 }} />
              <YAxis stroke="#555b70" tick={{ fontSize: 11 }} />
              <Tooltip cursor={{ fill: 'rgba(255,255,255,.04)' }} contentStyle={{ background: 'rgba(14,16,24,.95)', border: '1px solid rgba(255,255,255,.1)', borderRadius: 12 }} />
              <Bar dataKey="backend" stackId="t" fill="#f7931a" radius={[0, 0, 0, 0]} isAnimationActive={false} />
              <Bar dataKey="frontend" stackId="t" fill="#9b7bff" radius={[6, 6, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ResponsiveContainer>
          <div className="muted tiny center">test cases per stage (backend / frontend)</div>
        </div>
      </div>

      <div className="stage-list">
        {(p?.stages ?? []).map((s, i) => (
          <div key={s.id} className={`glass card stage-card st-${s.status}`} style={{ animationDelay: `${i * 50}ms` }} data-testid={`goal-stage-${s.id}`}>
            <div className="stage-num"><span>{ICONS[s.id]}</span></div>
            <div className="stage-main">
              <div className="stage-top">
                <span className="eyebrow">Stage {s.id}</span>
                <span className={`badge badge-${s.status}`}>{s.status}</span>
              </div>
              <h3>{s.title}</h3>
              <ul>{s.achievements.map((a) => <li key={a}>{a}</li>)}</ul>
            </div>
            <div className="stage-meta">
              {s.tests && <div className="meta-tests"><b>{s.tests.backend + s.tests.frontend}</b><span className="muted tiny">tests · {s.tests.backend} be / {s.tests.frontend} fe</span></div>}
              {s.commit ? (
                <div className="meta-commit"><code>{s.commit.short}</code><span className="muted tiny">{new Date(s.commit.date).toLocaleString('en-US', { timeZone: 'America/Phoenix', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })}</span></div>
              ) : <div className="meta-commit"><code className="muted">{s.tests?.source === 'working tree' ? 'uncommitted' : '—'}</code></div>}
            </div>
          </div>
        ))}
      </div>

      <div>
        <h3 className="section-h">Next goals</h3>
        <div className="backlog">
          {(p?.backlog ?? []).map((b, i) => (
            <div key={b.title} className="glass card backlog-item" style={{ animationDelay: `${i * 40}ms` }}>
              <div className="bl-icon">{BACKLOG_ICONS[i] ?? '•'}</div>
              <div><b>{b.title}</b><p className="muted small">{b.detail}</p></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
