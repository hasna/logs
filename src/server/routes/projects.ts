import { Hono } from "hono"
import type { Database } from "bun:sqlite"
import { createPage, createProject, getProject, listPages, listProjects } from "../../lib/projects.ts"
import { syncGithubRepo } from "../../lib/github.ts"

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

  app.post("/:id/sync-repo", async (c) => {
    const project = getProject(db, c.req.param("id"))
    if (!project) return c.json({ error: "not found" }, 404)
    if (!project.github_repo) return c.json({ error: "no github_repo set" }, 422)
    const updated = await syncGithubRepo(db, project)
    return c.json(updated)
  })

  return app
}
