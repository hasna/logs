import { useEffect, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { get, type Project, type PerfSnapshot } from '../api'

function ScoreBadge({ score }: { score: number | null }) {
  const color = score === null ? '#64748b' : score >= 90 ? '#4ade80' : score >= 50 ? '#fbbf24' : '#f87171'
  return <span style={{ color, fontWeight: 700, fontSize: 18 }}>{score !== null ? Math.round(score) : '—'}</span>
}

export function Perf() {
  const [projects, setProjects] = useState<Project[]>([])
  const [selected, setSelected] = useState<string>('')
  const [trend, setTrend] = useState<PerfSnapshot[]>([])

  useEffect(() => {
    get<Project[]>('/projects').then(p => { setProjects(p); if (p[0]) setSelected(p[0].id) }).catch(() => {})
  }, [])

  useEffect(() => {
    if (!selected) return
    get<PerfSnapshot[]>(`/perf/trend?project_id=${selected}&limit=30`).then(setTrend).catch(() => {})
  }, [selected])

  const chartData = [...trend].reverse().map(s => ({
    time: s.timestamp.slice(5, 16).replace('T', ' '),
    score: s.score !== null ? Math.round(s.score) : null,
    lcp: s.lcp !== null ? Math.round(s.lcp) : null,
    fcp: s.fcp !== null ? Math.round(s.fcp) : null,
  }))

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center' }}>
        <h2 style={{ margin: 0, color: '#38bdf8' }}>Performance</h2>
        <select value={selected} onChange={e => setSelected(e.target.value)} style={{ background: '#1e293b', border: '1px solid #334155', color: '#e2e8f0', padding: '4px 8px', borderRadius: 4 }}>
          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      {trend.length > 0 && (
        <div style={{ display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
          {[
            { label: 'Score', value: trend[0]?.score ?? null },
            { label: 'LCP (ms)', value: trend[0]?.lcp !== null && trend[0]?.lcp !== undefined ? Math.round(trend[0].lcp) : null },
            { label: 'FCP (ms)', value: trend[0]?.fcp !== null && trend[0]?.fcp !== undefined ? Math.round(trend[0].fcp) : null },
            { label: 'CLS', value: trend[0]?.cls !== null && trend[0]?.cls !== undefined ? trend[0].cls.toFixed(3) : null },
          ].map(stat => (
            <div key={stat.label} style={{ background: '#1e293b', borderRadius: 8, padding: '12px 20px', textAlign: 'center', minWidth: 100 }}>
              <ScoreBadge score={Number(stat.value)} />
              <div style={{ color: '#64748b', fontSize: 12, marginTop: 4 }}>{stat.label}</div>
            </div>
          ))}
        </div>
      )}

      {chartData.length > 1 ? (
        <div style={{ background: '#1e293b', borderRadius: 8, padding: 20 }}>
          <div style={{ color: '#94a3b8', marginBottom: 12, fontSize: 13 }}>Performance Score Over Time</div>
          <ResponsiveContainer width="100%" height={250}>
            <LineChart data={chartData}>
              <XAxis dataKey="time" stroke="#64748b" tick={{ fill: '#94a3b8', fontSize: 11 }} />
              <YAxis domain={[0, 100]} stroke="#64748b" tick={{ fill: '#94a3b8', fontSize: 12 }} />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0' }} />
              <Line type="monotone" dataKey="score" stroke="#38bdf8" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div style={{ color: '#64748b', padding: 40, textAlign: 'center', background: '#1e293b', borderRadius: 8 }}>
          {projects.length === 0 ? 'No projects yet. Register one via CLI or MCP.' : 'No performance data yet. Run a scan job to collect metrics.'}
        </div>
      )}
    </div>
  )
}
