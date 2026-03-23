#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { getDb } from "../db/index.ts"
import { ingestBatch, ingestLog } from "../lib/ingest.ts"
import { getLogContext, getLogContextFromId, searchLogs, tailLogs } from "../lib/query.ts"
import { summarizeLogs } from "../lib/summarize.ts"
import { countLogs } from "../lib/count.ts"
import { createJob, listJobs } from "../lib/jobs.ts"
import { createPage, createProject, listPages, listProjects, resolveProjectId } from "../lib/projects.ts"
import { getLatestSnapshot, getPerfTrend, scoreLabel } from "../lib/perf.ts"
import { createAlertRule, deleteAlertRule, listAlertRules } from "../lib/alerts.ts"
import { listIssues, updateIssueStatus } from "../lib/issues.ts"
import { diagnose } from "../lib/diagnose.ts"
import { exportToJson, exportToCsv } from "../lib/export.ts"
import { compare } from "../lib/compare.ts"
import { getHealth } from "../lib/health.ts"
import { getSessionContext } from "../lib/session-context.ts"
import { parseTime } from "../lib/parse-time.ts"
import type { LogLevel, LogRow } from "../types/index.ts"

const db = getDb()
const server = new McpServer({ name: "logs", version: "0.3.0" })

const BRIEF_FIELDS: (keyof LogRow)[] = ["id", "timestamp", "level", "message", "service"]

function applyBrief(rows: LogRow[], brief = true): unknown[] {
  if (!brief) return rows
  return rows.map(r => ({
    id: r.id,
    timestamp: r.timestamp,
    level: r.level,
    message: r.message,
    service: r.service,
    age_seconds: Math.floor((Date.now() - new Date(r.timestamp).getTime()) / 1000),
  }))
}

function rp(idOrName?: string): string | undefined {
  if (!idOrName) return undefined
  return resolveProjectId(db, idOrName) ?? idOrName
}

// Tool registry with param signatures for discoverability
const TOOLS: Record<string, { desc: string; params: string }> = {
  register_project:        { desc: "Register a project", params: "(name, github_repo?, base_url?, description?)" },
  register_page:           { desc: "Register a page URL to a project", params: "(project_id, url, path?, name?)" },
  create_scan_job:         { desc: "Schedule headless page scans", params: "(project_id, schedule, page_id?)" },
  resolve_project:         { desc: "Resolve project name to ID", params: "(name)" },
  log_push:                { desc: "Push a single log entry", params: "(level, message, project_id?, service?, trace_id?, metadata?)" },
  log_push_batch:          { desc: "Push multiple log entries in one call", params: "(entries: Array<{level, message, project_id?, service?, trace_id?}>)" },
  log_search:              { desc: "Search logs", params: "(project_id?, level?, since?, until?, text?, service?, limit?=100, brief?=true)" },
  log_tail:                { desc: "Get N most recent logs", params: "(project_id?, n?=50, brief?=true)" },
  log_count:               { desc: "Count logs — zero token cost, pure signal", params: "(project_id?, service?, level?, since?, until?)" },
  log_recent_errors:       { desc: "Shortcut: recent errors + fatals", params: "(project_id?, since?='1h', limit?=20)" },
  log_summary:             { desc: "Error/warn counts by service", params: "(project_id?, since?)" },
  log_context:             { desc: "All logs for a trace_id", params: "(trace_id, brief?=true)" },
  log_context_from_id:     { desc: "Trace context from a log ID (no trace_id needed)", params: "(log_id, brief?=true)" },
  log_diagnose:            { desc: "Full diagnosis: score, top errors, failing pages, perf regressions", params: "(project_id, since?='24h', include?=['top_errors','error_rate','failing_pages','perf'])" },
  log_compare:             { desc: "Diff two time windows for new/resolved errors", params: "(project_id, a_since, a_until, b_since, b_until)" },
  log_session_context:     { desc: "Logs + session metadata for a session_id", params: "(session_id, brief?=true)" },
  perf_snapshot:           { desc: "Latest performance snapshot", params: "(project_id, page_id?)" },
  perf_trend:              { desc: "Performance over time", params: "(project_id, page_id?, since?, limit?=50)" },
  scan_status:             { desc: "Last scan jobs", params: "(project_id?)" },
  list_projects:           { desc: "List all projects", params: "()" },
  list_pages:              { desc: "List pages for a project", params: "(project_id)" },
  list_issues:             { desc: "List grouped error issues", params: "(project_id?, status?, limit?=50)" },
  resolve_issue:           { desc: "Update issue status", params: "(id, status: open|resolved|ignored)" },
  create_alert_rule:       { desc: "Create alert rule", params: "(project_id, name, level?, threshold_count?, window_seconds?, webhook_url?)" },
  list_alert_rules:        { desc: "List alert rules", params: "(project_id?)" },
  delete_alert_rule:       { desc: "Delete alert rule", params: "(id)" },
  get_health:              { desc: "Server health + DB stats", params: "()" },
  search_tools:            { desc: "Search tools by keyword — returns names, descriptions, param signatures", params: "(query)" },
  describe_tools:          { desc: "List all tools with descriptions and param signatures", params: "()" },
}

