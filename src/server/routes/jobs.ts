import { Hono } from "hono"
import type { Database } from "bun:sqlite"
import { createJob, deleteJob, listJobs, updateJob } from "../../lib/jobs.ts"

export function jobsRoutes(db: Database) {
  const app = new Hono()

  app.post("/", async (c) => {
    const body = await c.req.json()
    if (!body.project_id || !body.schedule) return c.json({ error: "project_id and schedule are required" }, 422)
    return c.json(createJob(db, body), 201)
  })

  app.get("/", (c) => {
    const { project_id } = c.req.query()
    return c.json(listJobs(db, project_id || undefined))
  })

  app.put("/:id", async (c) => {
    const body = await c.req.json()
    const updated = updateJob(db, c.req.param("id"), body)
    if (!updated) return c.json({ error: "not found" }, 404)
    return c.json(updated)
  })

  app.delete("/:id", (c) => {
    deleteJob(db, c.req.param("id"))
    return c.json({ deleted: true })
  })

  return app
}
