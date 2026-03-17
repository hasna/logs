export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal"
export type LogSource = "sdk" | "script" | "scanner"

export interface LogEntry {
  level: LogLevel
  message: string
  project_id?: string
  page_id?: string
  source?: LogSource
  service?: string
  trace_id?: string
  session_id?: string
  agent?: string
  url?: string
  stack_trace?: string
  metadata?: Record<string, unknown>
}

export interface LogRow {
  id: string; timestamp: string; project_id: string | null; page_id: string | null
  level: LogLevel; source: LogSource; service: string | null; message: string
  trace_id: string | null; session_id: string | null; agent: string | null
  url: string | null; stack_trace: string | null; metadata: string | null
}

export interface Project {
  id: string; name: string; github_repo: string | null; base_url: string | null
  description: string | null; created_at: string
}

export interface Page {
  id: string; project_id: string; url: string; path: string
  name: string | null; last_scanned_at: string | null; created_at: string
}

export interface ScanJob {
  id: string; project_id: string; page_id: string | null
  schedule: string; enabled: number; last_run_at: string | null; created_at: string
}

export interface PerformanceSnapshot {
  id: string; timestamp: string; project_id: string; page_id: string | null
  url: string; lcp: number | null; fcp: number | null; cls: number | null
  tti: number | null; ttfb: number | null; score: number | null; raw_audit: string | null
}

export interface LogQuery {
  project_id?: string; page_id?: string; level?: LogLevel | LogLevel[]
  service?: string; since?: string; until?: string; text?: string
  trace_id?: string; limit?: number; offset?: number; fields?: string[]
}

export interface LogSummary {
  project_id: string | null; service: string | null; page_id: string | null
  level: LogLevel; count: number; latest: string
}
