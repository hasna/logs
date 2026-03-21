import type { Database } from "bun:sqlite"
import { parseTime } from "./parse-time.ts"

export interface LogCount {
  total: number
  errors: number
  warns: number
  fatals: number
  by_level: Record<string, number>
  by_service?: Record<string, number>
}

export function countLogs(db: Database, opts: {
  project_id?: string
  service?: string
  level?: string
  since?: string
  until?: string
  group_by?: "level" | "service"
}): LogCount {
  const conditions: string[] = []
  const params: Record<string, unknown> = {}

  if (opts.project_id) { conditions.push("project_id = $p"); params.$p = opts.project_id }
  if (opts.service) { conditions.push("service = $service"); params.$service = opts.service }
  if (opts.level) { conditions.push("level = $level"); params.$level = opts.level }
  const since = parseTime(opts.since)
  const until = parseTime(opts.until)
  if (since) { conditions.push("timestamp >= $since"); params.$since = since }
  if (until) { conditions.push("timestamp <= $until"); params.$until = until }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""

  const byLevel = db.prepare(`SELECT level, COUNT(*) as c FROM logs ${where} GROUP BY level`)
    .all(params) as { level: string; c: number }[]

  const by_level = Object.fromEntries(byLevel.map(r => [r.level, r.c]))
  const total = byLevel.reduce((s, r) => s + r.c, 0)

  let by_service: Record<string, number> | undefined
  if (opts.group_by === "service") {
    const bySvc = db.prepare(`SELECT COALESCE(service, '-') as service, COUNT(*) as c FROM logs ${where} GROUP BY service ORDER BY c DESC`)
      .all(params) as { service: string; c: number }[]
    by_service = Object.fromEntries(bySvc.map(r => [r.service, r.c]))
  }

  return {
    total,
    errors: by_level["error"] ?? 0,
    warns: by_level["warn"] ?? 0,
    fatals: by_level["fatal"] ?? 0,
    by_level,
    by_service,
  }
}
