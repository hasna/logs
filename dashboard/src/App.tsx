import { useState } from "react";
import { BrowserRouter, Link, NavLink, Route, Routes } from "react-router-dom";
import { getDashboardApiToken, setDashboardApiToken } from "./api";
import { Alerts } from "./pages/Alerts";
import { Issues } from "./pages/Issues";
import { Perf } from "./pages/Perf";
import { Projects } from "./pages/Projects";
import { Summary } from "./pages/Summary";
import { Tail } from "./pages/Tail";

const NAV = [
  { to: "/", label: "⚡ Live Tail" },
  { to: "/issues", label: "🐛 Issues" },
  { to: "/summary", label: "📊 Summary" },
  { to: "/perf", label: "🚀 Performance" },
  { to: "/alerts", label: "🔔 Alerts" },
  { to: "/projects", label: "📁 Projects" },
];

interface NavProps {
  apiToken: string;
  onApiTokenChange: (token: string) => void;
}

function Nav({ apiToken, onApiTokenChange }: NavProps) {
  return (
    <nav
      style={{
        background: "#0f172a",
        padding: "12px 20px",
        display: "flex",
        alignItems: "center",
        gap: 24,
        borderBottom: "1px solid #1e293b",
      }}
    >
      <Link
        to="/"
        style={{
          color: "#38bdf8",
          fontWeight: 700,
          fontSize: 16,
          textDecoration: "none",
        }}
      >
        @hasna/logs
      </Link>
      {NAV.map((n) => (
        <NavLink
          key={n.to}
          to={n.to}
          end={n.to === "/"}
          style={({ isActive }) => ({
            color: isActive ? "#38bdf8" : "#94a3b8",
            textDecoration: "none",
            fontSize: 14,
          })}
        >
          {n.label}
        </NavLink>
      ))}
      <input
        aria-label="API token"
        type="password"
        value={apiToken}
        onChange={(event) => onApiTokenChange(event.target.value)}
        placeholder="API token"
        style={{
          marginLeft: "auto",
          background: "#020617",
          border: "1px solid #334155",
          color: "#e2e8f0",
          padding: "4px 8px",
          borderRadius: 4,
          fontFamily: "monospace",
          width: 180,
        }}
      />
    </nav>
  );
}

export default function App() {
  const [apiToken, setApiTokenState] = useState(() => getDashboardApiToken());
  const updateApiToken = (token: string) => {
    setApiTokenState(token);
    setDashboardApiToken(token);
  };

  return (
    <BrowserRouter basename="/dashboard">
      <div
        style={{
          minHeight: "100vh",
          background: "#0f172a",
          color: "#e2e8f0",
          fontFamily: "monospace",
        }}
      >
        <Nav apiToken={apiToken} onApiTokenChange={updateApiToken} />
        <div style={{ padding: 20 }}>
          <Routes>
            <Route path="/" element={<Tail apiToken={apiToken} />} />
            <Route path="/issues" element={<Issues />} />
            <Route path="/summary" element={<Summary />} />
            <Route path="/perf" element={<Perf />} />
            <Route path="/alerts" element={<Alerts />} />
            <Route path="/projects" element={<Projects />} />
          </Routes>
        </div>
      </div>
    </BrowserRouter>
  );
}
