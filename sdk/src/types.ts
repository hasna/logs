export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal"
export type LogSource =
  | "sdk"
  | "script"
  | "scanner"
  | "browser"
  | "node"
  | "bun"
  | "next"
  | "vite"
  | "cli"
  | "build"
  | "test"
  | "mcp"
  | "agent"
  | "otel"
  | "system"
  | "pino"
  | "winston"
  | "structured"

export type PrivacyClass = "public" | "internal" | "sensitive" | "secret" | "pii"

export type UniversalEventType =
  | "log"
  | "exception"
  | "span"
  | "metric"
  | "profile"
  | "replay"
  | "monitor"
  | "release"
  | "build"
  | "process"
  | "agent"
  | "artifact"
  | "network"
  | "filesystem"
  | "session"

export interface UniversalEvent {
  schema_version?: number
  event_id?: string
  id?: string
  source_event_id?: string | null
  event_time?: string
  timestamp?: string
  type: UniversalEventType
  source?: string
  severity?: LogLevel | null
  level?: LogLevel | null
  privacy?: PrivacyClass | null
  project_id?: string | null
  page_id?: string | null
  machine_id?: string | null
  repo_id?: string | null
  app_id?: string | null
  process_id?: string | null
  run_id?: string | null
  trace_id?: string | null
  span_id?: string | null
  parent_span_id?: string | null
  session_id?: string | null
  release_id?: string | null
  environment?: string | null
  artifact_id?: string | null
  message?: string | null
  body?: Record<string, unknown>
  attributes?: Record<string, unknown>
  metadata?: Record<string, unknown>
}

export interface EventCatalogEntry {
  event_id: string
  schema_version: number
  source_event_id: string | null
  event_type: UniversalEventType | string
  event_time: string
  ingest_time: string
  severity: string | null
  source: string
  project_id: string | null
  page_id: string | null
  machine_id: string | null
  repo_id: string | null
  app_id: string | null
  process_id: string | null
  run_id: string | null
  trace_id: string | null
  span_id: string | null
  parent_span_id: string | null
  session_id: string | null
  release_id: string | null
  environment: string | null
  artifact_id: string | null
  privacy_tier: string | null
  log_id: string | null
  segment_id: string
  message: string | null
  segment_path: string
  byte_offset: number
  byte_length: number
  record_hash: string
  created_at: string
  metadata: Record<string, unknown> | null
  raw?: UniversalEvent | null
}

export interface EventBatchResult {
  inserted: number
  events: EventCatalogEntry[]
}

export type StructuredLogFormat = "auto" | "pino" | "winston" | "json"

export interface StructuredLogIngestEvent {
  id: string
  timestamp: string
  level: LogLevel
  source: LogSource
  service: string | null
  message: string
  trace_id: string | null
}

export interface StructuredLogIngestResult {
  inserted: number
  events: StructuredLogIngestEvent[]
}

export interface UniversalLogsOptions {
  url?: string
  projectId: string
  apiKey?: string
  browserToken?: string
  source?: string
  environment?: string
  releaseId?: string
  appId?: string
  machineId?: string
  repoId?: string
  processId?: string
  runId?: string
  sessionId?: string
  captureConsole?: boolean
  captureExceptions?: boolean
  captureRejections?: boolean
  captureFetch?: boolean
  propagateTrace?: boolean
  tracePropagationTargets?: Array<string | RegExp>
  captureNavigation?: boolean
  captureResourceTiming?: boolean
  maxResourceTimingEvents?: number
  captureWebVitals?: boolean
  maxWebVitalEvents?: number
  captureProcess?: boolean
  flushIntervalMs?: number
  maxBatchSize?: number
  maxQueueSize?: number
  browserSpool?: boolean
  browserSpoolKey?: string
}

export interface UniversalLogsController {
  flush(): Promise<void>
  stop(): void
}

export interface HttpRequestCaptureOptions {
  url?: string
  projectId?: string
  apiKey?: string
  browserToken?: string
  source?: string
  environment?: string
  releaseId?: string
  appId?: string
  machineId?: string
  repoId?: string
  processId?: string
  runId?: string
  sessionId?: string
  client?: {
    pushEvent(event: UniversalEvent): Promise<EventCatalogEntry>
    pushEvents(events: UniversalEvent[]): Promise<EventBatchResult>
  }
  framework?: string
  route?: string | ((request: Request) => string | undefined)
  operation?: string
  requestHeaderNames?: string[]
  responseHeaderNames?: string[]
  waitForTelemetry?: boolean
}

export interface LogEntry {
  id?: string
  timestamp?: string
  source_event_id?: string
  level: LogLevel
  message: string
  project_id?: string
  page_id?: string
  source?: LogSource
  service?: string
  privacy?: PrivacyClass
  machine_id?: string
  repo_id?: string
  app_id?: string
  process_id?: string
  run_id?: string
  trace_id?: string
  span_id?: string
  parent_span_id?: string
  session_id?: string
  release_id?: string
  environment?: string
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
