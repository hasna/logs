import { useEffect, useState } from 'react'
import { get, post, del, put, type AlertRule, type Project } from '../api'

export function Alerts() {
  const [rules, setRules] = useState<AlertRule[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [form, setForm] = useState({ project_id: '', name: '', level: 'error', threshold_count: 10, window_seconds: 60, action: 'log', webhook_url: '' })

  const load = () => get<AlertRule[]>('/alerts').then(setRules).catch(() => {})
  useEffect(() => {
    load()
    get<Project[]>('/projects').then(p => { setProjects(p); if (p[0]) setForm(f => ({ ...f, project_id: p[0]!.id })) }).catch(() => {})
  }, [])

  const create = async () => {
    if (!form.project_id || !form.name) return
    await post('/alerts', { ...form, threshold_count: Number(form.threshold_count), window_seconds: Number(form.window_seconds) })
    load()
  }

  const toggle = async (rule: AlertRule) => {
    await put(`/alerts/${rule.id}`, { enabled: rule.enabled ? 0 : 1 })
    load()
  }

  const remove = async (id: string) => {
    await del(`/alerts/${id}`)
    load()
  }

  return (
    <div>
      <h2 style={{ color: '#38bdf8', marginBottom: 16 }}>Alert Rules</h2>

      <div style={{ background: '#1e293b', borderRadius: 8, padding: 16, marginBottom: 20 }}>
        <div style={{ color: '#94a3b8', fontSize: 13, marginBottom: 12 }}>New Rule</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={form.project_id} onChange={e => setForm(f => ({ ...f, project_id: e.target.value }))} style={{ background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', padding: '4px 8px', borderRadius: 4 }}>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input placeholder="Rule name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={{ background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', padding: '4px 8px', borderRadius: 4, fontFamily: 'monospace' }} />
          <select value={form.level} onChange={e => setForm(f => ({ ...f, level: e.target.value }))} style={{ background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', padding: '4px 8px', borderRadius: 4 }}>
            {['error', 'fatal', 'warn'].map(l => <option key={l} value={l}>{l}</option>)}
          </select>
          <input type="number" placeholder="Threshold" value={form.threshold_count} onChange={e => setForm(f => ({ ...f, threshold_count: Number(e.target.value) }))} style={{ background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', padding: '4px 8px', borderRadius: 4, width: 80 }} />
          <span style={{ color: '#64748b', fontSize: 12 }}>per</span>
          <input type="number" placeholder="Window (s)" value={form.window_seconds} onChange={e => setForm(f => ({ ...f, window_seconds: Number(e.target.value) }))} style={{ background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', padding: '4px 8px', borderRadius: 4, width: 80 }} />
          <span style={{ color: '#64748b', fontSize: 12 }}>seconds</span>
          <button onClick={create} style={{ background: '#1e40af', color: '#e2e8f0', border: 'none', padding: '4px 16px', borderRadius: 4, cursor: 'pointer' }}>+ Add Rule</button>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rules.length === 0 && <div style={{ color: '#64748b', padding: 20, textAlign: 'center' }}>No alert rules yet.</div>}
        {rules.map(rule => (
          <div key={rule.id} style={{ background: '#1e293b', borderRadius: 8, padding: '10px 16px', display: 'flex', gap: 16, alignItems: 'center' }}>
            <span style={{ color: rule.enabled ? '#4ade80' : '#64748b', fontSize: 10 }}>●</span>
            <span style={{ color: '#e2e8f0', flex: 1 }}>{rule.name}</span>
            <span style={{ color: '#f87171', fontSize: 12 }}>{rule.level}</span>
            <span style={{ color: '#64748b', fontSize: 12 }}>≥{rule.threshold_count} / {rule.window_seconds}s</span>
            {rule.last_fired_at && <span style={{ color: '#fbbf24', fontSize: 11 }}>fired: {rule.last_fired_at.slice(0, 16).replace('T', ' ')}</span>}
            <button onClick={() => toggle(rule)} style={{ background: '#334155', color: '#e2e8f0', border: 'none', padding: '2px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>{rule.enabled ? 'Disable' : 'Enable'}</button>
            <button onClick={() => remove(rule.id)} style={{ background: '#7f1d1d', color: '#f87171', border: 'none', padding: '2px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 12 }}>Delete</button>
          </div>
        ))}
      </div>
    </div>
  )
}
