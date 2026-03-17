import type { LogEntry, LogLevel, LogQuery, LogRow, LogSummary, Page, PerformanceSnapshot, Project, ScanJob } from "../../src/types/index.ts"

export type { LogEntry, LogLevel, LogQuery, LogRow, LogSummary, Page, PerformanceSnapshot, Project, ScanJob }

export interface LogsClientOptions {
  url?: string
  projectId?: string
  apiKey?: string
}

const DEFAULT_URL = "http://localhost:3460"

export class LogsClient {
  private url: string
  private projectId?: string
  private headers: Record<string, string>

  constructor(opts: LogsClientOptions = {}) {
    this.url = (opts.url ?? DEFAULT_URL).replace(/\/$/, "")
    this.projectId = opts.projectId
    this.headers = { "Content-Type": "application/json" }
    if (opts.apiKey) this.headers["Authorization"] = `Bearer ${opts.apiKey}`
  }

  async push(entry: LogEntry): Promise<LogRow> {
    const res = await fetch(`${this.url}/api/logs`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ project_id: this.projectId, ...entry }),
    })
    return res.json() as Promise<LogRow>
  }

  async pushBatch(entries: LogEntry[]): Promise<{ inserted: number }> {
    const res = await fetch(`${this.url}/api/logs`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(entries.map(e => ({ project_id: this.projectId, ...e }))),
    })
    return res.json() as Promise<{ inserted: number }>
  }

  async search(query: LogQuery = {}): Promise<LogRow[]> {
    const params = new URLSearchParams()
    if (query.project_id ?? this.projectId) params.set("project_id", query.project_id ?? this.projectId!)
    if (query.page_id) params.set("page_id", query.page_id)
    if (query.level) params.set("level", Array.isArray(query.level) ? query.level.join(",") : query.level)
    if (query.service) params.set("service", query.service)
    if (query.since) params.set("since", query.since)
    if (query.until) params.set("until", query.until)
    if (query.text) params.set("text", query.text)
    if (query.limit) params.set("limit", String(query.limit))
    if (query.offset) params.set("offset", String(query.offset))
    if (query.fields) params.set("fields", query.fields.join(","))
    const res = await fetch(`${this.url}/api/logs?${params}`, { headers: this.headers })
    return res.json() as Promise<LogRow[]>
  }

  async tail(projectId?: string, n = 50): Promise<LogRow[]> {
    const params = new URLSearchParams({ n: String(n) })
    const pid = projectId ?? this.projectId
    if (pid) params.set("project_id", pid)
    const res = await fetch(`${this.url}/api/logs/tail?${params}`, { headers: this.headers })
    return res.json() as Promise<LogRow[]>
  }

  async summary(projectId?: string, since?: string): Promise<LogSummary[]> {
    const params = new URLSearchParams()
    const pid = projectId ?? this.projectId
    if (pid) params.set("project_id", pid)
    if (since) params.set("since", since)
    const res = await fetch(`${this.url}/api/logs/summary?${params}`, { headers: this.headers })
    return res.json() as Promise<LogSummary[]>
  }

  async context(traceId: string): Promise<LogRow[]> {
    const res = await fetch(`${this.url}/api/logs/${traceId}/context`, { headers: this.headers })
    return res.json() as Promise<LogRow[]>
  }

  async registerProject(name: string, githubRepo?: string, baseUrl?: string): Promise<Project> {
    const res = await fetch(`${this.url}/api/projects`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ name, github_repo: githubRepo, base_url: baseUrl }),
    })
    return res.json() as Promise<Project>
  }

  async registerPage(projectId: string, url: string, path?: string, name?: string): Promise<Page> {
    const res = await fetch(`${this.url}/api/projects/${projectId}/pages`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ url, path, name }),
    })
    return res.json() as Promise<Page>
  }

  async createScanJob(projectId: string, schedule: string, pageId?: string): Promise<ScanJob> {
    const res = await fetch(`${this.url}/api/jobs`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ project_id: projectId, schedule, page_id: pageId }),
    })
    return res.json() as Promise<ScanJob>
  }

  async perfSnapshot(projectId: string, pageId?: string): Promise<PerformanceSnapshot | null> {
    const params = new URLSearchParams({ project_id: projectId })
    if (pageId) params.set("page_id", pageId)
    const res = await fetch(`${this.url}/api/perf?${params}`, { headers: this.headers })
    return res.json() as Promise<PerformanceSnapshot | null>
  }

  async perfTrend(projectId: string, pageId?: string, since?: string, limit?: number): Promise<PerformanceSnapshot[]> {
    const params = new URLSearchParams({ project_id: projectId })
    if (pageId) params.set("page_id", pageId)
    if (since) params.set("since", since)
    if (limit) params.set("limit", String(limit))
    const res = await fetch(`${this.url}/api/perf/trend?${params}`, { headers: this.headers })
    return res.json() as Promise<PerformanceSnapshot[]>
  }
}

// Browser auto-capture init
export function initLogs(opts: { projectId: string; url?: string }): void {
  if (typeof window === "undefined") return
  const serverUrl = (opts.url ?? DEFAULT_URL).replace(/\/$/, "")
  const client = new LogsClient({ url: serverUrl, projectId: opts.projectId })
  const q: LogEntry[] = []
  const flush = () => { if (q.length) client.pushBatch(q.splice(0)).catch(() => {}) }
  setInterval(flush, 2000)

  const _ce = console.error.bind(console)
  console.error = (...args: unknown[]) => { _ce(...args); q.push({ level: "error", message: args.map(String).join(" "), source: "script", url: location.href }) }

  const _cw = console.warn.bind(console)
  console.warn = (...args: unknown[]) => { _cw(...args); q.push({ level: "warn", message: args.map(String).join(" "), source: "script", url: location.href }) }

  window.addEventListener("error", (e) => { q.push({ level: "error", message: e.message, stack_trace: e.error?.stack, source: "script", url: location.href }) })
  window.addEventListener("unhandledrejection", (e) => { q.push({ level: "error", message: `Unhandled: ${e.reason?.message ?? e.reason}`, stack_trace: e.reason?.stack, source: "script", url: location.href }) })
  window.addEventListener("beforeunload", flush)
}
