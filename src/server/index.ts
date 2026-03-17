#!/usr/bin/env bun
import { Hono } from "hono"
import { cors } from "hono/cors"
import { serveStatic } from "hono/bun"
import { getDb } from "../db/index.ts"
import { getBrowserScript } from "../lib/browser-script.ts"
import { getHealth } from "../lib/health.ts"
import { startScheduler } from "../lib/scheduler.ts"
import { alertsRoutes } from "./routes/alerts.ts"
import { issuesRoutes } from "./routes/issues.ts"
import { jobsRoutes } from "./routes/jobs.ts"
import { logsRoutes } from "./routes/logs.ts"
import { perfRoutes } from "./routes/perf.ts"
import { projectsRoutes } from "./routes/projects.ts"
import { streamRoutes } from "./routes/stream.ts"

const PORT = Number(process.env.LOGS_PORT ?? 3460)
const db = getDb()
const app = new Hono()

app.use("*", cors())

// Browser tracking script
app.get("/script.js", (c) => {
  const host = `${c.req.header("x-forwarded-proto") ?? "http"}://${c.req.header("host") ?? `localhost:${PORT}`}`
  c.header("Content-Type", "application/javascript")
  c.header("Cache-Control", "public, max-age=300")
  return c.text(getBrowserScript(host))
})

// API routes
app.route("/api/logs", logsRoutes(db))
app.route("/api/logs/stream", streamRoutes(db))
app.route("/api/projects", projectsRoutes(db))
app.route("/api/jobs", jobsRoutes(db))
app.route("/api/alerts", alertsRoutes(db))
app.route("/api/issues", issuesRoutes(db))
app.route("/api/perf", perfRoutes(db))

app.get("/health", (c) => c.json(getHealth(db)))
app.get("/dashboard", (c) => c.redirect("/dashboard/"))
app.use("/dashboard/*", serveStatic({ root: "./dashboard/dist", rewriteRequestPath: (p) => p.replace(/^\/dashboard/, "") }))
app.get("/", (c) => c.json({ service: "@hasna/logs", port: PORT, status: "ok", dashboard: `http://localhost:${PORT}/dashboard/` }))

// Start scheduler
startScheduler(db)

console.log(`@hasna/logs server running on http://localhost:${PORT}`)

export default {
  port: PORT,
  fetch: app.fetch,
}
