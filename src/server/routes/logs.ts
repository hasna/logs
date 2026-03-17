import { Hono } from "hono"
import type { Database } from "bun:sqlite"
import { ingestBatch, ingestLog } from "../../lib/ingest.ts"
import { getLogContext, searchLogs, tailLogs } from "../../lib/query.ts"
import { summarizeLogs } from "../../lib/summarize.ts"
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
    const summary = summarizeLogs(db, project_id || undefined, since || undefined)
    return c.json(summary)
  })

  // GET /api/logs/:trace_id/context
  app.get("/:trace_id/context", (c) => {
    const rows = getLogContext(db, c.req.param("trace_id"))
    return c.json(rows)
  })

  return app
}
