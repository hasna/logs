import type { Database } from "bun:sqlite"
import type { LogQuery, LogRow } from "../types/index.ts"
import { parseTime } from "./parse-time.ts"

export function searchLogs(db: Database, q: LogQuery): LogRow[] {
  const conditions: string[] = []
  const params: Record<string, unknown> = {}

  if (q.project_id) { conditions.push("l.project_id = $project_id"); params.$project_id = q.project_id }
  if (q.page_id) { conditions.push("l.page_id = $page_id"); params.$page_id = q.page_id }
  if (q.service) { conditions.push("l.service = $service"); params.$service = q.service }
  if (q.trace_id) { conditions.push("l.trace_id = $trace_id"); params.$trace_id = q.trace_id }
  if (q.since) { conditions.push("l.timestamp >= $since"); params.$since = parseTime(q.since) ?? q.since }
  if (q.until) { conditions.push("l.timestamp <= $until"); params.$until = parseTime(q.until) ?? q.until }

  if (q.level) {
    const levels = Array.isArray(q.level) ? q.level : [q.level]
    const placeholders = levels.map((_, i) => `$level${i}`).join(",")
    levels.forEach((lv, i) => { params[`$level${i}`] = lv })
    conditions.push(`l.level IN (${placeholders})`)
  }

  const limit = q.limit ?? 100
  const offset = q.offset ?? 0
  params.$limit = limit
  params.$offset = offset

  if (q.text) {
    // FTS search via subquery
    params.$text = q.text
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")} AND` : "WHERE"
    const sql = `
      SELECT l.* FROM logs l
      ${where} l.rowid IN (SELECT rowid FROM logs_fts WHERE logs_fts MATCH $text)
      ORDER BY l.timestamp DESC
      LIMIT $limit OFFSET $offset
    `
    return db.prepare(sql).all(params) as LogRow[]
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""
  const sql = `SELECT * FROM logs l ${where} ORDER BY l.timestamp DESC LIMIT $limit OFFSET $offset`
  return db.prepare(sql).all(params) as LogRow[]
}

export function tailLogs(db: Database, projectId?: string, n = 50): LogRow[] {
  if (projectId) {
    return db.prepare("SELECT * FROM logs WHERE project_id = $p ORDER BY timestamp DESC LIMIT $n")
      .all({ $p: projectId, $n: n }) as LogRow[]
  }
  return db.prepare("SELECT * FROM logs ORDER BY timestamp DESC LIMIT $n").all({ $n: n }) as LogRow[]
}

export function getLogContext(db: Database, traceId: string): LogRow[] {
  return db.prepare("SELECT * FROM logs WHERE trace_id = $t ORDER BY timestamp ASC")
    .all({ $t: traceId }) as LogRow[]
}

export function getLogContextFromId(db: Database, logId: string, window = 0): LogRow[] {
  const log = db.prepare("SELECT * FROM logs WHERE id = $id").get({ $id: logId }) as LogRow | null
  if (!log) return []

  // Get trace context (or just the log itself if no trace)
  const trace: LogRow[] = log.trace_id ? getLogContext(db, log.trace_id) : [log]

  if (window <= 0) return trace

  // Fetch N rows before and after the target log's timestamp
  const before = db.prepare(
    `SELECT * FROM logs WHERE id != $id AND timestamp <= $ts ORDER BY timestamp DESC LIMIT $n`
  ).all({ $id: logId, $ts: log.timestamp, $n: window }) as LogRow[]

  const after = db.prepare(
    `SELECT * FROM logs WHERE id != $id AND timestamp > $ts ORDER BY timestamp ASC LIMIT $n`
  ).all({ $id: logId, $ts: log.timestamp, $n: window }) as LogRow[]

  // Merge: before (oldest first) + trace + after, deduplicate by id
  const seen = new Set<string>()
  const merged: LogRow[] = []
  for (const row of [...before.reverse(), ...trace, ...after]) {
    if (!seen.has(row.id)) { seen.add(row.id); merged.push(row) }
  }
  return merged.sort((a, b) => a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0)
}
