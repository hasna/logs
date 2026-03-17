import { useEffect, useState } from 'react'
import { get, post, type Project } from '../api'

export function Projects() {
  const [projects, setProjects] = useState<Project[]>([])
  const [form, setForm] = useState({ name: '', github_repo: '', base_url: '' })
  const [pageForm, setPageForm] = useState({ project_id: '', url: '', name: '' })

  const load = () => get<Project[]>('/projects').then(setProjects).catch(() => {})
  useEffect(() => { load() }, [])

  const create = async () => {
    if (!form.name) return
    await post('/projects', form)
    setForm({ name: '', github_repo: '', base_url: '' })
    load()
  }

  const addPage = async () => {
    if (!pageForm.project_id || !pageForm.url) return
    await post(`/projects/${pageForm.project_id}/pages`, { url: pageForm.url, name: pageForm.name })
    setPageForm(f => ({ ...f, url: '', name: '' }))
  }

  return (
    <div>
      <h2 style={{ color: '#38bdf8', marginBottom: 16 }}>Projects</h2>

      <div style={{ background: '#1e293b', borderRadius: 8, padding: 16, marginBottom: 16 }}>
        <div style={{ color: '#94a3b8', fontSize: 13, marginBottom: 10 }}>Register Project</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input placeholder="Name *" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={{ background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', padding: '4px 8px', borderRadius: 4, fontFamily: 'monospace' }} />
          <input placeholder="GitHub repo" value={form.github_repo} onChange={e => setForm(f => ({ ...f, github_repo: e.target.value }))} style={{ background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', padding: '4px 8px', borderRadius: 4, width: 220, fontFamily: 'monospace' }} />
          <input placeholder="Base URL" value={form.base_url} onChange={e => setForm(f => ({ ...f, base_url: e.target.value }))} style={{ background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', padding: '4px 8px', borderRadius: 4, width: 200, fontFamily: 'monospace' }} />
          <button onClick={create} style={{ background: '#1e40af', color: '#e2e8f0', border: 'none', padding: '4px 16px', borderRadius: 4, cursor: 'pointer' }}>+ Create</button>
        </div>
      </div>

      <div style={{ background: '#1e293b', borderRadius: 8, padding: 16, marginBottom: 20 }}>
        <div style={{ color: '#94a3b8', fontSize: 13, marginBottom: 10 }}>Register Page</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <select value={pageForm.project_id} onChange={e => setPageForm(f => ({ ...f, project_id: e.target.value }))} style={{ background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', padding: '4px 8px', borderRadius: 4 }}>
            <option value="">Select project</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input placeholder="URL *" value={pageForm.url} onChange={e => setPageForm(f => ({ ...f, url: e.target.value }))} style={{ background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', padding: '4px 8px', borderRadius: 4, width: 250, fontFamily: 'monospace' }} />
          <input placeholder="Name" value={pageForm.name} onChange={e => setPageForm(f => ({ ...f, name: e.target.value }))} style={{ background: '#0f172a', border: '1px solid #334155', color: '#e2e8f0', padding: '4px 8px', borderRadius: 4, fontFamily: 'monospace' }} />
          <button onClick={addPage} style={{ background: '#1e40af', color: '#e2e8f0', border: 'none', padding: '4px 16px', borderRadius: 4, cursor: 'pointer' }}>+ Add Page</button>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {projects.length === 0 && <div style={{ color: '#64748b', padding: 20, textAlign: 'center' }}>No projects yet.</div>}
        {projects.map(p => (
          <div key={p.id} style={{ background: '#1e293b', borderRadius: 8, padding: '12px 16px' }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <span style={{ color: '#e2e8f0', fontWeight: 600 }}>{p.name}</span>
              <span style={{ color: '#475569', fontSize: 11 }}>{p.id}</span>
              {p.base_url && <a href={p.base_url} target="_blank" rel="noreferrer" style={{ color: '#38bdf8', fontSize: 12 }}>{p.base_url}</a>}
              {p.github_repo && <span style={{ color: '#7dd3fc', fontSize: 12 }}>⎋ {p.github_repo}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
