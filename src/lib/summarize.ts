import type { Database } from "bun:sqlite"
import type { LogSummary } from "../types/index.ts"
import { parseTime } from "./parse-time.ts"

export function summarizeLogs(db: Database, projectId?: string, since?: string, until?: string): LogSummary[] {
  const conditions: string[] = ["level IN ('warn','error','fatal')"]
  const params: Record<string, unknown> = {}

  if (projectId) { conditions.push("project_id = $project_id"); params.$project_id = projectId }
  if (since) { conditions.push("timestamp >= $since"); params.$since = parseTime(since) ?? since }
  if (until) { conditions.push("timestamp <= $until"); params.$until = parseTime(until) ?? until }

  const where = `WHERE ${conditions.join(" AND ")}`
  const sql = `
    SELECT project_id, service, page_id, level,
           COUNT(*) as count,
           MAX(timestamp) as latest
    FROM logs ${where}
    GROUP BY project_id, service, page_id, level
    ORDER BY count DESC
  `
  return db.prepare(sql).all(params) as LogSummary[]
}
