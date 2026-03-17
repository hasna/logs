import type { Database } from "bun:sqlite"
import type { LogEntry, LogRow } from "../types/index.ts"

export function ingestLog(db: Database, entry: LogEntry): LogRow {
  const stmt = db.prepare(`
    INSERT INTO logs (project_id, page_id, level, source, service, message, trace_id, session_id, agent, url, stack_trace, metadata)
    VALUES ($project_id, $page_id, $level, $source, $service, $message, $trace_id, $session_id, $agent, $url, $stack_trace, $metadata)
    RETURNING *
  `)
  return stmt.get({
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
  return tx(entries)
}
