import { describe, expect, it, beforeEach } from "bun:test"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { createTestDb } from "../db/index.ts"
import { logsRoutes } from "./routes/logs.ts"
import { projectsRoutes } from "./routes/projects.ts"
import { jobsRoutes } from "./routes/jobs.ts"
import { perfRoutes } from "./routes/perf.ts"

function buildApp() {
  const db = createTestDb()
  const app = new Hono()
  app.use("*", cors())
  app.route("/api/logs", logsRoutes(db))
  app.route("/api/projects", projectsRoutes(db))
  app.route("/api/jobs", jobsRoutes(db))
  app.route("/api/perf", perfRoutes(db))
  return { app, db }
}

describe("POST /api/logs", () => {
  it("ingests a single log", async () => {
    const { app } = buildApp()
    const res = await app.request("/api/logs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ level: "error", message: "boom" }) })
    expect(res.status).toBe(201)
    const body = await res.json() as { level: string; message: string }
    expect(body.level).toBe("error")
    expect(body.message).toBe("boom")
  })

  it("ingests a batch", async () => {
    const { app } = buildApp()
    const res = await app.request("/api/logs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify([{ level: "info", message: "a" }, { level: "warn", message: "b" }]) })
    expect(res.status).toBe(201)
    const body = await res.json() as { inserted: number }
    expect(body.inserted).toBe(2)
  })
})

describe("GET /api/logs", () => {
  it("lists logs", async () => {
    const { app, db } = buildApp()
    const { ingestBatch } = await import("../lib/ingest.ts")
    ingestBatch(db, [{ level: "error", message: "e1" }, { level: "info", message: "i1" }])
    const res = await app.request("/api/logs")
    expect(res.status).toBe(200)
    const body = await res.json() as unknown[]
    expect(body.length).toBeGreaterThanOrEqual(2)
  })

  it("filters by level", async () => {
    const { app, db } = buildApp()
    const { ingestBatch } = await import("../lib/ingest.ts")
    ingestBatch(db, [{ level: "error", message: "e1" }, { level: "info", message: "i1" }])
    const res = await app.request("/api/logs?level=error")
    const body = await res.json() as { level: string }[]
    expect(body.every(r => r.level === "error")).toBe(true)
  })

  it("supports ?fields= projection", async () => {
    const { app, db } = buildApp()
    const { ingestLog } = await import("../lib/ingest.ts")
    ingestLog(db, { level: "info", message: "hello" })
    const res = await app.request("/api/logs?fields=level,message")
    const body = await res.json() as Record<string, unknown>[]
    expect(Object.keys(body[0]!).sort()).toEqual(["level", "message"].sort())
  })
})

describe("GET /api/logs/tail", () => {
  it("returns recent logs", async () => {
    const { app, db } = buildApp()
    const { ingestBatch } = await import("../lib/ingest.ts")
    ingestBatch(db, Array.from({ length: 10 }, (_, i) => ({ level: "info" as const, message: `m${i}` })))
    const res = await app.request("/api/logs/tail?n=5")
    const body = await res.json() as unknown[]
    expect(body).toHaveLength(5)
  })
})

describe("GET /api/logs/summary", () => {
  it("returns summary of errors/warns", async () => {
    const { app, db } = buildApp()
    const { ingestBatch } = await import("../lib/ingest.ts")
    ingestBatch(db, [{ level: "error", message: "x", service: "api" }, { level: "warn", message: "y", service: "db" }])
    const res = await app.request("/api/logs/summary")
    const body = await res.json() as unknown[]
    expect(body.length).toBeGreaterThan(0)
  })
})

describe("GET /api/logs/:trace_id/context", () => {
  it("returns logs for trace", async () => {
    const { app, db } = buildApp()
    const { ingestBatch } = await import("../lib/ingest.ts")
    ingestBatch(db, [{ level: "info", message: "a", trace_id: "t99" }, { level: "error", message: "b", trace_id: "t99" }])
    const res = await app.request("/api/logs/t99/context")
    const body = await res.json() as unknown[]
    expect(body).toHaveLength(2)
  })
})

describe("POST /api/projects", () => {
  it("creates a project", async () => {
    const { app } = buildApp()
    const res = await app.request("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "myapp" }) })
    expect(res.status).toBe(201)
    const body = await res.json() as { name: string }
    expect(body.name).toBe("myapp")
  })

  it("returns 422 without name", async () => {
    const { app } = buildApp()
    const res = await app.request("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })
    expect(res.status).toBe(422)
  })
})

describe("GET /api/projects", () => {
  it("lists projects", async () => {
    const { app } = buildApp()
    await app.request("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "p1" }) })
    const res = await app.request("/api/projects")
    const body = await res.json() as unknown[]
    expect(body.length).toBeGreaterThanOrEqual(1)
  })
})

describe("POST /api/projects/:id/pages", () => {
  it("registers a page", async () => {
    const { app } = buildApp()
    const pRes = await app.request("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "app" }) })
    const project = await pRes.json() as { id: string }
    const res = await app.request(`/api/projects/${project.id}/pages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://app.com/home" }) })
    expect(res.status).toBe(201)
    const page = await res.json() as { url: string }
    expect(page.url).toBe("https://app.com/home")
  })

  it("returns 422 without url", async () => {
    const { app } = buildApp()
    const pRes = await app.request("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "app2" }) })
    const project = await pRes.json() as { id: string }
    const res = await app.request(`/api/projects/${project.id}/pages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })
    expect(res.status).toBe(422)
  })
})

describe("jobs routes", () => {
  it("creates and lists jobs", async () => {
    const { app } = buildApp()
    const pRes = await app.request("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "appj" }) })
    const { id } = await pRes.json() as { id: string }
    const jRes = await app.request("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_id: id, schedule: "*/5 * * * *" }) })
    expect(jRes.status).toBe(201)
    const listRes = await app.request(`/api/jobs?project_id=${id}`)
    const jobs = await listRes.json() as unknown[]
    expect(jobs).toHaveLength(1)
  })

  it("returns 422 without required fields", async () => {
    const { app } = buildApp()
    const res = await app.request("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })
    expect(res.status).toBe(422)
  })

  it("deletes a job", async () => {
    const { app } = buildApp()
    const pRes = await app.request("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "appd" }) })
    const { id } = await pRes.json() as { id: string }
    const jRes = await app.request("/api/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ project_id: id, schedule: "*/5 * * * *" }) })
    const job = await jRes.json() as { id: string }
    const del = await app.request(`/api/jobs/${job.id}`, { method: "DELETE" })
    expect(del.status).toBe(200)
  })
})

describe("perf routes", () => {
  it("returns 422 without project_id", async () => {
    const { app } = buildApp()
    const res = await app.request("/api/perf")
    expect(res.status).toBe(422)
  })

  it("returns null when no snapshot exists", async () => {
    const { app } = buildApp()
    const pRes = await app.request("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "perf-app" }) })
    const { id } = await pRes.json() as { id: string }
    const res = await app.request(`/api/perf?project_id=${id}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toBeNull()
  })
})
