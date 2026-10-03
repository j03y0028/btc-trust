import { useEffect, useMemo, useState } from 'react'
import { Area, AreaChart, Brush, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { StatCard } from '../components/StatCard'
import { BASE_MONTH, SERIES_STYLE, buildRows, fmtDate, fmtDiff, fmtTime, timelineApi, type DailyData, type Row, type TimelineData, type TimelineEvent } from '../lib/timeline'

const PRESETS = [
  { id: 'all', label: 'All', from: '2000-01' },
  { id: 'gfc', label: '2007–2010 crisis', from: '2007-01', to: '2010-12' },
  { id: 'qe', label: 'QE era', from: '2008-06', to: '2015-12' },
  { id: 'covid', label: '2019–2022', from: '2019-01', to: '2022-12' },
  { id: '5y', label: 'Last 5y', years: 5 },
] as const
const yearTick = (t: number) => String(new Date(t).getUTCFullYear())
/** Jan 1 ticks between two timestamps, thinned to at most ~14 labels. */
const yearTicks = (from: number, to: number) => {
  const y0 = new Date(from).getUTCFullYear() + (new Date(from).getUTCMonth() > 0 ? 1 : 0), y1 = new Date(to).getUTCFullYear()
  const step = Math.max(1, Math.ceil((y1 - y0 + 1) / 14))
  const out: number[] = []
  for (let y = y0; y <= y1; y += step) out.push(Date.UTC(y, 0, 1))
  return out
}
/** Short hash: skip the proof-of-work leading zeros, keep both ends. */
const shortHash = (h: string) => { const z = h.match(/^0*/)![0].length; return `0×${z} ${h.slice(z, z + 6)}…${h.slice(-6)}` }
/** Event-number marker above the plot, stacked in tiers when events are close together. */
function EventLabel({ viewBox, n, tier, kind }: { viewBox?: { x: number; y: number }; n: number; tier: number; kind: string }) {
  if (!viewBox) return null
  const y = viewBox.y - 8 - tier * 15
  const btc = kind === 'bitcoin'
  return (
    <g className="ev-marker">
      <circle cx={viewBox.x} cy={y - 3.5} r={7} fill={btc ? 'rgba(247,147,26,.22)' : 'rgba(170,178,214,.14)'} stroke={btc ? '#f7931a' : 'rgba(170,178,214,.5)'} strokeWidth={1} />
      <text x={viewBox.x} y={y} textAnchor="middle" fontSize={8.5} fontWeight={700} fill={btc ? '#ffc070' : '#c7cbe0'}>{n}</text>
    </g>
  )
}
const monthOf = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, 1)

