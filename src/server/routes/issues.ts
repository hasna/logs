import { Hono } from "hono"
import type { Database } from "bun:sqlite"
import { getIssue, listIssues, updateIssueStatus } from "../../lib/issues.ts"
import { searchLogs } from "../../lib/query.ts"

export function issuesRoutes(db: Database) {
  const app = new Hono()

  app.get("/", (c) => {
    const { project_id, status, limit } = c.req.query()
    return c.json(listIssues(db, project_id || undefined, status || undefined, limit ? Number(limit) : 50))
  })

  app.get("/:id", (c) => {
    const issue = getIssue(db, c.req.param("id"))
    if (!issue) return c.json({ error: "not found" }, 404)
    return c.json(issue)
  })

  app.get("/:id/logs", (c) => {
    const issue = getIssue(db, c.req.param("id"))
    if (!issue) return c.json({ error: "not found" }, 404)
    // Search logs matching this issue's fingerprint via service+level
    const rows = searchLogs(db, {
      project_id: issue.project_id ?? undefined,
      level: issue.level as "error",
      service: issue.service ?? undefined,
      text: issue.message_template.slice(0, 50),
      limit: 50,
    })
    return c.json(rows)
  })

  app.put("/:id", async (c) => {
    const { status } = await c.req.json() as { status: "open" | "resolved" | "ignored" }
    if (!["open", "resolved", "ignored"].includes(status)) return c.json({ error: "invalid status" }, 422)
    const updated = updateIssueStatus(db, c.req.param("id"), status)
    if (!updated) return c.json({ error: "not found" }, 404)
    return c.json(updated)
  })

  return app
}
