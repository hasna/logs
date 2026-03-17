import { useEffect, useState } from 'react'
import { get, put, type Issue } from '../api'

const STATUS_COLOR: Record<string, string> = { open: '#f87171', resolved: '#4ade80', ignored: '#64748b' }

export function Issues() {
  const [issues, setIssues] = useState<Issue[]>([])
  const [status, setStatus] = useState('open')

  const load = () => get<Issue[]>(`/issues?status=${status}&limit=100`).then(setIssues).catch(() => {})
  useEffect(() => { load() }, [status])

  const updateStatus = async (id: string, s: string) => {
    await put(`/issues/${id}`, { status: s })
    load()
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, alignItems: 'center' }}>
        <h2 style={{ margin: 0, color: '#38bdf8' }}>Issues</h2>
        {['open', 'resolved', 'ignored'].map(s => (
          <button key={s} onClick={() => setStatus(s)} style={{ background: status === s ? '#1e40af' : '#1e293b', color: '#e2e8f0', border: 'none', padding: '4px 12px', borderRadius: 4, cursor: 'pointer', textTransform: 'capitalize' }}>{s}</button>
        ))}
        <span style={{ color: '#64748b', fontSize: 12 }}>{issues.length} issue(s)</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {issues.length === 0 && <div style={{ color: '#64748b', padding: 20, textAlign: 'center' }}>No {status} issues 🎉</div>}
        {issues.map(issue => (
          <div key={issue.id} style={{ background: '#1e293b', borderRadius: 8, padding: '12px 16px', display: 'flex', gap: 16, alignItems: 'flex-start' }}>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                <span style={{ color: STATUS_COLOR[issue.status] ?? '#e2e8f0', fontWeight: 700, fontSize: 12 }}>{issue.level.toUpperCase()}</span>
                {issue.service && <span style={{ color: '#7dd3fc', fontSize: 12 }}>{issue.service}</span>}
                <span style={{ color: '#64748b', fontSize: 11 }}>×{issue.count}</span>
                <span style={{ color: '#475569', fontSize: 11 }}>last: {issue.last_seen.slice(0, 16).replace('T', ' ')}</span>
              </div>
              <div style={{ color: '#e2e8f0', fontSize: 13 }}>{issue.message_template}</div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {issue.status !== 'resolved' && <button onClick={() => updateStatus(issue.id, 'resolved')} style={{ background: '#166534', color: '#4ade80', border: 'none', padding: '3px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>Resolve</button>}
              {issue.status !== 'ignored' && <button onClick={() => updateStatus(issue.id, 'ignored')} style={{ background: '#1e293b', color: '#64748b', border: '1px solid #334155', padding: '3px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>Ignore</button>}
              {issue.status !== 'open' && <button onClick={() => updateStatus(issue.id, 'open')} style={{ background: '#7f1d1d', color: '#f87171', border: 'none', padding: '3px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>Reopen</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