// Fellow agents: keep MCP registrations behind this helper so descriptions and schemas stay aligned with the current SDK.
function registerTool(
  name: keyof typeof TOOLS,
  schema: Record<string, z.ZodTypeAny>,
  handler: (...args: any[]) => any,
) {
  return server.tool(name, TOOLS[name].desc, schema, handler)
}

registerTool("search_tools", { query: z.string() }, ({ query }) => {
  const q = query.toLowerCase()
  const matches = Object.entries(TOOLS).filter(([k, v]) => k.includes(q) || v.desc.toLowerCase().includes(q))
  const text = matches.map(([k, v]) => `${k}${v.params} — ${v.desc}`).join("\n") || "No matches"
  return { content: [{ type: "text", text }] }
})

registerTool("describe_tools", {}, () => ({
  content: [{ type: "text", text: Object.entries(TOOLS).map(([k, v]) => `${k}${v.params} — ${v.desc}`).join("\n") }]
}))

registerTool("resolve_project", { name: z.string() }, ({ name }) => {
  const id = resolveProjectId(db, name)
  const project = id ? db.prepare("SELECT * FROM projects WHERE id = $id").get({ $id: id }) : null
  return { content: [{ type: "text", text: JSON.stringify(project ?? { error: `Project '${name}' not found` }) }] }
})

registerTool("register_project", {
  name: z.string(), github_repo: z.string().optional(), base_url: z.string().optional(), description: z.string().optional(),
}, (args) => ({ content: [{ type: "text", text: JSON.stringify(createProject(db, args)) }] }))

registerTool("register_page", {
  project_id: z.string(), url: z.string(), path: z.string().optional(), name: z.string().optional(),
}, (args) => ({ content: [{ type: "text", text: JSON.stringify(createPage(db, { ...args, project_id: rp(args.project_id) ?? args.project_id })) }] }))

registerTool("create_scan_job", {
  project_id: z.string(), schedule: z.string(), page_id: z.string().optional(),
}, (args) => ({ content: [{ type: "text", text: JSON.stringify(createJob(db, { ...args, project_id: rp(args.project_id) ?? args.project_id })) }] }))

registerTool("log_push", {
  level: z.enum(["debug", "info", "warn", "error", "fatal"]),
  message: z.string(),
  project_id: z.string().optional(), service: z.string().optional(),
  trace_id: z.string().optional(), session_id: z.string().optional(),
  agent: z.string().optional(), url: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}, (args) => {
  const row = ingestLog(db, { ...args, project_id: rp(args.project_id) })
  return { content: [{ type: "text", text: `Logged: ${row.id}` }] }
})

