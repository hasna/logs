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
import { createAlertRule, deleteAlertRule, listAlertRules } from "../lib/alerts.ts"
import { listIssues, updateIssueStatus } from "../lib/issues.ts"
import { diagnose } from "../lib/diagnose.ts"
import { compare } from "../lib/compare.ts"
import { getHealth } from "../lib/health.ts"
import { getSessionContext } from "../lib/session-context.ts"
import type { LogLevel, LogRow } from "../types/index.ts"

const db = getDb()
const server = new McpServer({ name: "logs", version: "0.1.0" })

const BRIEF_FIELDS: (keyof LogRow)[] = ["id", "timestamp", "level", "message", "service"]

function applyBrief(rows: LogRow[], brief = true): unknown[] {
  if (!brief) return rows
  return rows.map(r => ({ id: r.id, timestamp: r.timestamp, level: r.level, message: r.message, service: r.service }))
}

const TOOLS: Record<string, string> = {
  register_project: "Register a project (name, github_repo?, base_url?, description?)",
  register_page: "Register a page URL (project_id, url, path?, name?)",
  create_scan_job: "Schedule page scans (project_id, schedule, page_id?)",
  log_push: "Push a log entry (level, message, project_id?, service?, trace_id?, metadata?)",
  log_search: "Search logs (project_id?, level?, since?, text?, brief?=true, limit?)",
  log_tail: "Recent logs (project_id?, n?, brief?=true)",
  log_summary: "Error/warn counts by service (project_id?, since?)",
  log_context: "All logs for a trace_id (trace_id, brief?=true)",
  log_diagnose: "Full diagnosis: top errors, failing pages, perf regressions (project_id, since?)",
  log_compare: "Compare two time windows for new/resolved errors and perf delta",
  perf_snapshot: "Latest perf snapshot (project_id, page_id?)",
  perf_trend: "Perf over time (project_id, page_id?, since?, limit?)",
  scan_status: "Last scan jobs (project_id?)",
  list_projects: "List all projects",
  list_pages: "List pages for a project (project_id)",
  list_issues: "List grouped error issues (project_id?, status?, limit?)",
  resolve_issue: "Update issue status (id, status: open|resolved|ignored)",
  create_alert_rule: "Create alert rule (project_id, name, level, threshold_count, window_seconds, webhook_url?)",
  list_alert_rules: "List alert rules (project_id?)",
  delete_alert_rule: "Delete alert rule (id)",
  log_session_context: "Logs + session metadata for a session_id (requires SESSIONS_URL env)",
  get_health: "Server health + DB stats",
  search_tools: "Search tools by keyword (query)",
  describe_tools: "List all tools",
}

server.tool("search_tools", { query: z.string() }, ({ query }) => {
  const q = query.toLowerCase()
  const matches = Object.entries(TOOLS).filter(([k, v]) => k.includes(q) || v.toLowerCase().includes(q))
  return { content: [{ type: "text", text: matches.map(([k, v]) => `${k}: ${v}`).join("\n") || "No matches" }] }
})

server.tool("describe_tools", {}, () => ({
  content: [{ type: "text", text: Object.entries(TOOLS).map(([k, v]) => `${k}: ${v}`).join("\n") }]
}))

server.tool("register_project", {
  name: z.string(), github_repo: z.string().optional(), base_url: z.string().optional(), description: z.string().optional(),
}, (args) => ({ content: [{ type: "text", text: JSON.stringify(createProject(db, args)) }] }))

server.tool("register_page", {
  project_id: z.string(), url: z.string(), path: z.string().optional(), name: z.string().optional(),
}, (args) => ({ content: [{ type: "text", text: JSON.stringify(createPage(db, args)) }] }))

server.tool("create_scan_job", {
  project_id: z.string(), schedule: z.string(), page_id: z.string().optional(),
}, (args) => ({ content: [{ type: "text", text: JSON.stringify(createJob(db, args)) }] }))

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
  project_id: z.string().optional(), page_id: z.string().optional(),
  level: z.string().optional(), service: z.string().optional(),
  since: z.string().optional(), until: z.string().optional(),
  text: z.string().optional(), trace_id: z.string().optional(),
  limit: z.number().optional(), brief: z.boolean().optional(),
}, (args) => {
  const rows = searchLogs(db, { ...args, level: args.level ? (args.level.split(",") as LogLevel[]) : undefined })
  return { content: [{ type: "text", text: JSON.stringify(applyBrief(rows, args.brief !== false)) }] }
})

