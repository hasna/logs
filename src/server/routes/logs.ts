import { Hono } from "hono"
import type { Database } from "bun:sqlite"
import { ingestBatch, ingestLog } from "../../lib/ingest.ts"
import { getLogContext, searchLogs, tailLogs } from "../../lib/query.ts"
import { summarizeLogs } from "../../lib/summarize.ts"
import { exportToCsv, exportToJson } from "../../lib/export.ts"
import { countLogs } from "../../lib/count.ts"
import { parseTime } from "../../lib/parse-time.ts"
import { resolveProjectId } from "../../lib/projects.ts"
import type { LogEntry, LogLevel } from "../../types/index.ts"

export function logsRoutes(db: Database) {
  const app = new Hono()

  // POST /api/logs — ingest single or batch
  app.post("/", async (c) => {
    const body = await c.req.json()
    if (Array.isArray(body)) {
      const rows = ingestBatch(db, body as LogEntry[])
      return c.json({ inserted: rows.length }, 201)
    }
    const row = ingestLog(db, body as LogEntry)
    return c.json(row, 201)
  })

  // GET /api/logs
  app.get("/", (c) => {
    const { project_id, page_id, level, service, since, until, text, trace_id, limit, offset, fields } = c.req.query()
    const rows = searchLogs(db, {
      project_id: project_id || undefined,
      page_id: page_id || undefined,
      level: level ? (level.split(",") as LogLevel[]) : undefined,
      service: service || undefined,
      since: since || undefined,
      until: until || undefined,
      text: text || undefined,
      trace_id: trace_id || undefined,
      limit: limit ? Number(limit) : 100,
      offset: offset ? Number(offset) : 0,
    })
    if (fields) {
      const keys = fields.split(",")
      return c.json(rows.map(r => Object.fromEntries(keys.map(k => [k, (r as Record<string, unknown>)[k]]))))
    }
    return c.json(rows)
  })

  // GET /api/logs/tail
  app.get("/tail", (c) => {
    const { project_id, n } = c.req.query()
    const rows = tailLogs(db, project_id || undefined, n ? Number(n) : 50)
    return c.json(rows)
  })

  // GET /api/logs/summary
  app.get("/summary", (c) => {
    const { project_id, since } = c.req.query()
    const summary = summarizeLogs(db, resolveProjectId(db, project_id) || undefined, parseTime(since) || since || undefined)
    return c.json(summary)
  })

  // GET /api/logs/count
  app.get("/count", (c) => {
    const { project_id, service, level, since, until } = c.req.query()
    return c.json(countLogs(db, {
      project_id: resolveProjectId(db, project_id) || undefined,
      service: service || undefined,
      level: level || undefined,
      since: since || undefined,
      until: until || undefined,
    }))
  })

  // GET /api/logs/recent-errors
  app.get("/recent-errors", (c) => {
    const { project_id, since, limit } = c.req.query()
    const rows = searchLogs(db, {
      project_id: resolveProjectId(db, project_id) || undefined,
      level: ["error", "fatal"],
      since: parseTime(since || "1h"),
      limit: limit ? Number(limit) : 20,
    })
    return c.json(rows.map(r => ({ id: r.id, timestamp: r.timestamp, level: r.level, message: r.message, service: r.service, age_seconds: Math.floor((Date.now() - new Date(r.timestamp).getTime()) / 1000) })))
  })

  // GET /api/logs/:trace_id/context
  app.get("/:trace_id/context", (c) => {
    const rows = getLogContext(db, c.req.param("trace_id"))
    return c.json(rows)
  })

  // GET /api/logs/export?format=json|csv&project_id=&since=&level=
  app.get("/export", (c) => {
    const { project_id, since, until, level, service, format, limit } = c.req.query()
    const opts = { project_id: project_id || undefined, since: since || undefined, until: until || undefined, level: level || undefined, service: service || undefined, limit: limit ? Number(limit) : undefined }

    if (format === "csv") {
      c.header("Content-Type", "text/csv")
      c.header("Content-Disposition", "attachment; filename=logs.csv")
      const chunks: string[] = []
      exportToCsv(db, opts, s => chunks.push(s))
      return c.text(chunks.join(""))
    }

    c.header("Content-Type", "application/json")
    c.header("Content-Disposition", "attachment; filename=logs.json")
    const chunks: string[] = []
    exportToJson(db, opts, s => chunks.push(s))
    return c.text(chunks.join("\n"))
  })

  return app
}
