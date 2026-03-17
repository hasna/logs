import { Hono } from "hono"
import type { Database } from "bun:sqlite"
import { createPage, createProject, getProject, listPages, listProjects } from "../../lib/projects.ts"
import { syncGithubRepo } from "../../lib/github.ts"
import { runRetentionForProject, setRetentionPolicy } from "../../lib/retention.ts"
import { deletePageAuth, setPageAuth } from "../../lib/page-auth.ts"

export function projectsRoutes(db: Database) {
  const app = new Hono()

  app.post("/", async (c) => {
    const body = await c.req.json()
    if (!body.name) return c.json({ error: "name is required" }, 422)
    const project = createProject(db, body)
    return c.json(project, 201)
  })

  app.get("/", (c) => c.json(listProjects(db)))

  app.get("/:id", (c) => {
    const project = getProject(db, c.req.param("id"))
    if (!project) return c.json({ error: "not found" }, 404)
    return c.json(project)
  })

  app.post("/:id/pages", async (c) => {
    const body = await c.req.json()
    if (!body.url) return c.json({ error: "url is required" }, 422)
    const page = createPage(db, { ...body, project_id: c.req.param("id") })
    return c.json(page, 201)
  })

  app.get("/:id/pages", (c) => c.json(listPages(db, c.req.param("id"))))

  app.put("/:id/retention", async (c) => {
    const body = await c.req.json()
    setRetentionPolicy(db, c.req.param("id"), body)
    return c.json({ updated: true })
  })

  app.post("/:id/retention/run", (c) => {
    const result = runRetentionForProject(db, c.req.param("id"))
    return c.json(result)
  })

  app.post("/:id/pages/:page_id/auth", async (c) => {
    const { type, credentials } = await c.req.json()
    if (!type || !credentials) return c.json({ error: "type and credentials required" }, 422)
    const result = setPageAuth(db, c.req.param("page_id"), type, credentials)
    return c.json({ id: result.id, type: result.type, created_at: result.created_at }, 201)
  })

  app.delete("/:id/pages/:page_id/auth", (c) => {
    deletePageAuth(db, c.req.param("page_id"))
    return c.json({ deleted: true })
  })

  app.post("/:id/sync-repo", async (c) => {
    const project = getProject(db, c.req.param("id"))
    if (!project) return c.json({ error: "not found" }, 404)
    if (!project.github_repo) return c.json({ error: "no github_repo set" }, 422)
    const updated = await syncGithubRepo(db, project)
    return c.json(updated)
  })

  return app
}
