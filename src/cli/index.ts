#!/usr/bin/env bun
import { Command } from "commander"
import { getDb } from "../db/index.ts"
import { ingestLog } from "../lib/ingest.ts"
import { searchLogs, tailLogs } from "../lib/query.ts"
import { summarizeLogs } from "../lib/summarize.ts"
import { createJob, listJobs } from "../lib/jobs.ts"
import { createPage, createProject, listPages, listProjects, resolveProjectId } from "../lib/projects.ts"
import { runJob } from "../lib/scheduler.ts"
import type { LogLevel } from "../types/index.ts"

// ── Color helpers ──────────────────────────────────────────
const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", gray: "\x1b[90m",
  bgRed: "\x1b[41m\x1b[97m", magenta: "\x1b[35m",
};
const LEVEL_COLOR: Record<string, string> = {
  fatal: C.bgRed, error: C.red, warn: C.yellow, info: "", debug: C.gray,
};
function colorRow(ts: string, level: string, svc: string, msg: string): string {
  const lc = LEVEL_COLOR[level.toLowerCase()] ?? "";
  const isTTY = process.stdout.isTTY;
  if (!isTTY) return `${ts}  ${pad(level.toUpperCase(), 5)}  ${pad(svc, 12)}  ${msg}`;
  return `${C.dim}${ts}${C.reset}  ${lc}${C.bold}${pad(level.toUpperCase(), 5)}${C.reset}  ${C.cyan}${pad(svc, 12)}${C.reset}  ${msg}`;
}
function colorLevel(level: string): string {
  if (!process.stdout.isTTY) return pad(level.toUpperCase(), 5);
  const lc = LEVEL_COLOR[level.toLowerCase()] ?? "";
  return `${lc}${C.bold}${pad(level.toUpperCase(), 5)}${C.reset}`;
}

/** Resolve a project name or ID from CLI --project flag */
function resolveProject(nameOrId: string | undefined): string | undefined {
  if (!nameOrId) return undefined;
  return resolveProjectId(getDb(), nameOrId) ?? nameOrId;
}

const program = new Command()
  .name("logs")
  .description("@hasna/logs — log aggregation and monitoring")
  .version("0.0.1")

// ── logs list ──────────────────────────────────────────────
program.command("list")
  .description("Search and list logs")
  .option("--project <name|id>", "Filter by project name or ID")
  .option("--page <id>", "Filter by page ID")
  .option("--level <levels>", "Comma-separated levels (error,warn,info,debug,fatal)")
  .option("--service <name>", "Filter by service")
  .option("--since <iso>", "Since timestamp or relative (1h, 24h, 7d)")
  .option("--until <iso>", "Until timestamp or relative (e.g. logs list --since 2h --until 1h)")
  .option("--text <query>", "Full-text search")
  .option("--limit <n>", "Max results", "100")
  .option("--format <fmt>", "Output format: table|json|compact", "table")
  .action((opts) => {
    const db = getDb()
    const since = parseRelativeTime(opts.since)
    const until = parseRelativeTime(opts.until)
    const rows = searchLogs(db, {
      project_id: resolveProject(opts.project),
      page_id: opts.page,
      level: opts.level ? (opts.level.split(",") as LogLevel[]) : undefined,
      service: opts.service,
      since,
      until,
      text: opts.text,
      limit: Number(opts.limit),
    })
    if (opts.format === "json") { console.log(JSON.stringify(rows, null, 2)); return }
    if (opts.format === "compact") {
      for (const r of rows) console.log(`${r.timestamp} [${r.level.toUpperCase()}] ${r.service ?? "-"} ${r.message}`)
      return
    }
    for (const r of rows) {
      const meta = r.metadata ? ` ${r.metadata}` : ""
      console.log(`${colorRow(r.timestamp, r.level, r.service ?? "-", r.message)}${meta}`)
    }
    console.log(`\n${rows.length} log(s)`)
  })

// ── logs tail ──────────────────────────────────────────────
program.command("tail")
  .description("Show most recent logs")
  .option("--project <name|id>", "Project name or ID")
  .option("--n <count>", "Number of logs", "50")
  .action((opts) => {
    const rows = tailLogs(getDb(), resolveProject(opts.project), Number(opts.n))
    for (const r of rows) console.log(colorRow(r.timestamp, r.level, r.service ?? "-", r.message))
  })

// ── logs summary ──────────────────────────────────────────
program.command("summary")
  .description("Error/warn summary by service")
  .option("--project <name|id>", "Project name or ID")
  .option("--since <time>", "Relative time (1h, 24h, 7d)", "24h")
  .option("--until <time>", "Upper bound time")
  .action((opts) => {
    const summary = summarizeLogs(getDb(), resolveProject(opts.project), parseRelativeTime(opts.since), parseRelativeTime(opts.until))
    if (!summary.length) { console.log("No errors/warnings in this window."); return }
    for (const s of summary) console.log(`${colorLevel(s.level)} ${C.cyan}${pad(s.service ?? "-", 15)}${C.reset} count=${s.count} latest=${s.latest}`)
  })