server.tool("log_tail", {
  project_id: z.string().optional(), n: z.number().optional(), brief: z.boolean().optional(),
}, ({ project_id, n, brief }) => {
  const rows = tailLogs(db, project_id, n ?? 50)
  return { content: [{ type: "text", text: JSON.stringify(applyBrief(rows, brief !== false)) }] }
})

server.tool("log_summary", {
  project_id: z.string().optional(), since: z.string().optional(),
}, ({ project_id, since }) => ({
  content: [{ type: "text", text: JSON.stringify(summarizeLogs(db, project_id, since)) }]
}))

server.tool("log_context", {
  trace_id: z.string(), brief: z.boolean().optional(),
}, ({ trace_id, brief }) => {
  const rows = getLogContext(db, trace_id)
  return { content: [{ type: "text", text: JSON.stringify(applyBrief(rows, brief !== false)) }] }
})

server.tool("log_diagnose", {
  project_id: z.string(), since: z.string().optional(),
}, ({ project_id, since }) => ({
  content: [{ type: "text", text: JSON.stringify(diagnose(db, project_id, since)) }]
}))

server.tool("log_compare", {
  project_id: z.string(),
  a_since: z.string(), a_until: z.string(),
  b_since: z.string(), b_until: z.string(),
}, ({ project_id, a_since, a_until, b_since, b_until }) => ({
  content: [{ type: "text", text: JSON.stringify(compare(db, project_id, a_since, a_until, b_since, b_until)) }]
}))

server.tool("perf_snapshot", {
  project_id: z.string(), page_id: z.string().optional(),
}, ({ project_id, page_id }) => {
  const snap = getLatestSnapshot(db, project_id, page_id)
  return { content: [{ type: "text", text: JSON.stringify(snap ? { ...snap, label: scoreLabel(snap.score) } : null) }] }
})

server.tool("perf_trend", {
  project_id: z.string(), page_id: z.string().optional(), since: z.string().optional(), limit: z.number().optional(),
}, ({ project_id, page_id, since, limit }) => ({
  content: [{ type: "text", text: JSON.stringify(getPerfTrend(db, project_id, page_id, since, limit ?? 50)) }]
}))

server.tool("scan_status", {
  project_id: z.string().optional(),
}, ({ project_id }) => ({
  content: [{ type: "text", text: JSON.stringify(listJobs(db, project_id)) }]
}))

server.tool("list_projects", {}, () => ({
  content: [{ type: "text", text: JSON.stringify(listProjects(db)) }]
}))

server.tool("list_pages", { project_id: z.string() }, ({ project_id }) => ({
  content: [{ type: "text", text: JSON.stringify(listPages(db, project_id)) }]
}))

server.tool("list_issues", {
  project_id: z.string().optional(), status: z.string().optional(), limit: z.number().optional(),
}, ({ project_id, status, limit }) => ({
  content: [{ type: "text", text: JSON.stringify(listIssues(db, project_id, status, limit ?? 50)) }]
}))

server.tool("resolve_issue", {
  id: z.string(), status: z.enum(["open", "resolved", "ignored"]),
}, ({ id, status }) => ({
  content: [{ type: "text", text: JSON.stringify(updateIssueStatus(db, id, status)) }]
}))

server.tool("create_alert_rule", {
  project_id: z.string(), name: z.string(),
  level: z.string().optional(), service: z.string().optional(),
  threshold_count: z.number().optional(), window_seconds: z.number().optional(),
  action: z.enum(["webhook", "log"]).optional(), webhook_url: z.string().optional(),
}, (args) => ({ content: [{ type: "text", text: JSON.stringify(createAlertRule(db, args)) }] }))

server.tool("list_alert_rules", {
  project_id: z.string().optional(),
}, ({ project_id }) => ({
  content: [{ type: "text", text: JSON.stringify(listAlertRules(db, project_id)) }]
}))

server.tool("delete_alert_rule", { id: z.string() }, ({ id }) => {
  deleteAlertRule(db, id)
  return { content: [{ type: "text", text: "deleted" }] }
})

server.tool("log_session_context", {
  session_id: z.string(),
  brief: z.boolean().optional(),
}, async ({ session_id, brief }) => {
  const ctx = await getSessionContext(db, session_id)
  return { content: [{ type: "text", text: JSON.stringify({ ...ctx, logs: applyBrief(ctx.logs, brief !== false) }) }] }
})

server.tool("get_health", {}, () => ({
  content: [{ type: "text", text: JSON.stringify(getHealth(db)) }]
}))

const transport = new StdioServerTransport()
await server.connect(transport)