function ChartTooltip({ active, payload, label, events }: { active?: boolean; payload?: { dataKey: string; payload: Row }[]; label?: number; events: (TimelineEvent & { n: number })[] }) {
  if (!active || !payload?.length || label === undefined) return null
  const row = payload[0].payload
  const evs = events.filter((e) => monthOf(e.date) === label)
  return (
    <div className="tl-tip">
      <div className="tl-tip-date">{new Date(label).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</div>
      {payload.map((p) => {
        const id = String(p.dataKey)
        const raw = row[`${id}_raw`] as number | undefined
        const s = SERIES_STYLE[id]
        return raw === undefined ? null : (
          <div key={id} className="tl-tip-row"><i style={{ background: s.color }} />{s.short}<b>{id === 'FEDFUNDS' || id === 'UNRATE' ? `${raw}%` : `${row[id]}`}</b>{id !== 'FEDFUNDS' && id !== 'UNRATE' && <small>({raw.toLocaleString('en-US')})</small>}</div>
        )
      })}
      {evs.map((e) => <div key={e.n} className={`tl-tip-ev ${e.kind}`}>{e.n}. {e.title}</div>)}
    </div>
  )
}

export function Timeline() {
  const [data, setData] = useState<TimelineData | null>(null)
  const [daily, setDaily] = useState<DailyData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [on, setOn] = useState<Record<string, boolean>>({ CPIAUCSL: true, M2SL: true, GDP: false, FEDFUNDS: true, UNRATE: true, us: true, bitcoin: true })
  const [range, setRange] = useState<{ start: number; end: number } | null>(null)
  const [preset, setPreset] = useState('all')
  const [focus, setFocus] = useState<number | null>(null)

  useEffect(() => {
    timelineApi.timeline().then(setData).catch((e) => setError(e.message))
    timelineApi.daily().then(setDaily).catch(() => {})
  }, [])

  const rows = useMemo(() => (data ? buildRows(data.series) : []), [data])
  const events = useMemo(() => {
    let prev = -Infinity, tier = 0
    return (data?.events ?? []).map((e, i) => {
      const t = monthOf(e.date)
      tier = t - prev < 200 * 86400_000 ? (tier + 1) % 4 : 0
      prev = t
      return { ...e, n: i + 1, tier }
    })
  }, [data])
  const view = range ?? { start: 0, end: Math.max(0, rows.length - 1) }
  const inView = (e: TimelineEvent) => rows.length > 0 && monthOf(e.date) >= rows[view.start]?.t && monthOf(e.date) <= rows[view.end]?.t

  const applyPreset = (id: string) => {
    setPreset(id)
    const p = PRESETS.find((x) => x.id === id)!
    if (id === 'all') return setRange(null)
    const last = rows.at(-1)?.month ?? '2026-12'
    const from = 'years' in p ? `${Number(last.slice(0, 4)) - p.years}${last.slice(4)}` : p.from
    const to = 'to' in p ? p.to : last
    const start = Math.max(0, rows.findIndex((r) => r.month >= from))
    const endIdx = rows.findIndex((r) => r.month > to)
    setRange({ start, end: endIdx === -1 ? rows.length - 1 : endIdx - 1 })
  }
  const refresh = async () => {
    setBusy(true)
    try { setData(await timelineApi.refresh()); setDaily(await timelineApi.daily()) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const snapshotNow = async () => {
    setBusy(true)
    try { await timelineApi.snapshot(); setDaily(await timelineApi.daily()) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  const latest = daily?.latest
  const growth = useMemo(() => {
    if (!daily?.genesis) return []
    const pts = [{ t: daily.genesis.time * 1000, height: 0, label: 'Genesis' }, ...daily.halvings.map((h) => ({ t: h.time * 1000, height: h.height, label: `Halving #${h.height / 210000}` })), ...daily.snapshots.map((s) => ({ t: s.time * 1000, height: s.height, label: `Snapshot ${s.date}` }))]
    return pts.sort((a, b) => a.t - b.t)
  }, [daily])
  const ref = data?.reference

  return (
    <div className="page timeline-page">
      <div className="page-head">
        <div>
          <h2 className="page-title">Timeline</h2>
          <p className="muted">U.S. monetary history beside Bitcoin’s own ledger. Every figure is sourced: FRED data, primary-source citations and block headers verified locally.</p>
        </div>
        <div className="row-gap">
          <button className="btn small" onClick={snapshotNow} disabled={busy}>{daily?.hasToday ? 'Today’s snapshot ✓' : 'Take today’s snapshot'}</button>
          <button className="btn small ghost" onClick={refresh} disabled={busy}>{busy ? 'Refreshing…' : '↻ Refresh data'}</button>
        </div>
      </div>
      {error && <div className="glass alert" role="alert">⚠ {error}</div>}
      {data?.errors.map((e) => <div key={e} className="glass alert warn-soft">⚠ {e}</div>)}

      <div className="tl-stats">
        <StatCard label="Blocks since genesis" icon="⛓" value={latest ? latest.height.toLocaleString('en-US') : '—'}
          sub={latest ? <>mainnet · {latest.primary} · <span className={`chk chk-${latest.check.status}`}>{latest.check.status}</span></> : 'no snapshot yet'} />
        <StatCard label="Days since white paper" icon="📄" accent="violet" delay={60} value={daily ? daily.daysSinceWhitepaper.toLocaleString('en-US') : '—'} sub="since Oct 31, 2008" />
        <StatCard label="Days since genesis" icon="✦" accent="cyan" delay={120} value={daily?.daysSinceGenesis?.toLocaleString('en-US') ?? '—'} sub="since Jan 3, 2009" />
        <StatCard label="Next halving · block 1,050,000" icon="½" accent="green" delay={180}
          value={daily?.nextHalving ? new Date(daily.nextHalving.estimatedTime * 1000).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'America/Phoenix' }) : '—'}
          sub={daily?.nextHalving ? `est. · ${daily.nextHalving.remaining.toLocaleString('en-US')} blocks · avg ${(daily.nextHalving.avgBlockSeconds / 60).toFixed(2)} min since #840,000` : 'needs a snapshot'} />
        <StatCard label="Chain keeps growing" icon="🔥" delay={240} value={daily ? <>{daily.streakDays}<small className="unit"> day streak</small></> : '—'}
          sub={daily ? `${daily.snapshots.length} daily snapshot${daily.snapshots.length === 1 ? '' : 's'} · ${daily.growing ? 'height ↑ every day' : 'height did not grow!'}` : ''} />
      </div>

      <div className="glass card tl-chart-card">
        <div className="card-title">
          <div>
            <h2>U.S. economy × Bitcoin</h2>
            <p className="muted small">Levels rebased to {BASE_MONTH === '2008-10' ? 'Oct 2008' : BASE_MONTH} = 100 (white-paper month, left axis) · rates in % (right axis) · drag the brush to zoom</p>
          </div>
          <div className="tl-presets" role="group" aria-label="Range">
            {PRESETS.map((p) => <button key={p.id} className={preset === p.id ? 'active' : ''} onClick={() => applyPreset(p.id)}>{p.label}</button>)}
          </div>
        </div>
        <div className="tl-toggles" role="group" aria-label="Overlays">
          {Object.entries(SERIES_STYLE).map(([id, s]) => (
            <button key={id} aria-pressed={on[id]} className={`chip ${on[id] ? 'on' : ''}`} style={{ ['--c' as string]: s.color }} onClick={() => setOn({ ...on, [id]: !on[id] })}><i />{s.short}</button>
          ))}
          <span className="sep" />
          <button aria-pressed={on.us} className={`chip ev-us ${on.us ? 'on' : ''}`} onClick={() => setOn({ ...on, us: !on.us })}><i />U.S. events</button>
          <button aria-pressed={on.bitcoin} className={`chip ev-btc ${on.bitcoin ? 'on' : ''}`} onClick={() => setOn({ ...on, bitcoin: !on.bitcoin })}><i />Bitcoin milestones</button>
        </div>
        <div className="tl-chart" data-testid="timeline-chart">
          {rows.length > 0 ? (
            <ResponsiveContainer width="100%" height={430}>
              <ComposedChart data={rows} margin={{ top: 66, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="gM2" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#3dd6f5" stopOpacity={0.3} /><stop offset="100%" stopColor="#3dd6f5" stopOpacity={0} /></linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(255,255,255,.05)" vertical={false} />
                <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} ticks={rows.length ? yearTicks(rows[view.start].t, rows[view.end].t) : []} tickFormatter={yearTick} stroke="#555b70" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="lvl" stroke="#555b70" tick={{ fontSize: 11 }} width={44} domain={['auto', 'auto']} />
                <YAxis yAxisId="pct" orientation="right" stroke="#555b70" tick={{ fontSize: 11 }} width={36} unit="%" />
                <Tooltip content={<ChartTooltip events={events} />} cursor={{ stroke: 'rgba(255,255,255,.25)' }} />
                {events.filter((e) => on[e.kind === 'us' ? 'us' : 'bitcoin'] && inView(e)).map((e) => (
                  <ReferenceLine key={e.n} yAxisId="lvl" x={monthOf(e.date)} stroke={e.kind === 'bitcoin' ? '#f7931a' : '#9aa3c7'} strokeOpacity={focus === e.n ? 1 : e.kind === 'bitcoin' ? 0.75 : 0.35} strokeWidth={focus === e.n ? 2 : 1} strokeDasharray={e.kind === 'bitcoin' ? undefined : '3 4'}
                    label={<EventLabel n={e.n} tier={e.tier} kind={e.kind} />} className={`ev-line ev-${e.kind}`} />
                ))}
                {on.M2SL && <Area yAxisId="lvl" dataKey="M2SL" stroke={SERIES_STYLE.M2SL.color} fill="url(#gM2)" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />}
                {on.CPIAUCSL && <Line yAxisId="lvl" dataKey="CPIAUCSL" stroke={SERIES_STYLE.CPIAUCSL.color} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />}
                {on.GDP && <Line yAxisId="lvl" dataKey="GDP" stroke={SERIES_STYLE.GDP.color} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />}
                {on.FEDFUNDS && <Line yAxisId="pct" dataKey="FEDFUNDS" stroke={SERIES_STYLE.FEDFUNDS.color} strokeWidth={1.6} dot={false} type="stepAfter" connectNulls isAnimationActive={false} />}
                {on.UNRATE && <Line yAxisId="pct" dataKey="UNRATE" stroke={SERIES_STYLE.UNRATE.color} strokeWidth={1.6} dot={false} connectNulls isAnimationActive={false} />}
                <Brush dataKey="t" height={26} stroke="#f7931a" fill="rgba(255,255,255,.03)" travellerWidth={8} tickFormatter={yearTick} startIndex={view.start} endIndex={view.end}
                  onChange={(r: { startIndex?: number; endIndex?: number }) => { if (r.startIndex !== undefined && r.endIndex !== undefined) { setRange({ start: r.startIndex, end: r.endIndex }); setPreset('') } }} />
              </ComposedChart>
            </ResponsiveContainer>
          ) : <div className="skeleton tl-skel">{error ? 'Data unavailable' : 'Loading FRED series…'}</div>}
        </div>
        <div className="tl-sources">
          {data?.series.map((s) => (
            <div key={s.id} className="tl-src">
              <i style={{ background: SERIES_STYLE[s.id]?.color }} />
              <div>
                <a href={s.sourceUrl} target="_blank" rel="noreferrer"><b>{s.id}</b></a> <span className="muted">{s.title}</span>
                <div className="muted tiny">{s.units} · {s.frequency} · {s.seasonal} · latest {s.points.at(-1)?.date.slice(0, 7)} · fetched {fmtTime(Date.parse(s.fetchedAt))}{s.stale ? ' (stale cache)' : ''} · <a href={s.csvUrl} target="_blank" rel="noreferrer">CSV</a></div>
              </div>
            </div>
          ))}
          <div className="muted tiny tl-src-note">Source: Federal Reserve Bank of St. Louis, FRED. Downloaded as CSV, cached locally in <code>data/fred/</code> with fetch date, refreshed every 24 h.</div>
        </div>
      </div>

      <div className="tl-grid">
        <div className="glass card tl-events">
          <div className="card-title"><h2>Milestones</h2><span className="pill">{events.length} cited events</span></div>
          <ol className="ev-list">
            {events.map((e) => (
              <li key={e.n} className={`ev ev-${e.kind} ${focus === e.n ? 'focus' : ''}`} onMouseEnter={() => setFocus(e.n)} onMouseLeave={() => setFocus(null)}>
                <span className="ev-n">{e.n}</span>
                <div className="ev-body">
                  <div className="ev-head"><time>{fmtDate(e.date)}</time><span className={`ev-kind ${e.kind}`}>{e.kind === 'us' ? 'U.S.' : '₿'}</span></div>
                  <div className="ev-title">{e.title}</div>
                  <div className="muted ev-detail">{e.detail}</div>
                  <a className="ev-cite" href={e.citation} target="_blank" rel="noreferrer">{e.source} ↗</a>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <div className="tl-side">
          <div className="glass card genesis-card">
            <div className="card-title"><h2>Genesis block</h2>{ref?.genesis.verified && <span className="badge badge-complete">verified</span>}</div>
            {ref ? (
              <>
                <blockquote className="times">“{ref.genesis.headline}”</blockquote>
                <p className="muted tiny">Embedded in the coinbase of block 0, mined {fmtTime(ref.genesis.time * 1000)}. Decoded here from the raw mainnet coinbase transaction.</p>
                <code className="hash">{ref.genesis.hash}</code>
                <ul className="checks">
                  {Object.entries(ref.genesis.checks).map(([k, v]) => <li key={k} className={v ? 'ok' : 'bad'}>{v ? '✓' : '✗'} {({ hashIsGenesis: 'Header double-SHA256 = genesis hash', proofOfWork: 'Proof of work meets target', merkleRootIsCoinbase: 'Merkle root = coinbase txid', coinbaseTxid: 'Coinbase txid matches' } as Record<string, string>)[k] ?? k}</li>)}
                </ul>
                <p className="muted tiny">Fetched {fmtTime(Date.parse(ref.fetchedAt))} from {ref.source}</p>
              </>
            ) : <p className="muted">Genesis data not fetched yet.</p>}
          </div>
          {data && (
            <div className="glass card wp-card">
              <div className="card-title"><h2>White paper</h2>{data.whitepaper.matches ? <span className="badge badge-complete">SHA-256 ✓</span> : <span className="badge badge-planned">unverified</span>}</div>
              <div className="wp-title">{data.whitepaper.title}</div>
              <div className="muted small">{data.whitepaper.author} · {fmtDate(data.whitepaper.date)}</div>
              <div className="row-gap wp-links">
                {data.whitepaper.bundled && <a className="btn small primary" href={data.whitepaper.localPath} target="_blank" rel="noreferrer">Open local copy</a>}
                <a className="btn small" href={data.whitepaper.url} target="_blank" rel="noreferrer">bitcoin.org ↗</a>
                <a className="btn small ghost" href={data.whitepaper.announcement} target="_blank" rel="noreferrer">Announcement ↗</a>
              </div>
              <code className="hash tiny">sha256 {data.whitepaper.sha256}</code>
              <p className="muted tiny">{data.whitepaper.bytes.toLocaleString('en-US')} bytes · bundled copy re-hashed on every load and must match the published hash.</p>
            </div>
          )}
        </div>
      </div>

      <div className="tl-grid bottom">
        <div className="glass card">
          <div className="card-title"><h2>Chain keeps growing</h2><span className="pill">read-only mainnet</span></div>
          <div className="tl-growth" data-testid="growth-chart">
            {growth.length > 1 && (
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={growth} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <defs><linearGradient id="gH" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#f7931a" stopOpacity={0.45} /><stop offset="100%" stopColor="#f7931a" stopOpacity={0} /></linearGradient></defs>
                  <CartesianGrid stroke="rgba(255,255,255,.05)" vertical={false} />
                  <XAxis dataKey="t" type="number" scale="time" domain={['dataMin', 'dataMax']} ticks={yearTicks(growth[0].t, growth.at(-1)!.t)} tickFormatter={yearTick} stroke="#555b70" tick={{ fontSize: 11 }} />
                  <YAxis stroke="#555b70" tick={{ fontSize: 11 }} width={52} tickFormatter={(v: number) => `${Math.round(v / 1000)}k`} />
                  <Tooltip contentStyle={{ background: 'rgba(14,16,24,.95)', border: '1px solid rgba(255,255,255,.1)', borderRadius: 12 }} labelFormatter={(t) => fmtTime(Number(t))} formatter={(v) => [Number(v).toLocaleString('en-US'), 'height']} />
                  <Area dataKey="height" type="monotone" stroke="#f7931a" strokeWidth={2} fill="url(#gH)" dot={{ r: 3, fill: '#f7931a' }} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
          <div className="streak">
            {Array.from({ length: 14 }, (_, i) => {
              const d = new Date(Date.parse(`${daily?.today ?? '2026-01-01'}T12:00:00Z`) - (13 - i) * 86400_000).toISOString().slice(0, 10)
              const s = daily?.snapshots.find((x) => x.date === d)
              return <span key={d} className={`day ${s ? 'hit' : ''}`} title={s ? `${d}: #${s.height}` : `${d}: no snapshot`} />
            })}
            <span className="muted tiny">last 14 days</span>
          </div>
          <p className="muted tiny">Genesis + 4 halvings (headers verified) + one snapshot per day. {daily?.nodeConfigured ? 'Primary source: your node (getblockchaininfo).' : `Sources: ${daily?.sources.join(' + ')} (fallback ${daily?.fallbacks?.join(', ') ?? '—'}). Configure MAINNET_RPC_* to use your own node (myNode).`}</p>
        </div>
        <div className="glass card">
          <div className="card-title"><h2>Daily block log</h2><code className="muted tiny">data/daily-blocks.json</code></div>
          <table className="tl-table">
            <thead><tr><th>Date</th><th>Height</th><th>Tip hash</th><th>Block time</th><th>Difficulty</th><th>Cross-check</th></tr></thead>
            <tbody>
              {(daily?.snapshots ?? []).slice().reverse().map((s) => (
                <tr key={s.date}>
                  <td className="nowrap">{s.date}</td>
                  <td className="mono">{s.height.toLocaleString('en-US')}</td>
                  <td className="mono nowrap" title={s.hash}>{shortHash(s.hash)}</td>
                  <td className="nowrap">{fmtTime(s.time * 1000)}</td>
                  <td className="mono">{fmtDiff(s.difficulty)}</td>
                  <td>
                    <span className={`chk chk-${s.check.status}`}>{s.check.status}</span>
                    <div className="src-dots">{s.sources.map((x) => <span key={x.name} className={x.ok ? 'ok' : 'bad'} title={x.ok ? `${x.name}: #${x.height}` : `${x.name}: ${x.error}`}>{x.ok ? '●' : '○'} {x.name}</span>)}</div>
                  </td>
                </tr>
              ))}
              {daily && daily.snapshots.length === 0 && <tr><td colSpan={6} className="muted">No snapshots yet: run <code>npm run daily:snapshot</code>.</td></tr>}
            </tbody>
          </table>
          {latest && latest.check.notes.length > 0 && <ul className="notes muted tiny">{latest.check.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
          <div className="halv">
            {daily?.halvings.map((h) => (
              <div key={h.height} className="halv-item"><b>#{h.height.toLocaleString('en-US')}</b><span className="muted tiny">{fmtDate(h.timeISO)} UTC</span><a className="tiny" href={`https://mempool.space/block/${h.hash}`} target="_blank" rel="noreferrer" title={h.hash}>{shortHash(h.hash)}</a></div>
            ))}
            {daily?.nextHalving && <div className="halv-item next"><b>#1,050,000</b><span className="muted tiny">≈ {new Date(daily.nextHalving.estimatedTime * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Phoenix' })} (est.)</span><span className="tiny muted">at 10 min: {new Date(daily.nextHalving.naiveTime * 1000).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'America/Phoenix' })}</span></div>}
          </div>
        </div>
      </div>
    </div>
  )
}
