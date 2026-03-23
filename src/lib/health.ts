import type { Database } from "bun:sqlite"

const startTime = Date.now()

export interface HealthResult {
  status: "ok"
  uptime_seconds: number
  db_size_bytes: number | null
  projects: number
  total_logs: number
  logs_by_level: Record<string, number>
  oldest_log: string | null
  newest_log: string | null
  scheduler_jobs: number
  open_issues: number
}

export function getHealth(db: Database): HealthResult {
  const projects = (db.prepare("SELECT COUNT(*) as c FROM projects").get() as { c: number }).c
  const total_logs = (db.prepare("SELECT COUNT(*) as c FROM logs").get() as { c: number }).c
  const scheduler_jobs = (db.prepare("SELECT COUNT(*) as c FROM scan_jobs WHERE enabled = 1").get() as { c: number }).c
  const open_issues = (db.prepare("SELECT COUNT(*) as c FROM issues WHERE status = 'open'").get() as { c: number }).c

  const levelRows = db.prepare("SELECT level, COUNT(*) as c FROM logs GROUP BY level").all() as { level: string; c: number }[]
  const logs_by_level = Object.fromEntries(levelRows.map(r => [r.level, r.c]))

  const oldest = db.prepare("SELECT MIN(timestamp) as t FROM logs").get() as { t: string | null }
  const newest = db.prepare("SELECT MAX(timestamp) as t FROM logs").get() as { t: string | null }

  let db_size_bytes: number | null = null
  try {
    const dbPath = process.env.HASNA_LOGS_DB_PATH ?? process.env.LOGS_DB_PATH
    if (dbPath) {
      const { statSync } = require("node:fs")
      db_size_bytes = statSync(dbPath).size
    }
  } catch { /* in-memory or not accessible */ }

  return {
    status: "ok",
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    db_size_bytes,
    projects,
    total_logs,
    logs_by_level,
    oldest_log: oldest.t,
    newest_log: newest.t,
    scheduler_jobs,
    open_issues,
  }
}
