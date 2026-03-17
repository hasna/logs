import type { Database } from "bun:sqlite"
import type { LogRow } from "../types/index.ts"

export interface ExportOptions {
  project_id?: string
  since?: string
  until?: string
  level?: string
  service?: string
  limit?: number
}

function* iterLogs(db: Database, opts: ExportOptions): Generator<LogRow> {
  const conditions: string[] = []
  const params: Record<string, unknown> = {}
  if (opts.project_id) { conditions.push("project_id = $p"); params.$p = opts.project_id }
  if (opts.since) { conditions.push("timestamp >= $since"); params.$since = opts.since }
  if (opts.until) { conditions.push("timestamp <= $until"); params.$until = opts.until }
  if (opts.level) { conditions.push("level = $level"); params.$level = opts.level }
  if (opts.service) { conditions.push("service = $service"); params.$service = opts.service }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""
  const limit = opts.limit ?? 100_000

  // Batch in pages of 1000 to avoid memory issues
  let offset = 0
  while (offset < limit) {
    const batch = db.prepare(`SELECT * FROM logs ${where} ORDER BY timestamp ASC LIMIT 1000 OFFSET $offset`)
      .all({ ...params, $offset: offset }) as LogRow[]
    if (!batch.length) break
    yield* batch
    offset += batch.length
    if (batch.length < 1000) break
  }
}

export function exportToJson(db: Database, opts: ExportOptions, writeLine: (s: string) => void): number {
  writeLine("[")
  let count = 0
  for (const row of iterLogs(db, opts)) {
    writeLine((count > 0 ? "," : "") + JSON.stringify(row))
    count++
  }
  writeLine("]")
  return count
}

const CSV_HEADER = "id,timestamp,level,service,message,trace_id,url\n"

export function exportToCsv(db: Database, opts: ExportOptions, writeLine: (s: string) => void): number {
  writeLine(CSV_HEADER)
  let count = 0
  for (const row of iterLogs(db, opts)) {
    const fields = [row.id, row.timestamp, row.level, row.service ?? "", escapeCSV(row.message), row.trace_id ?? "", row.url ?? ""]
    writeLine(fields.join(",") + "\n")
    count++
  }
  return count
}

function escapeCSV(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}