registerTool("log_push_batch", {
  entries: z.array(z.object({
    level: z.enum(["debug", "info", "warn", "error", "fatal"]),
    message: z.string(),
    project_id: z.string().optional(), service: z.string().optional(),
    trace_id: z.string().optional(), metadata: z.record(z.string(), z.unknown()).optional(),
  })),
  trace_id: z.string().optional().describe("Shared trace_id applied to all entries that don't have their own trace_id"),
  project_id: z.string().optional().describe("Shared project_id applied to all entries (individual entry project_id takes precedence)"),
}, ({ entries, trace_id, project_id }) => {
  const mapped = entries.map(e => ({
    ...e,
    project_id: rp(e.project_id ?? project_id),
  }))
  const rows = ingestBatch(db, mapped, trace_id)
  return { content: [{ type: "text", text: `Logged ${rows.length} entries${trace_id ? ` (trace: ${trace_id})` : ''}` }] }
})

registerTool("log_search", {
  project_id: z.string().optional(), page_id: z.string().optional(),
  level: z.string().optional(), service: z.string().optional(),
  since: z.string().optional(), until: z.string().optional(),
  text: z.string().optional(), trace_id: z.string().optional(),
  limit: z.number().optional(), brief: z.boolean().optional(),
}, (args) => {
  const rows = searchLogs(db, {
    ...args,
    project_id: rp(args.project_id),
    level: args.level ? (args.level.split(",") as LogLevel[]) : undefined,
    since: parseTime(args.since) ?? args.since,
    until: parseTime(args.until) ?? args.until,
  })
  return { content: [{ type: "text", text: JSON.stringify(applyBrief(rows, args.brief !== false)) }] }
})

registerTool("log_tail", {
  project_id: z.string().optional(), n: z.number().optional(), brief: z.boolean().optional(),
}, ({ project_id, n, brief }) => {
  const rows = tailLogs(db, rp(project_id), n ?? 50)
  return { content: [{ type: "text", text: JSON.stringify(applyBrief(rows, brief !== false)) }] }
})

registerTool("log_count", {
  project_id: z.string().optional(), service: z.string().optional(),
  level: z.string().optional(), since: z.string().optional(), until: z.string().optional(),
  group_by: z.enum(["level", "service"]).optional().describe("Return breakdown by 'level' or 'service' in addition to totals"),
}, (args) => ({
  content: [{ type: "text", text: JSON.stringify(countLogs(db, { ...args, project_id: rp(args.project_id) })) }]
}))

registerTool("log_recent_errors", {
  project_id: z.string().optional(), since: z.string().optional(), limit: z.number().optional(),
}, ({ project_id, since, limit }) => {
  const rows = searchLogs(db, {
    project_id: rp(project_id),
    level: ["error", "fatal"],
    since: parseTime(since ?? "1h"),
    limit: limit ?? 20,
  })
  return { content: [{ type: "text", text: JSON.stringify(applyBrief(rows, true)) }] }
})

registerTool("log_summary", {
  project_id: z.string().optional(), since: z.string().optional(),
}, ({ project_id, since }) => ({
  content: [{ type: "text", text: JSON.stringify(summarizeLogs(db, rp(project_id), parseTime(since) ?? since)) }]
}))

registerTool("log_context", {
  trace_id: z.string(), brief: z.boolean().optional(),
}, ({ trace_id, brief }) => ({
  content: [{ type: "text", text: JSON.stringify(applyBrief(getLogContext(db, trace_id), brief !== false)) }]
}))

registerTool("log_context_from_id", {
  log_id: z.string(),
  brief: z.boolean().optional(),
  window: z.number().int().min(0).optional().describe("Return N logs before and after the target log's timestamp (in addition to trace context)"),
}, ({ log_id, brief, window }) => ({
  content: [{ type: "text", text: JSON.stringify(applyBrief(getLogContextFromId(db, log_id, window ?? 0), brief !== false)) }]
}))

