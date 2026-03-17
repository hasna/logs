import { BrowserRouter, Link, NavLink, Route, Routes } from 'react-router-dom'
import { Tail } from './pages/Tail'
import { Issues } from './pages/Issues'
import { Summary } from './pages/Summary'
import { Perf } from './pages/Perf'
import { Alerts } from './pages/Alerts'
import { Projects } from './pages/Projects'

const NAV = [
  { to: '/', label: '⚡ Live Tail' },
  { to: '/issues', label: '🐛 Issues' },
  { to: '/summary', label: '📊 Summary' },
  { to: '/perf', label: '🚀 Performance' },
  { to: '/alerts', label: '🔔 Alerts' },
  { to: '/projects', label: '📁 Projects' },
]

function Nav() {
  return (
    <nav style={{ background: '#0f172a', padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 24, borderBottom: '1px solid #1e293b' }}>
      <Link to="/" style={{ color: '#38bdf8', fontWeight: 700, fontSize: 16, textDecoration: 'none' }}>@hasna/logs</Link>
      {NAV.map(n => (
        <NavLink key={n.to} to={n.to} end={n.to === '/'} style={({ isActive }) => ({
          color: isActive ? '#38bdf8' : '#94a3b8', textDecoration: 'none', fontSize: 14,
        })}>{n.label}</NavLink>
      ))}
    </nav>
  )
}

export default function App() {
  return (
    <BrowserRouter basename="/dashboard">
      <div style={{ minHeight: '100vh', background: '#0f172a', color: '#e2e8f0', fontFamily: 'monospace' }}>
        <Nav />
        <div style={{ padding: 20 }}>
          <Routes>
            <Route path="/" element={<Tail />} />
            <Route path="/issues" element={<Issues />} />
            <Route path="/summary" element={<Summary />} />
            <Route path="/perf" element={<Perf />} />
            <Route path="/alerts" element={<Alerts />} />
            <Route path="/projects" element={<Projects />} />
          </Routes>
        </div>
      </div>
    </BrowserRouter>
  )
}
