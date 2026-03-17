import type { Database } from "bun:sqlite"
import type { LogEntry, LogRow } from "../types/index.ts"
import { upsertIssue } from "./issues.ts"
import { evaluateAlerts } from "./alerts.ts"

const ERROR_LEVELS = new Set(["warn", "error", "fatal"])

export function ingestLog(db: Database, entry: LogEntry): LogRow {
  const stmt = db.prepare(`
    INSERT INTO logs (project_id, page_id, level, source, service, message, trace_id, session_id, agent, url, stack_trace, metadata)
    VALUES ($project_id, $page_id, $level, $source, $service, $message, $trace_id, $session_id, $agent, $url, $stack_trace, $metadata)
    RETURNING *
  `)
  const row = stmt.get({
    $project_id: entry.project_id ?? null,
    $page_id: entry.page_id ?? null,
    $level: entry.level,
    $source: entry.source ?? "sdk",
    $service: entry.service ?? null,
    $message: entry.message,
    $trace_id: entry.trace_id ?? null,
    $session_id: entry.session_id ?? null,
    $agent: entry.agent ?? null,
    $url: entry.url ?? null,
    $stack_trace: entry.stack_trace ?? null,
    $metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
  }) as LogRow

  // Side effects: issue grouping + alert evaluation (fire-and-forget)
  if (ERROR_LEVELS.has(entry.level)) {
    if (entry.project_id) {
      upsertIssue(db, { project_id: entry.project_id, level: entry.level, service: entry.service, message: entry.message, stack_trace: entry.stack_trace })
      evaluateAlerts(db, entry.project_id, entry.service ?? null, entry.level).catch(() => {})
    }
  }

  return row
}

export function ingestBatch(db: Database, entries: LogEntry[]): LogRow[] {
  const insert = db.prepare(`
    INSERT INTO logs (project_id, page_id, level, source, service, message, trace_id, session_id, agent, url, stack_trace, metadata)
    VALUES ($project_id, $page_id, $level, $source, $service, $message, $trace_id, $session_id, $agent, $url, $stack_trace, $metadata)
    RETURNING *
  `)
  const tx = db.transaction((items: LogEntry[]) =>
    items.map(entry =>
      insert.get({
        $project_id: entry.project_id ?? null,
        $page_id: entry.page_id ?? null,
        $level: entry.level,
        $source: entry.source ?? "sdk",
        $service: entry.service ?? null,
        $message: entry.message,
        $trace_id: entry.trace_id ?? null,
        $session_id: entry.session_id ?? null,
        $agent: entry.agent ?? null,
        $url: entry.url ?? null,
        $stack_trace: entry.stack_trace ?? null,
        $metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
      }) as LogRow
    )
  )
  const rows = tx(entries)

  // Issue grouping for error-level entries (outside transaction for perf)
  for (const entry of entries) {
    if (ERROR_LEVELS.has(entry.level) && entry.project_id) {
      upsertIssue(db, { project_id: entry.project_id, level: entry.level, service: entry.service, message: entry.message, stack_trace: entry.stack_trace })
    }
  }

  return rows
}
