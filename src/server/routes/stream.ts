import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import type { Database } from "bun:sqlite"
import type { LogLevel, LogRow } from "../../types/index.ts"

export function streamRoutes(db: Database) {
  const app = new Hono()

  // GET /api/logs/stream?project_id=&level=&service=
  app.get("/", (c) => {
    const { project_id, level, service } = c.req.query()

    return streamSSE(c, async (stream) => {
      let lastId: string | null = null

      // Seed lastId with the most recent log so we only stream new ones
      const latest = db.prepare("SELECT id FROM logs ORDER BY timestamp DESC LIMIT 1").get() as { id: string } | null
      lastId = latest?.id ?? null

      while (true) {
        const conditions: string[] = []
        const params: Record<string, unknown> = {}

        if (lastId) { conditions.push("rowid > (SELECT rowid FROM logs WHERE id = $lastId)"); params.$lastId = lastId }
        if (project_id) { conditions.push("project_id = $project_id"); params.$project_id = project_id }
        if (level) { conditions.push("level IN (" + level.split(",").map((l, i) => `$l${i}`).join(",") + ")"); level.split(",").forEach((l, i) => { params[`$l${i}`] = l }) }
        if (service) { conditions.push("service = $service"); params.$service = service }

        const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""
        const rows = db.prepare(`SELECT * FROM logs ${where} ORDER BY timestamp ASC LIMIT 50`).all(params) as LogRow[]

        for (const row of rows) {
          await stream.writeSSE({ data: JSON.stringify(row), id: row.id, event: row.level })
          lastId = row.id
        }

        await stream.sleep(500)
      }
    })
  })

  return app
}