// ── logs push ─────────────────────────────────────────────
program.command("push <message>")
  .description("Push a log entry")
  .option("--level <level>", "Log level", "info")
  .option("--service <name>")
  .option("--project <name|id>", "Project name or ID")
  .option("--trace <id>", "Trace ID")
  .action((message, opts) => {
    const row = ingestLog(getDb(), { level: opts.level as LogLevel, message, service: opts.service, project_id: resolveProject(opts.project), trace_id: opts.trace })
    console.log(`Logged: ${row.id}`)
  })

// ── logs project ──────────────────────────────────────────
const projectCmd = program.command("project").description("Manage projects")

projectCmd.command("create")
  .option("--name <name>", "Project name")
  .option("--repo <url>", "GitHub repo")
  .option("--url <url>", "Base URL")
  .action((opts) => {
    if (!opts.name) { console.error("--name is required"); process.exit(1) }
    const p = createProject(getDb(), { name: opts.name, github_repo: opts.repo, base_url: opts.url })
    console.log(`Created project: ${p.id} — ${p.name}`)
  })

projectCmd.command("list").action(() => {
  const projects = listProjects(getDb())
  for (const p of projects) console.log(`${p.id}  ${p.name}  ${p.base_url ?? ""}  ${p.github_repo ?? ""}`)
})

// ── logs page ─────────────────────────────────────────────
const pageCmd = program.command("page").description("Manage pages")

pageCmd.command("add")
  .option("--project <name|id>", "Project name or ID")
  .option("--url <url>")
  .option("--name <name>")
  .action((opts) => {
    if (!opts.project || !opts.url) { console.error("--project and --url required"); process.exit(1) }
    const p = createPage(getDb(), { project_id: resolveProject(opts.project), url: opts.url, name: opts.name })
    console.log(`Page registered: ${p.id} — ${p.url}`)
  })

pageCmd.command("list").option("--project <name|id>", "Project name or ID").action((opts) => {
  if (!opts.project) { console.error("--project required"); process.exit(1) }
  const pages = listPages(getDb(), resolveProject(opts.project))
  for (const p of pages) console.log(`${p.id}  ${p.url}  last=${p.last_scanned_at ?? "never"}`)
})

// ── logs job ──────────────────────────────────────────────
const jobCmd = program.command("job").description("Manage scan jobs")

jobCmd.command("create")
  .option("--project <name|id>", "Project name or ID")
  .option("--schedule <cron>", "Cron expression", "*/30 * * * *")
  .action((opts) => {
    if (!opts.project) { console.error("--project required"); process.exit(1) }
    const j = createJob(getDb(), { project_id: resolveProject(opts.project), schedule: opts.schedule })
    console.log(`Job created: ${j.id} — ${j.schedule}`)
  })

jobCmd.command("list").option("--project <name|id>", "Project name or ID").action((opts) => {
  const jobs = listJobs(getDb(), resolveProject(opts.project))
  for (const j of jobs) console.log(`${j.id}  ${j.schedule}  enabled=${j.enabled}  last=${j.last_run_at ?? "never"}`)
})

// ── logs scan ─────────────────────────────────────────────
program.command("scan")
  .description("Run an immediate scan for a job")
  .option("--job <id>")
  .option("--project <name|id>", "Project name or ID")
  .action(async (opts) => {
    if (!opts.job) { console.error("--job required"); process.exit(1) }
    const db = getDb()
    const job = (await import("../lib/jobs.ts")).getJob(db, opts.job)
    if (!job) { console.error("Job not found"); process.exit(1) }
    console.log("Running scan...")
    await runJob(db, job.id, job.project_id, job.page_id ?? undefined)
    console.log("Scan complete.")
  })

// ── logs watch ────────────────────────────────────────────
program.command("watch")
  .description("Stream new logs in real time with color coding")
  .option("--project <name|id>", "Filter by project name or ID")
  .option("--level <levels>", "Comma-separated levels (debug,info,warn,error,fatal)")
  .option("--service <name>", "Filter by service name")
  .option("--interval <ms>", "Poll interval in milliseconds (default: 500)", "500")
  .option("--since <time>", "Start from this time (default: now)")
  .action(async (opts) => {
    const db = getDb()
    const { searchLogs } = await import("../lib/query.ts")

    // Resolve project name → ID if needed
    let projectId = opts.project
    if (projectId) {
      const proj = db.query("SELECT id FROM projects WHERE id = ? OR name = ?").get(projectId, projectId) as { id: string } | null
      if (proj) projectId = proj.id
    }

    const COLORS: Record<string, string> = {
      debug: "\x1b[90m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m", fatal: "\x1b[35m",
    }
    const RESET = "\x1b[0m"
    const BOLD = "\x1b[1m"

    let lastTimestamp = opts.since ? new Date(opts.since).toISOString() : new Date().toISOString()
    let errorCount = 0
    let warnCount = 0
    const pollIntervalMs = Math.max(100, Number(opts.interval) || 500)

    process.stdout.write(`\x1b[2J\x1b[H`) // clear screen
    console.log(`${BOLD}@hasna/logs watch${RESET} — Ctrl+C to exit${projectId ? `  [project: ${opts.project}]` : ''}\n`)

    const poll = () => {
      const rows = searchLogs(db, {
        project_id: projectId,
        level: opts.level ? (opts.level.split(",") as LogLevel[]) : undefined,
        service: opts.service,
        since: lastTimestamp,
        limit: 100,
      }).reverse()

      for (const row of rows) {
        if (row.timestamp <= lastTimestamp) continue
        lastTimestamp = row.timestamp
        if (row.level === "error" || row.level === "fatal") errorCount++
        if (row.level === "warn") warnCount++
        const color = COLORS[row.level] ?? ""
        const ts = row.timestamp.slice(11, 19)
        const svc = (row.service ?? "-").padEnd(12)
        const lvl = row.level.toUpperCase().padEnd(5)
        console.log(`${color}${ts}  ${BOLD}${lvl}${RESET}${color}  ${svc}  ${row.message}${RESET}`)
      }

      // Update terminal title with counts
      process.stdout.write(`\x1b]2;logs: ${errorCount}E ${warnCount}W\x07`)
    }

    const interval = setInterval(poll, pollIntervalMs)
    process.on("SIGINT", () => { clearInterval(interval); console.log(`\n\nErrors: ${errorCount}  Warnings: ${warnCount}`); process.exit(0) })
  })

