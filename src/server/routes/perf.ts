import { Hono } from "hono"
import type { Database } from "bun:sqlite"
import { getLatestSnapshot, getPerfTrend } from "../../lib/perf.ts"

export function perfRoutes(db: Database) {
  const app = new Hono()

  app.get("/", (c) => {
    const { project_id, page_id, since } = c.req.query()
    if (!project_id) return c.json({ error: "project_id is required" }, 422)
    const snap = getLatestSnapshot(db, project_id, page_id || undefined)
    return c.json(snap)
  })

  app.get("/trend", (c) => {
    const { project_id, page_id, since, limit } = c.req.query()
    if (!project_id) return c.json({ error: "project_id is required" }, 422)
    const trend = getPerfTrend(db, project_id, page_id || undefined, since || undefined, limit ? Number(limit) : 50)
    return c.json(trend)
  })

  return app
}
