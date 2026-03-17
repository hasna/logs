import { useEffect, useState } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { get, type LogSummary, type Health } from '../api'

export function Summary() {
  const [summary, setSummary] = useState<LogSummary[]>([])
  const [health, setHealth] = useState<Health | null>(null)

  useEffect(() => {
    get<LogSummary[]>('/logs/summary?since=' + new Date(Date.now() - 24 * 3600 * 1000).toISOString()).then(setSummary).catch(() => {})
    fetch('/health').then(r => r.json()).then(setHealth).catch(() => {})
  }, [])

  // Group by service for chart
  const byService = summary.reduce<Record<string, { service: string; error: number; warn: number; fatal: number }>>((acc, s) => {
    const svc = s.service ?? 'unknown'
    if (!acc[svc]) acc[svc] = { service: svc, error: 0, warn: 0, fatal: 0 }
    if (s.level === 'error') acc[svc]!.error += s.count
    if (s.level === 'warn') acc[svc]!.warn += s.count
    if (s.level === 'fatal') acc[svc]!.fatal += s.count
    return acc
  }, {})
  const chartData = Object.values(byService).sort((a, b) => (b.error + b.fatal) - (a.error + a.fatal))

  return (
    <div>
      <h2 style={{ color: '#38bdf8', marginBottom: 16 }}>Summary (last 24h)</h2>

      {health && (
        <div style={{ display: 'flex', gap: 16, marginBottom: 24, flexWrap: 'wrap' }}>
          {[
            { label: 'Total Logs', value: health.total_logs.toLocaleString(), color: '#38bdf8' },
            { label: 'Projects', value: health.projects, color: '#7dd3fc' },
            { label: 'Open Issues', value: health.open_issues, color: health.open_issues > 0 ? '#f87171' : '#4ade80' },
            { label: 'Errors', value: (health.logs_by_level['error'] ?? 0) + (health.logs_by_level['fatal'] ?? 0), color: '#f87171' },
            { label: 'Warnings', value: health.logs_by_level['warn'] ?? 0, color: '#fbbf24' },
            { label: 'Uptime', value: `${Math.floor(health.uptime_seconds / 60)}m`, color: '#4ade80' },
          ].map(stat => (
            <div key={stat.label} style={{ background: '#1e293b', borderRadius: 8, padding: '12px 20px', minWidth: 120, textAlign: 'center' }}>
              <div style={{ color: stat.color, fontSize: 24, fontWeight: 700 }}>{stat.value}</div>
              <div style={{ color: '#64748b', fontSize: 12, marginTop: 4 }}>{stat.label}</div>
            </div>
          ))}
        </div>
      )}

      {chartData.length > 0 ? (
        <div style={{ background: '#1e293b', borderRadius: 8, padding: 20 }}>
          <div style={{ color: '#94a3b8', marginBottom: 12, fontSize: 13 }}>Errors & Warnings by Service</div>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData}>
              <XAxis dataKey="service" stroke="#64748b" tick={{ fill: '#94a3b8', fontSize: 12 }} />
              <YAxis stroke="#64748b" tick={{ fill: '#94a3b8', fontSize: 12 }} />
              <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0' }} />
              <Legend wrapperStyle={{ color: '#94a3b8' }} />
              <Bar dataKey="fatal" fill="#c084fc" stackId="a" />
              <Bar dataKey="error" fill="#f87171" stackId="a" />
              <Bar dataKey="warn" fill="#fbbf24" stackId="a" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div style={{ color: '#64748b', padding: 40, textAlign: 'center', background: '#1e293b', borderRadius: 8 }}>No errors or warnings in the last 24h 🎉</div>
      )}
    </div>
  )
}