// ── logs export ───────────────────────────────────────────
program.command("export")
  .description("Export logs to JSON or CSV")
  .option("--project <name|id>", "Project name or ID")
  .option("--since <time>", "Relative time or ISO")
  .option("--level <level>")
  .option("--service <name>")
  .option("--format <fmt>", "json or csv", "json")
  .option("--output <file>", "Output file (default: stdout)")
  .option("--limit <n>", "Max rows", "100000")
  .action(async (opts) => {
    const { exportToCsv, exportToJson } = await import("../lib/export.ts")
    const { createWriteStream } = await import("node:fs")
    const db = getDb()
    const options = {
      project_id: resolveProject(opts.project),
      since: parseRelativeTime(opts.since),
      level: opts.level,
      service: opts.service,
      limit: Number(opts.limit),
    }
    let count = 0
    if (opts.output) {
      const stream = createWriteStream(opts.output)
      const write = (s: string) => stream.write(s)
      count = opts.format === "csv" ? exportToCsv(db, options, write) : exportToJson(db, options, write)
      stream.end()
      console.error(`Exported ${count} log(s) to ${opts.output}`)
    } else {
      const write = (s: string) => process.stdout.write(s)
      count = opts.format === "csv" ? exportToCsv(db, options, write) : exportToJson(db, options, write)
      process.stderr.write(`\nExported ${count} log(s)\n`)
    }
  })

// ── logs health ───────────────────────────────────────────
program.command("health")
  .description("Show server health and DB stats")
  .action(async () => {
    const { getHealth } = await import("../lib/health.ts")
    const h = getHealth(getDb())
    console.log(JSON.stringify(h, null, 2))
  })

// ── logs mcp / logs serve ─────────────────────────────────
program.command("mcp")
  .description("Start the MCP server")
  .option("--claude", "Install into Claude Code")
  .option("--codex", "Install into Codex")
  .option("--gemini", "Install into Gemini")
  .action(async (opts) => {
    if (opts.claude || opts.codex || opts.gemini) {
      const { execSync } = await import("node:child_process")
      // Resolve the MCP binary path — works from both source and dist
      const selfPath = process.argv[1] ?? new URL(import.meta.url).pathname
      const mcpBin = selfPath.replace(/cli\/index\.(ts|js)$/, "mcp/index.$1")
      const runtime = process.execPath  // bun or node

      if (opts.claude) {
        const cmd = `claude mcp add --transport stdio --scope user logs -- ${runtime} ${mcpBin}`
        console.log(`Running: ${cmd}`)
        execSync(cmd, { stdio: "inherit" })
        console.log("✓ Installed logs-mcp into Claude Code")
      }
      if (opts.codex) {
        const config = `[mcp_servers.logs]\ncommand = "${runtime}"\nargs = ["${mcpBin}"]`
        console.log("Add to ~/.codex/config.toml:\n\n" + config)
      }
      if (opts.gemini) {
        const config = JSON.stringify({ mcpServers: { logs: { command: runtime, args: [mcpBin] } } }, null, 2)
        console.log("Add to ~/.gemini/settings.json mcpServers:\n\n" + config)
      }
      return
    }
    await import("../mcp/index.ts")
  })

program.command("serve")
  .description("Start the REST API server")
  .option("--port <n>", "Port", "3460")
  .action(async (opts) => {
    process.env.LOGS_PORT = opts.port
    await import("../server/index.ts")
  })

// ── helpers ───────────────────────────────────────────────
function pad(s: string, n: number) { return s.padEnd(n) }

function parseRelativeTime(val?: string): string | undefined {
  if (!val) return undefined
  const m = val.match(/^(\d+)(h|d|m)$/)
  if (!m) return val
  const [, n, unit] = m
  const ms = Number(n) * (unit === "h" ? 3600 : unit === "d" ? 86400 : 60) * 1000
  return new Date(Date.now() - ms).toISOString()
}

program.parse()