registerTool("log_export", {
  project_id: z.string().optional().describe("Project name or ID"),
  format: z.enum(["json", "csv"]).optional().default("json").describe("Output format"),
  since: z.string().optional().describe("Since time (1h, 24h, 7d, ISO)"),
  until: z.string().optional(),
  level: z.array(z.string()).optional().describe("Filter by levels"),
  service: z.string().optional(),
  limit: z.number().optional().default(100000),
}, (args) => {
  const chunks: string[] = []
  const write = (s: string) => { chunks.push(s); return true }
  const options = {
    project_id: rp(args.project_id),
    level: args.level as never,
    service: args.service,
    since: args.since,
    until: args.until,
    limit: args.limit ?? 100000,
  }
  if (args.format === "csv") exportToCsv(db, options, write)
  else exportToJson(db, options, write)
  return { content: [{ type: "text" as const, text: chunks.join("") }] }
})

registerTool("log_diagnose", {
  project_id: z.string(),
  since: z.string().optional(),
  include: z.array(z.enum(["top_errors", "error_rate", "failing_pages", "perf"])).optional(),
}, ({ project_id, since, include }) => ({
  content: [{ type: "text", text: JSON.stringify(diagnose(db, rp(project_id) ?? project_id, since, include)) }]
}))

registerTool("log_compare", {
  project_id: z.string(),
  a_since: z.string(), a_until: z.string(),
  b_since: z.string(), b_until: z.string(),
}, ({ project_id, a_since, a_until, b_since, b_until }) => ({
  content: [{ type: "text", text: JSON.stringify(compare(db, rp(project_id) ?? project_id,
    parseTime(a_since) ?? a_since, parseTime(a_until) ?? a_until,
    parseTime(b_since) ?? b_since, parseTime(b_until) ?? b_until)) }]
}))

registerTool("log_session_context", {
  session_id: z.string(), brief: z.boolean().optional(),
}, async ({ session_id, brief }) => {
  const ctx = await getSessionContext(db, session_id)
  return { content: [{ type: "text", text: JSON.stringify({ ...ctx, logs: applyBrief(ctx.logs, brief !== false) }) }] }
})

registerTool("perf_snapshot", {
  project_id: z.string(), page_id: z.string().optional(),
}, ({ project_id, page_id }) => {
  const snap = getLatestSnapshot(db, rp(project_id) ?? project_id, page_id)
  return { content: [{ type: "text", text: JSON.stringify(snap ? { ...snap, label: scoreLabel(snap.score) } : null) }] }
})

registerTool("perf_trend", {
  project_id: z.string(), page_id: z.string().optional(), since: z.string().optional(), limit: z.number().optional(),
}, ({ project_id, page_id, since, limit }) => ({
  content: [{ type: "text", text: JSON.stringify(getPerfTrend(db, rp(project_id) ?? project_id, page_id, parseTime(since) ?? since, limit ?? 50)) }]
}))

registerTool("scan_status", {
  project_id: z.string().optional(),
}, ({ project_id }) => ({
  content: [{ type: "text", text: JSON.stringify(listJobs(db, rp(project_id))) }]
}))

registerTool("list_projects", {}, () => ({
  content: [{ type: "text", text: JSON.stringify(listProjects(db)) }]
}))

registerTool("list_pages", { project_id: z.string() }, ({ project_id }) => ({
  content: [{ type: "text", text: JSON.stringify(listPages(db, rp(project_id) ?? project_id)) }]
}))

registerTool("list_issues", {
  project_id: z.string().optional(), status: z.string().optional(), limit: z.number().optional(),
}, ({ project_id, status, limit }) => ({
  content: [{ type: "text", text: JSON.stringify(listIssues(db, rp(project_id), status, limit ?? 50)) }]
}))

