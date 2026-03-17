#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { getDb } from "../db/index.ts"
import { ingestLog } from "../lib/ingest.ts"
import { getLogContext, searchLogs, tailLogs } from "../lib/query.ts"
import { summarizeLogs } from "../lib/summarize.ts"
import { createJob, listJobs } from "../lib/jobs.ts"
import { createPage, createProject, listPages, listProjects } from "../lib/projects.ts"
import { getLatestSnapshot, getPerfTrend, scoreLabel } from "../lib/perf.ts"
import type { LogLevel } from "../types/index.ts"

const db = getDb()
const server = new McpServer({ name: "logs", version: "0.0.1" })

// Tool registry for search_tools / describe_tools pattern
const TOOLS: Record<string, string> = {
  register_project: "Register a project (name, github_repo?, base_url?, description?)",
  register_page: "Register a page URL to a project (project_id, url, path?, name?)",
  create_scan_job: "Schedule headless page scans (project_id, schedule, page_id?)",
  log_push: "Push a log entry (level, message, project_id?, service?, trace_id?, metadata?)",
  log_search: "Search logs (project_id?, page_id?, level?, since?, until?, text?, limit?)",
  log_tail: "Get N most recent logs (project_id?, n?)",
  log_summary: "Error/warn counts by service/page (project_id?, since?)",
  log_context: "All logs for a trace_id",
  perf_snapshot: "Latest performance snapshot for a project/page (project_id, page_id?)",
  perf_trend: "Performance over time (project_id, page_id?, since?, limit?)",
  scan_status: "Last scan runs per project (project_id?)",
  list_projects: "List all registered projects",
  list_pages: "List pages for a project (project_id)",
  search_tools: "Search available tools by keyword (query)",
  describe_tools: "List all tools with descriptions",
}

server.tool("search_tools", { query: z.string() }, ({ query }) => {
  const q = query.toLowerCase()
  const matches = Object.entries(TOOLS).filter(([k, v]) => k.includes(q) || v.toLowerCase().includes(q))
  return { content: [{ type: "text", text: matches.map(([k, v]) => `${k}: ${v}`).join("\n") || "No matches" }] }
})

server.tool("describe_tools", {}, () => {
  const text = Object.entries(TOOLS).map(([k, v]) => `${k}: ${v}`).join("\n")
  return { content: [{ type: "text", text }] }
})

server.tool("register_project", {
  name: z.string(),
  github_repo: z.string().optional(),
  base_url: z.string().optional(),
  description: z.string().optional(),
}, (args) => {
  const project = createProject(db, args)
  return { content: [{ type: "text", text: JSON.stringify(project) }] }
})

server.tool("register_page", {
  project_id: z.string(),
  url: z.string(),
  path: z.string().optional(),
  name: z.string().optional(),
}, (args) => {
  const page = createPage(db, args)
  return { content: [{ type: "text", text: JSON.stringify(page) }] }
})

server.tool("create_scan_job", {
  project_id: z.string(),
  schedule: z.string(),
  page_id: z.string().optional(),
}, (args) => {
  const job = createJob(db, args)
  return { content: [{ type: "text", text: JSON.stringify(job) }] }
})

server.tool("log_push", {
  level: z.enum(["debug", "info", "warn", "error", "fatal"]),
  message: z.string(),
  project_id: z.string().optional(),
  service: z.string().optional(),
  trace_id: z.string().optional(),
  session_id: z.string().optional(),
  agent: z.string().optional(),
  url: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
}, (args) => {
  const row = ingestLog(db, args)
  return { content: [{ type: "text", text: `Logged: ${row.id}` }] }
})

server.tool("log_search", {
  project_id: z.string().optional(),
  page_id: z.string().optional(),
  level: z.string().optional(),
  service: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  text: z.string().optional(),
  trace_id: z.string().optional(),
  limit: z.number().optional(),
}, (args) => {
  const rows = searchLogs(db, {
    ...args,
    level: args.level ? (args.level.split(",") as LogLevel[]) : undefined,
  })
  return { content: [{ type: "text", text: JSON.stringify(rows) }] }
})

server.tool("log_tail", {
  project_id: z.string().optional(),
  n: z.number().optional(),
}, ({ project_id, n }) => {
  const rows = tailLogs(db, project_id, n ?? 50)
  return { content: [{ type: "text", text: JSON.stringify(rows) }] }
})

server.tool("log_summary", {
  project_id: z.string().optional(),
  since: z.string().optional(),
}, ({ project_id, since }) => {
  const summary = summarizeLogs(db, project_id, since)
  return { content: [{ type: "text", text: JSON.stringify(summary) }] }
})

server.tool("log_context", { trace_id: z.string() }, ({ trace_id }) => {
  const rows = getLogContext(db, trace_id)
  return { content: [{ type: "text", text: JSON.stringify(rows) }] }
})

server.tool("perf_snapshot", {
  project_id: z.string(),
  page_id: z.string().optional(),
}, ({ project_id, page_id }) => {
  const snap = getLatestSnapshot(db, project_id, page_id)
  const label = snap ? scoreLabel(snap.score) : "unknown"
  return { content: [{ type: "text", text: JSON.stringify({ ...snap, label }) }] }
})

server.tool("perf_trend", {
  project_id: z.string(),
  page_id: z.string().optional(),
  since: z.string().optional(),
  limit: z.number().optional(),
}, ({ project_id, page_id, since, limit }) => {
  const trend = getPerfTrend(db, project_id, page_id, since, limit ?? 50)
  return { content: [{ type: "text", text: JSON.stringify(trend) }] }
})

server.tool("scan_status", {
  project_id: z.string().optional(),
}, ({ project_id }) => {
  const jobs = listJobs(db, project_id)
  return { content: [{ type: "text", text: JSON.stringify(jobs) }] }
})

server.tool("list_projects", {}, () => {
  return { content: [{ type: "text", text: JSON.stringify(listProjects(db)) }] }
})

server.tool("list_pages", { project_id: z.string() }, ({ project_id }) => {
  return { content: [{ type: "text", text: JSON.stringify(listPages(db, project_id)) }] }
})

const transport = new StdioServerTransport()
await server.connect(transport)
