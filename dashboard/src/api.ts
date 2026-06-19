const BASE = "/api";
const DASHBOARD_API_TOKEN_KEY = "open_logs_dashboard_api_token";

export function getDashboardApiToken(): string {
  try {
    return (
      globalThis.sessionStorage?.getItem(DASHBOARD_API_TOKEN_KEY)?.trim() ?? ""
    );
  } catch {
    return "";
  }
}

export function setDashboardApiToken(token: string): void {
  const value = token.trim();
  try {
    if (value) {
      globalThis.sessionStorage?.setItem(DASHBOARD_API_TOKEN_KEY, value);
    } else {
      globalThis.sessionStorage?.removeItem(DASHBOARD_API_TOKEN_KEY);
    }
  } catch {}
}

export function dashboardAuthHeaders(
  token = getDashboardApiToken(),
): HeadersInit {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path, { headers: dashboardAuthHeaders() });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

export async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...dashboardAuthHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

export async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...dashboardAuthHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

export async function del(path: string): Promise<void> {
  const res = await fetch(BASE + path, {
    method: "DELETE",
    headers: dashboardAuthHeaders(),
  });
  if (!res.ok) throw new Error(`${res.status} ${path}`);
}

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export interface LogRow {
  id: string;
  timestamp: string;
  level: LogLevel;
  service: string | null;
  message: string;
  trace_id: string | null;
  url: string | null;
  stack_trace: string | null;
  metadata: string | null;
  project_id: string | null;
  page_id: string | null;
}
export interface EventCatalogEntry {
  event_id: string;
  source_event_id: string | null;
  event_type: string;
  event_time: string;
  ingest_time: string;
  severity: string | null;
  source: string;
  project_id: string | null;
  page_id: string | null;
  log_id: string | null;
  machine_id: string | null;
  repo_id: string | null;
  app_id: string | null;
  process_id: string | null;
  run_id: string | null;
  trace_id: string | null;
  span_id: string | null;
  session_id: string | null;
  release_id: string | null;
  environment: string | null;
  artifact_id: string | null;
  privacy_tier: string | null;
  message: string | null;
  metadata: Record<string, unknown> | null;
}
export interface Project {
  id: string;
  name: string;
  base_url: string | null;
  github_repo: string | null;
  created_at: string;
}
export interface Issue {
  id: string;
  level: string;
  service: string | null;
  message_template: string;
  count: number;
  status: string;
  first_seen: string;
  last_seen: string;
}
export interface LogSummary {
  service: string | null;
  level: string;
  count: number;
  latest: string;
}
export interface AlertRule {
  id: string;
  name: string;
  level: string;
  service: string | null;
  threshold_count: number;
  window_seconds: number;
  enabled: number;
  last_fired_at: string | null;
}
export interface PerfSnapshot {
  id: string;
  url: string;
  score: number | null;
  lcp: number | null;
  fcp: number | null;
  cls: number | null;
  timestamp: string;
}
export interface Health {
  status: string;
  total_logs: number;
  projects: number;
  logs_by_level: Record<string, number>;
  open_issues: number;
  uptime_seconds: number;
}