registerTool("resolve_issue", {
  id: z.string(), status: z.enum(["open", "resolved", "ignored"]),
}, ({ id, status }) => ({
  content: [{ type: "text", text: JSON.stringify(updateIssueStatus(db, id, status)) }]
}))

registerTool("create_alert_rule", {
  project_id: z.string(), name: z.string(),
  level: z.string().optional(), service: z.string().optional(),
  threshold_count: z.number().optional(), window_seconds: z.number().optional(),
  action: z.enum(["webhook", "log"]).optional(), webhook_url: z.string().optional(),
}, (args) => ({ content: [{ type: "text", text: JSON.stringify(createAlertRule(db, { ...args, project_id: rp(args.project_id) ?? args.project_id })) }] }))

registerTool("list_alert_rules", {
  project_id: z.string().optional(),
}, ({ project_id }) => ({
  content: [{ type: "text", text: JSON.stringify(listAlertRules(db, rp(project_id))) }]
}))

registerTool("delete_alert_rule", { id: z.string() }, ({ id }) => {
  deleteAlertRule(db, id)
  return { content: [{ type: "text", text: "deleted" }] }
})

registerTool("get_health", {}, () => ({
  content: [{ type: "text", text: JSON.stringify(getHealth(db)) }]
}))

server.tool("log_stats", {
  project_id: z.string().optional().describe("Project name or ID (scope stats to a project)"),
}, (args) => {
  const projectId = rp(args.project_id)
  const pFilter = projectId ? `WHERE project_id = ?` : ""
  const pAnd = projectId ? `AND project_id = ?` : ""
  const pParam = projectId ? [projectId] : []

  const total = (db.query(`SELECT COUNT(*) as c FROM logs ${pFilter}`).get(...pParam) as { c: number }).c
  const oldest = (db.query(`SELECT MIN(timestamp) as t FROM logs ${pFilter}`).get(...pParam) as { t: string | null }).t
  const newest = (db.query(`SELECT MAX(timestamp) as t FROM logs ${pFilter}`).get(...pParam) as { t: string | null }).t
  const byLevel = db.query(`SELECT level, COUNT(*) as c FROM logs ${pFilter} GROUP BY level ORDER BY c DESC`).all(...pParam) as { level: string; c: number }[]
  const topServices = db.query(`SELECT COALESCE(service, '-') as service, COUNT(*) as c FROM logs ${pFilter} GROUP BY service ORDER BY c DESC LIMIT 5`).all(...pParam) as { service: string; c: number }[]
  const days = db.query(`SELECT strftime('%Y-%m-%d', timestamp) as day, COUNT(*) as c FROM logs WHERE timestamp >= datetime('now', '-7 days') ${pAnd} GROUP BY day ORDER BY day`).all(...pParam) as { day: string; c: number }[]
  const errors = (byLevel.find(r => r.level === "error")?.c ?? 0) + (byLevel.find(r => r.level === "fatal")?.c ?? 0)
  const error_rate_pct = total > 0 ? parseFloat(((errors / total) * 100).toFixed(2)) : 0
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ total, oldest, newest, by_level: Object.fromEntries(byLevel.map(r => [r.level, r.c])), top_services: topServices, last_7_days: days, error_rate_pct }) }]
  }
})

server.tool(
  "send_feedback",
  "Send feedback about this service",
  {
    message: z.string(),
    email: z.string().optional(),
    category: z.enum(["bug", "feature", "general"]).optional(),
  },
  async (params) => {
    try {
      const pkg = require("../../package.json")
      db.run("INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)", [
        params.message, params.email || null, params.category || "general", pkg.version,
      ])
      return { content: [{ type: "text" as const, text: "Feedback saved. Thank you!" }] }
    } catch (e) {
      return { content: [{ type: "text" as const, text: String(e) }], isError: true }
    }
  },
)

const transport = new StdioServerTransport()
await server.connect(transport)
