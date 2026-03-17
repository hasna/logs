import { Hono } from "hono"
import type { Database } from "bun:sqlite"
import { createAlertRule, deleteAlertRule, listAlertRules, updateAlertRule } from "../../lib/alerts.ts"

export function alertsRoutes(db: Database) {
  const app = new Hono()

  app.post("/", async (c) => {
    const body = await c.req.json()
    if (!body.project_id || !body.name) return c.json({ error: "project_id and name required" }, 422)
    return c.json(createAlertRule(db, body), 201)
  })

  app.get("/", (c) => {
    const { project_id } = c.req.query()
    return c.json(listAlertRules(db, project_id || undefined))
  })

  app.put("/:id", async (c) => {
    const body = await c.req.json()
    const updated = updateAlertRule(db, c.req.param("id"), body)
    if (!updated) return c.json({ error: "not found" }, 404)
    return c.json(updated)
  })

  app.delete("/:id", (c) => {
    deleteAlertRule(db, c.req.param("id"))
    return c.json({ deleted: true })
  })

  return app
}
