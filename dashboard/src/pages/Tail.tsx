import { useEffect, useRef, useState } from 'react'
import type { LogRow } from '../api'

const LEVEL_COLOR: Record<string, string> = {
  debug: '#64748b', info: '#22d3ee', warn: '#fbbf24', error: '#f87171', fatal: '#c084fc'
}

export function Tail() {
  const [logs, setLogs] = useState<LogRow[]>([])
  const [paused, setPaused] = useState(false)
  const [filter, setFilter] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const esRef = useRef<EventSource | null>(null)

  useEffect(() => {
    const es = new EventSource('/api/logs/stream')
    esRef.current = es
    es.onmessage = (e) => {
      if (paused) return
      try {
        const log = JSON.parse(e.data) as LogRow
        setLogs(prev => [...prev.slice(-499), log])
      } catch {}
    }
    return () => es.close()
  }, [paused])

  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs, paused])

  const filtered = filter
    ? logs.filter(l => l.message.toLowerCase().includes(filter.toLowerCase()) || (l.service ?? '').includes(filter))
    : logs

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 12, alignItems: 'center' }}>
        <h2 style={{ margin: 0, color: '#38bdf8' }}>Live Tail</h2>
        <input
          placeholder="Filter..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          style={{ background: '#1e293b', border: '1px solid #334155', color: '#e2e8f0', padding: '4px 8px', borderRadius: 4, fontFamily: 'monospace' }}
        />
        <button onClick={() => setPaused(p => !p)} style={{ background: paused ? '#22d3ee' : '#334155', color: paused ? '#0f172a' : '#e2e8f0', border: 'none', padding: '4px 12px', borderRadius: 4, cursor: 'pointer' }}>
          {paused ? '▶ Resume' : '⏸ Pause'}
        </button>
        <button onClick={() => setLogs([])} style={{ background: '#334155', color: '#e2e8f0', border: 'none', padding: '4px 12px', borderRadius: 4, cursor: 'pointer' }}>Clear</button>
        <span style={{ color: '#64748b', fontSize: 12 }}>{filtered.length} logs</span>
      </div>
      <div style={{ background: '#020617', borderRadius: 8, padding: 12, height: 'calc(100vh - 160px)', overflowY: 'auto', fontSize: 13 }}>
        {filtered.map(log => (
          <div key={log.id} style={{ display: 'flex', gap: 12, marginBottom: 2, lineHeight: 1.5 }}>
            <span style={{ color: '#475569', minWidth: 200 }}>{log.timestamp.slice(0, 19).replace('T', ' ')}</span>
            <span style={{ color: LEVEL_COLOR[log.level] ?? '#e2e8f0', minWidth: 50, fontWeight: 700 }}>{log.level.toUpperCase()}</span>
            <span style={{ color: '#7dd3fc', minWidth: 100 }}>{log.service ?? '-'}</span>
            <span style={{ color: '#e2e8f0', wordBreak: 'break-all' }}>{log.message}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
