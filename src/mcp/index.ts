#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getDb } from "../db/index.ts";
import {
  createAlertRule,
  deleteAlertRule,
  listAlertRules,
} from "../lib/alerts.ts";
import { compare } from "../lib/compare.ts";
import { countLogs } from "../lib/count.ts";
import { diagnose } from "../lib/diagnose.ts";
import { exportEventsToJson, getEvent, searchEvents } from "../lib/events.ts";
import { exportToCsv, exportToJson } from "../lib/export.ts";
import { getHealth } from "../lib/health.ts";
import { detectRuntimeIdentity } from "../lib/identity.ts";
import { ingestBatch, ingestLog } from "../lib/ingest.ts";
import { listIssues, updateIssueStatus } from "../lib/issues.ts";
import { createJob, listJobs } from "../lib/jobs.ts";
import { PACKAGE_VERSION, exitIfMetadataRequest } from "../lib/package-meta.ts";
import { parseTime } from "../lib/parse-time.ts";
import { getLatestSnapshot, getPerfTrend, scoreLabel } from "../lib/perf.ts";
import {
  createPage,
  createProject,
  listPages,
  listProjects,
  resolveProjectId,
} from "../lib/projects.ts";
import {
  getLogContext,
  getLogContextFromId,
  searchLogs,
  tailLogs,
} from "../lib/query.ts";
import { getSessionContext } from "../lib/session-context.ts";
import {
  getStoragePg,
  getStorageStatus,
  storagePull,
  storagePush,
  storageSync,
} from "../lib/storage-sync.ts";
import { summarizeLogs } from "../lib/summarize.ts";
import { getTestReport, searchTestReports } from "../lib/test-reports.ts";
import {
  UNIVERSAL_EVENT_TYPES,
  type UniversalEventInput,
  type UniversalEventType,
  ingestUniversalEvent,
  validateUniversalEventInput,
} from "../lib/universal-ingest.ts";
import type { LogLevel, LogRow } from "../types/index.ts";

exitIfMetadataRequest({
  name: "logs-mcp",
  description: "Start the @hasna/logs MCP server (stdio by default).",
  options: [
    "  --http           Serve MCP over Streamable HTTP (127.0.0.1)",
    "  --port <number>  HTTP port (default: 8864, env: MCP_HTTP_PORT)",
  ],
});

const db = getDb();

// --- in-memory agent registry (module-level for shared HTTP process) ---
interface _LogsAgent {
  id: string;
  name: string;
  session_id?: string;
  last_seen_at: string;
  project_id?: string;
}
const _logsAgents = new Map<string, _LogsAgent>();

export function buildServer(): McpServer {
  const server = new McpServer({ name: "logs", version: PACKAGE_VERSION });

  const BRIEF_FIELDS: (keyof LogRow)[] = [
    "id",
    "timestamp",
    "level",
    "message",
    "service",
  ];
  const MCP_DEFAULT_LIMIT = 25;
  const MCP_MAX_LIMIT = 1_000;
  const MCP_TEXT_LIMIT = 160;

  // biome-ignore lint/suspicious/noExplicitAny: MCP SDK tool handlers are dynamically typed from their Zod schemas.
  type McpToolHandler = (...args: any[]) => any;

  interface LogPushBatchEntry {
    level: LogLevel;
    message: string;
    project_id?: string;
    service?: string;
    trace_id?: string;
    metadata?: Record<string, unknown>;
  }

  function applyBrief(rows: LogRow[], brief = true): unknown[] {
    if (!brief) return rows;
    return rows.map((r) => ({
      id: r.id,
      timestamp: r.timestamp,
      level: r.level,
      message: compactMcpText(r.message, MCP_TEXT_LIMIT),
      service: compactMcpText(r.service, 48),
      age_seconds: Math.floor(
        (Date.now() - new Date(r.timestamp).getTime()) / 1000,
      ),
    }));
  }

  function compactMcpText(
    value: string | null | undefined,
    max = MCP_TEXT_LIMIT,
  ): string | null {
    if (value === null || value === undefined) return null;
    const singleLine = value.replace(/\s+/g, " ").trim();
    if (singleLine.length <= max) return singleLine;
    return `${singleLine.slice(0, Math.max(0, max - 3))}...`;
  }

  function clampMcpListLimit(
    value: number | undefined,
    fallback = MCP_DEFAULT_LIMIT,
  ): number {
    if (!Number.isFinite(value) || value === undefined) return fallback;
    return Math.min(Math.max(1, Math.floor(value)), MCP_MAX_LIMIT);
  }

  function resolveMcpContextLimit(
    value: number | undefined,
    brief: boolean | undefined,
    total: number,
  ): number {
    if (value !== undefined) return clampMcpListLimit(value);
    return brief === false ? total : MCP_DEFAULT_LIMIT;
  }

  function sliceMcpContextRows(
    rows: LogRow[],
    limit: number,
    targetLogId?: string,
  ): LogRow[] {
    if (limit <= 0 || rows.length <= limit) return rows;
    if (!targetLogId) return rows.slice(0, limit);
    const targetIndex = rows.findIndex((row) => row.id === targetLogId);
    if (targetIndex < 0 || targetIndex < limit) return rows.slice(0, limit);
    const halfWindow = Math.floor(limit / 2);
    const start = Math.min(
      Math.max(0, targetIndex - halfWindow),
      Math.max(0, rows.length - limit),
    );
    return rows.slice(start, start + limit);
  }

  function compactMcpEvent(row: EventCatalogEntry): Record<string, unknown> {
    return {
      event_id: row.event_id,
      event_time: row.event_time,
      event_type: row.event_type,
      source: row.source,
      severity: row.severity,
      project_id: row.project_id,
      trace_id: row.trace_id,
      run_id: row.run_id,
      message: compactMcpText(row.message),
      has_metadata: Boolean(row.metadata && Object.keys(row.metadata).length),
      has_raw: Boolean(row.raw),
    };
  }

  function compactMcpTestReport(report: {
    id: string;
    event_id: string | null;
    event_time: string | null;
    parser: string | null;
    parse_status: string | null;
    path: string | null;
    tests: number | null;
    failures: number | null;
    errors: number | null;
    skipped: number | null;
    case_stored_count: number;
    truncated: boolean;
  }): Record<string, unknown> {
    return {
      id: report.id,
      event_id: report.event_id,
      event_time: report.event_time,
      parser: report.parser,
      parse_status: report.parse_status,
      path: compactMcpText(report.path, 120),
      tests: report.tests,
      failures: report.failures,
      errors: report.errors,
      skipped: report.skipped,
      case_stored_count: report.case_stored_count,
      truncated: report.truncated,
    };
  }

  function compactObjectFields<T extends Record<string, unknown>>(
    value: T,
    fields: Array<keyof T>,
  ): Record<string, unknown> {
    return Object.fromEntries(fields.map((field) => [field, value[field]]));
  }

  function rp(idOrName?: string): string | undefined {
    if (!idOrName) return undefined;
    return resolveProjectId(db, idOrName) ?? idOrName;
  }

  function existingProjectId(idOrName?: string): string | null {
    const resolved = resolveProjectId(db, idOrName);
    if (!resolved) return null;
    const row = db
      .prepare("SELECT id FROM projects WHERE id = ?")
      .get(resolved) as { id: string } | null;
    return row?.id ?? null;
  }

  // Tool registry with param signatures for discoverability
  const TOOLS: Record<string, { desc: string; params: string }> = {
    register_project: {
      desc: "Register a project",
      params: "(name, github_repo?, base_url?, description?)",
    },
    register_page: {
      desc: "Register a page URL to a project",
      params: "(project_id, url, path?, name?)",
    },
    create_scan_job: {
      desc: "Schedule headless page scans",
      params: "(project_id, schedule, page_id?)",
    },
    resolve_project: { desc: "Resolve project name to ID", params: "(name)" },
    log_push: {
      desc: "Push a single log entry",
      params: "(level, message, project_id?, service?, trace_id?, metadata?)",
    },
    log_push_batch: {
      desc: "Push multiple log entries in one call",
      params:
        "(entries: Array<{level, message, project_id?, service?, trace_id?}>)",
    },
    log_search: {
      desc: "Search logs",
      params:
        "(project_id?, level?, since?, until?, text?, service?, limit?=25, brief?=true)",
    },
    log_tail: {
      desc: "Get N most recent logs",
      params: "(project_id?, n?=25, brief?=true)",
    },
    log_count: {
      desc: "Count logs — zero token cost, pure signal",
      params: "(project_id?, service?, level?, since?, until?)",
    },
    log_recent_errors: {
      desc: "Shortcut: recent errors + fatals",
      params: "(project_id?, since?='1h', limit?=20)",
    },
    log_summary: {
      desc: "Error/warn counts by service",
      params: "(project_id?, since?)",
    },
    log_context: {
      desc: "Logs for a trace_id; brief mode is capped by default",
      params: "(trace_id, brief?=true, limit?=25)",
    },
    log_context_from_id: {
      desc: "Trace context from a log ID; brief mode is capped by default",
      params: "(log_id, brief?=true, limit?=25, window?=0)",
    },
    log_export: {
      desc: "Export matching logs as JSON or CSV",
      params:
        "(project_id?, format?='json', since?, until?, level?, service?, limit?=100000)",
    },
    log_diagnose: {
      desc: "Full diagnosis: score, top errors, failing pages, perf regressions",
      params:
        "(project_id, since?='24h', include?=['top_errors','error_rate','failing_pages','perf'])",
    },
    log_compare: {
      desc: "Diff two time windows for new/resolved errors",
      params: "(project_id, a_since, a_until, b_since, b_until)",
    },
    log_session_context: {
      desc: "Logs + session metadata for a session_id",
      params: "(session_id, brief?=true)",
    },
    event_push: {
      desc: "Push one raw-first universal telemetry event",
      params:
        "(type, source?, severity?, message?, event_id?, event_time?, trace_id?, span_id?, run_id?, body?, attributes?)",
    },
    event_search: {
      desc: "Search raw-backed event_records across event types and identity dimensions",
      params:
        "(event_type?, source?, severity?, project_id?, machine_id?, repo_id?, app_id?, process_id?, run_id?, trace_id?, session_id?, text?, limit?=25, brief?=true, include_raw?=false, include_internal?=false)",
    },
    event_get: {
      desc: "Get one event record and optionally reconstruct its raw segment envelope",
      params: "(event_id, include_raw?=true)",
    },
    event_export: {
      desc: "Export matching raw-backed event records as JSON",
      params:
        "(event_type?, source?, severity?, project_id?, trace_id?, run_id?, text?, limit?=100000, include_raw?=false)",
    },
    event_watch: {
      desc: "Poll event_records after a cursor for MCP live-tail consumers",
      params:
        "(last_event_id?, event_type?, source?, severity?, project_id?, trace_id?, run_id?, limit?=25, brief?=true, include_raw?=false, from_start?=false, include_internal?=false)",
    },
    test_report_search: {
      desc: "Search projected test_reports and optionally include bounded test_cases",
      params:
        "(report_id?, event_id?, project_id?, run_id?, process_id?, parser?, parse_status?, case_status?, outcome?, min_failures?, min_errors?, text?, limit?=25, brief?=true, include_cases?=false)",
    },
    test_report_get: {
      desc: "Get one projected test report with bounded test case rows by default",
      params: "(report_id, include_cases?=true)",
    },
    perf_snapshot: {
      desc: "Latest performance snapshot",
      params: "(project_id, page_id?)",
    },
    perf_trend: {
      desc: "Performance over time",
      params: "(project_id, page_id?, since?, limit?=50)",
    },
    scan_status: {
      desc: "Last scan jobs",
      params: "(project_id?, limit?=25, brief?=true)",
    },
    list_projects: {
      desc: "List all projects",
      params: "(limit?=25, brief?=true)",
    },
    list_pages: {
      desc: "List pages for a project",
      params: "(project_id, limit?=25, brief?=true)",
    },
    list_issues: {
      desc: "List grouped error issues",
      params: "(project_id?, status?, limit?=25, brief?=true)",
    },
    resolve_issue: {
      desc: "Update issue status",
      params: "(id, status: open|resolved|ignored)",
    },
    create_alert_rule: {
      desc: "Create alert rule",
      params:
        "(project_id, name, level?, threshold_count?, window_seconds?, webhook_url?)",
    },
    list_alert_rules: {
      desc: "List alert rules",
      params: "(project_id?, limit?=25, brief?=true)",
    },
    delete_alert_rule: { desc: "Delete alert rule", params: "(id)" },
    get_health: {
      desc: "Server health + DB stats",
      params: "(verbose?=false)",
    },
    log_stats: {
      desc: "Aggregate DB-level log statistics for a project",
      params: "(project_id?)",
    },
    storage_status: {
      desc: "Show storage sync configuration",
      params: "(verbose?=false)",
    },
    storage_push: {
      desc: "Push local logs data to storage PostgreSQL",
      params: "(tables?)",
    },
    storage_pull: {
      desc: "Pull logs data from storage PostgreSQL",
      params: "(tables?)",
    },
    storage_sync: {
      desc: "Push local logs data, then pull storage rows",
      params: "(tables?)",
    },
    search_tools: {
      desc: "Search tools by keyword — returns names, descriptions, param signatures",
      params: "(query)",
    },
    describe_tools: {
      desc: "List all tools with descriptions and param signatures",
      params: "()",
    },
  };

  // Fellow agents: keep MCP registrations behind this helper so descriptions and schemas stay aligned with the current SDK.
  function registerTool(
    name: keyof typeof TOOLS,
    schema: Record<string, z.ZodTypeAny>,
    handler: McpToolHandler,
  ) {
    const tool = TOOLS[name];
    if (!tool) throw new Error(`Unknown MCP tool: ${name}`);
    return registerTrackedTool(name, tool.desc, schema, handler);
  }

  function registerTrackedTool(
    name: string,
    desc: string,
    schema: Record<string, z.ZodTypeAny>,
    handler: McpToolHandler,
  ) {
    return server.tool(
      name,
      desc,
      schema,
      async (...args: Parameters<McpToolHandler>) => {
        const startedAt = performance.now();
        try {
          const result = await handler(...args);
          recordMcpToolCall(name, args[0], result, null, startedAt);
          return result;
        } catch (error) {
          recordMcpToolCall(name, args[0], null, error, startedAt);
          throw error;
        }
      },
    );
  }

  registerTool("search_tools", { query: z.string() }, ({ query }) => {
    const q = query.toLowerCase();
    const matches = Object.entries(TOOLS).filter(
      ([k, v]) => k.includes(q) || v.desc.toLowerCase().includes(q),
    );
    const text =
      matches.map(([k, v]) => `${k}${v.params} — ${v.desc}`).join("\n") ||
      "No matches";
    return { content: [{ type: "text", text }] };
  });

  registerTool("describe_tools", {}, () => ({
    content: [
      {
        type: "text",
        text: Object.entries(TOOLS)
          .map(([k, v]) => `${k}${v.params} — ${v.desc}`)
          .join("\n"),
      },
    ],
  }));

  registerTool("resolve_project", { name: z.string() }, ({ name }) => {
    const id = resolveProjectId(db, name);
    const project = id
      ? db.prepare("SELECT * FROM projects WHERE id = $id").get({ $id: id })
      : null;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            project ?? { error: `Project '${name}' not found` },
          ),
        },
      ],
    };
  });

  registerTool(
    "register_project",
    {
      name: z.string(),
      github_repo: z.string().optional(),
      base_url: z.string().optional(),
      description: z.string().optional(),
    },
    (args) => ({
      content: [
        { type: "text", text: JSON.stringify(createProject(db, args)) },
      ],
    }),
  );

  registerTool(
    "register_page",
    {
      project_id: z.string(),
      url: z.string(),
      path: z.string().optional(),
      name: z.string().optional(),
    },
    (args) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            createPage(db, {
              ...args,
              project_id: rp(args.project_id) ?? args.project_id,
            }),
          ),
        },
      ],
    }),
  );

  registerTool(
    "create_scan_job",
    {
      project_id: z.string(),
      schedule: z.string(),
      page_id: z.string().optional(),
    },
    (args) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            createJob(db, {
              ...args,
              project_id: rp(args.project_id) ?? args.project_id,
            }),
          ),
        },
      ],
    }),
  );

  registerTool(
    "log_push",
    {
      level: z.enum(["debug", "info", "warn", "error", "fatal"]),
      message: z.string(),
      project_id: z.string().optional(),
      service: z.string().optional(),
      trace_id: z.string().optional(),
      session_id: z.string().optional(),
      agent: z.string().optional(),
      url: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    },
    (args) => {
      const row = ingestLog(db, { ...args, project_id: rp(args.project_id) });
      return { content: [{ type: "text", text: `Logged: ${row.id}` }] };
    },
  );

  registerTool(
    "log_push_batch",
    {
      entries: z.array(
        z.object({
          level: z.enum(["debug", "info", "warn", "error", "fatal"]),
          message: z.string(),
          project_id: z.string().optional(),
          service: z.string().optional(),
          trace_id: z.string().optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
        }),
      ),
      trace_id: z
        .string()
        .optional()
        .describe(
          "Shared trace_id applied to all entries that don't have their own trace_id",
        ),
      project_id: z
        .string()
        .optional()
        .describe(
          "Shared project_id applied to all entries (individual entry project_id takes precedence)",
        ),
    },
    ({
      entries,
      trace_id,
      project_id,
    }: {
      entries: LogPushBatchEntry[];
      trace_id?: string;
      project_id?: string;
    }) => {
      const mapped = entries.map((e) => ({
        ...e,
        project_id: rp(e.project_id ?? project_id),
      }));
      const rows = ingestBatch(db, mapped, trace_id);
      return {
        content: [
          {
            type: "text",
            text: `Logged ${rows.length} entries${trace_id ? ` (trace: ${trace_id})` : ""}`,
          },
        ],
      };
    },
  );

  registerTool(
    "log_search",
    {
      project_id: z.string().optional(),
      page_id: z.string().optional(),
      level: z.string().optional(),
      service: z.string().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      text: z.string().optional(),
      trace_id: z.string().optional(),
      limit: z.number().optional(),
      brief: z.boolean().optional(),
    },
    (args) => {
      const rows = searchLogs(db, {
        ...args,
        project_id: rp(args.project_id),
        level: args.level ? (args.level.split(",") as LogLevel[]) : undefined,
        since: parseTime(args.since) ?? args.since,
        until: parseTime(args.until) ?? args.until,
        limit: clampMcpListLimit(args.limit),
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(applyBrief(rows, args.brief !== false)),
          },
        ],
      };
    },
  );

  registerTool(
    "log_tail",
    {
      project_id: z.string().optional(),
      n: z.number().optional(),
      brief: z.boolean().optional(),
    },
    ({ project_id, n, brief }) => {
      const rows = tailLogs(db, rp(project_id), clampMcpListLimit(n));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(applyBrief(rows, brief !== false)),
          },
        ],
      };
    },
  );

  registerTool(
    "log_count",
    {
      project_id: z.string().optional(),
      service: z.string().optional(),
      level: z.string().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      group_by: z
        .enum(["level", "service"])
        .optional()
        .describe(
          "Return breakdown by 'level' or 'service' in addition to totals",
        ),
    },
    (args) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            countLogs(db, { ...args, project_id: rp(args.project_id) }),
          ),
        },
      ],
    }),
  );

  registerTool(
    "log_recent_errors",
    {
      project_id: z.string().optional(),
      since: z.string().optional(),
      limit: z.number().optional(),
    },
    ({ project_id, since, limit }) => {
      const rows = searchLogs(db, {
        project_id: rp(project_id),
        level: ["error", "fatal"],
        since: parseTime(since ?? "1h"),
        limit: limit ?? 20,
      });
      return {
        content: [
          { type: "text", text: JSON.stringify(applyBrief(rows, true)) },
        ],
      };
    },
  );

  registerTool(
    "log_summary",
    {
      project_id: z.string().optional(),
      since: z.string().optional(),
    },
    ({ project_id, since }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            summarizeLogs(db, rp(project_id), parseTime(since) ?? since),
          ),
        },
      ],
    }),
  );

  registerTool(
    "log_context",
    {
      trace_id: z.string(),
      brief: z.boolean().optional(),
      limit: z.number().optional(),
    },
    ({ trace_id, brief, limit }) => {
      const allRows = getLogContext(db, trace_id);
      const rows = sliceMcpContextRows(
        allRows,
        resolveMcpContextLimit(limit, brief, allRows.length),
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(applyBrief(rows, brief !== false)),
          },
        ],
      };
    },
  );

  registerTool(
    "log_context_from_id",
    {
      log_id: z.string(),
      brief: z.boolean().optional(),
      limit: z.number().optional(),
      window: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Return N logs before and after the target log's timestamp (in addition to trace context)",
        ),
    },
    ({ log_id, brief, limit, window }) => {
      const allRows = getLogContextFromId(db, log_id, window ?? 0);
      const rows = sliceMcpContextRows(
        allRows,
        resolveMcpContextLimit(limit, brief, allRows.length),
        log_id,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(applyBrief(rows, brief !== false)),
          },
        ],
      };
    },
  );

  registerTool(
    "log_export",
    {
      project_id: z.string().optional().describe("Project name or ID"),
      format: z
        .enum(["json", "csv"])
        .optional()
        .default("json")
        .describe("Output format"),
      since: z.string().optional().describe("Since time (1h, 24h, 7d, ISO)"),
      until: z.string().optional(),
      level: z.array(z.string()).optional().describe("Filter by levels"),
      service: z.string().optional(),
      limit: z.number().optional().default(100000),
    },
    (args) => {
      const chunks: string[] = [];
      const write = (s: string) => {
        chunks.push(s);
        return true;
      };
      const options = {
        project_id: rp(args.project_id),
        level: args.level as never,
        service: args.service,
        since: args.since,
        until: args.until,
        limit: args.limit ?? 100000,
      };
      if (args.format === "csv") exportToCsv(db, options, write);
      else exportToJson(db, options, write);
      return { content: [{ type: "text" as const, text: chunks.join("") }] };
    },
  );

  registerTool(
    "log_diagnose",
    {
      project_id: z.string(),
      since: z.string().optional(),
      include: z
        .array(z.enum(["top_errors", "error_rate", "failing_pages", "perf"]))
        .optional(),
    },
    ({ project_id, since, include }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            diagnose(db, rp(project_id) ?? project_id, since, include),
          ),
        },
      ],
    }),
  );

  registerTool(
    "log_compare",
    {
      project_id: z.string(),
      a_since: z.string(),
      a_until: z.string(),
      b_since: z.string(),
      b_until: z.string(),
    },
    ({ project_id, a_since, a_until, b_since, b_until }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            compare(
              db,
              rp(project_id) ?? project_id,
              parseTime(a_since) ?? a_since,
              parseTime(a_until) ?? a_until,
              parseTime(b_since) ?? b_since,
              parseTime(b_until) ?? b_until,
            ),
          ),
        },
      ],
    }),
  );

  registerTool(
    "log_session_context",
    {
      session_id: z.string(),
      brief: z.boolean().optional(),
    },
    async ({ session_id, brief }) => {
      const ctx = await getSessionContext(db, session_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ...ctx,
              logs: applyBrief(ctx.logs, brief !== false),
            }),
          },
        ],
      };
    },
  );

  registerTool(
    "event_push",
    {
      type: z.enum(
        UNIVERSAL_EVENT_TYPES as [UniversalEventType, ...UniversalEventType[]],
      ),
      event_id: z.string().optional(),
      source_event_id: z.string().optional(),
      event_time: z.string().optional(),
      source: z.string().optional(),
      severity: z.enum(["debug", "info", "warn", "error", "fatal"]).optional(),
      privacy: z
        .enum(["public", "internal", "sensitive", "secret", "pii"])
        .optional(),
      message: z.string().optional(),
      project_id: z.string().optional(),
      machine_id: z.string().optional(),
      repo_id: z.string().optional(),
      app_id: z.string().optional(),
      process_id: z.string().optional(),
      run_id: z.string().optional(),
      trace_id: z.string().optional(),
      span_id: z.string().optional(),
      parent_span_id: z.string().optional(),
      session_id: z.string().optional(),
      release_id: z.string().optional(),
      artifact_id: z.string().optional(),
      environment: z.string().optional(),
      body: z.record(z.string(), z.unknown()).optional(),
      attributes: z.record(z.string(), z.unknown()).optional(),
    },
    (args) => {
      const projectId = rp(args.project_id);
      const hasExplicitIdentity = Boolean(
        args.machine_id || args.repo_id || args.app_id,
      );
      const eventInput: UniversalEventInput = {
        ...args,
        project_id: projectId,
        environment: args.environment ?? process.env.NODE_ENV ?? "development",
      };
      validateUniversalEventInput(eventInput);
      const identity = hasExplicitIdentity
        ? null
        : detectRuntimeIdentity(db, process.cwd(), {
            project_id: existingProjectId(args.project_id),
            environment: args.environment,
          });
      if (identity) {
        eventInput.machine_id = identity.machine_id;
        eventInput.repo_id = identity.repo_id ?? undefined;
        eventInput.app_id = identity.app_id ?? undefined;
        eventInput.environment = args.environment ?? identity.environment;
      }
      const result = ingestUniversalEvent(db, eventInput);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              inserted: result.inserted,
              event: result.event,
            }),
          },
        ],
      };
    },
  );

  registerTool(
    "event_search",
    {
      event_type: z.string().optional(),
      source: z.string().optional(),
      severity: z.string().optional(),
      project_id: z.string().optional(),
      machine_id: z.string().optional(),
      repo_id: z.string().optional(),
      app_id: z.string().optional(),
      process_id: z.string().optional(),
      run_id: z.string().optional(),
      trace_id: z.string().optional(),
      session_id: z.string().optional(),
      environment: z.string().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      text: z.string().optional(),
      limit: z.number().optional(),
      include_raw: z.boolean().optional(),
      include_internal: z.boolean().optional(),
      brief: z.boolean().optional(),
    },
    (args) => {
      const wantsFullRows = args.brief === false || args.include_raw === true;
      const rows = searchEvents(db, {
        ...args,
        project_id: rp(args.project_id),
        since: parseTime(args.since) ?? args.since,
        until: parseTime(args.until) ?? args.until,
        limit: clampMcpListLimit(args.limit),
        include_raw: args.include_raw === true,
        exclude_mcp_tool_telemetry: args.include_internal !== true,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              wantsFullRows ? rows : rows.map(compactMcpEvent),
            ),
          },
        ],
      };
    },
  );

  registerTool(
    "event_get",
    {
      event_id: z.string(),
      include_raw: z.boolean().optional(),
    },
    ({ event_id, include_raw }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(getEvent(db, event_id, include_raw !== false)),
        },
      ],
    }),
  );

  registerTool(
    "event_export",
    {
      event_type: z.string().optional(),
      source: z.string().optional(),
      severity: z.string().optional(),
      project_id: z.string().optional(),
      trace_id: z.string().optional(),
      run_id: z.string().optional(),
      text: z.string().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      limit: z.number().optional(),
      include_raw: z.boolean().optional(),
    },
    (args) => {
      const chunks: string[] = [];
      const count = exportEventsToJson(
        db,
        {
          ...args,
          project_id: rp(args.project_id),
          since: parseTime(args.since) ?? args.since,
          until: parseTime(args.until) ?? args.until,
          limit: args.limit ?? 100_000,
          include_raw: args.include_raw === true,
        },
        (s) => chunks.push(s),
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              count,
              events: JSON.parse(chunks.join("\n")),
            }),
          },
        ],
      };
    },
  );

  registerTool(
    "event_watch",
    {
      last_event_id: z.string().optional(),
      event_type: z.string().optional(),
      source: z.string().optional(),
      severity: z.string().optional(),
      project_id: z.string().optional(),
      machine_id: z.string().optional(),
      repo_id: z.string().optional(),
      app_id: z.string().optional(),
      process_id: z.string().optional(),
      run_id: z.string().optional(),
      trace_id: z.string().optional(),
      session_id: z.string().optional(),
      environment: z.string().optional(),
      limit: z.number().optional(),
      include_raw: z.boolean().optional(),
      from_start: z.boolean().optional(),
      include_internal: z.boolean().optional(),
      brief: z.boolean().optional(),
    },
    (args) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            watchEventsForMcp({
              ...args,
              project_id: rp(args.project_id),
              limit: clampMcpListLimit(args.limit),
              include_raw: args.include_raw === true,
              from_start: args.from_start === true,
              include_internal: args.include_internal === true,
              brief: args.brief,
            }),
          ),
        },
      ],
    }),
  );

  registerTool(
    "test_report_search",
    {
      report_id: z.string().optional(),
      event_id: z.string().optional(),
      project_id: z.string().optional(),
      machine_id: z.string().optional(),
      repo_id: z.string().optional(),
      app_id: z.string().optional(),
      process_id: z.string().optional(),
      run_id: z.string().optional(),
      environment: z.string().optional(),
      source: z.string().optional(),
      parser: z.string().optional(),
      parse_status: z.string().optional(),
      path: z.string().optional(),
      case_status: z.string().optional(),
      outcome: z
        .enum([
          "failed",
          "error",
          "nonpassing",
          "skipped",
          "passed",
          "parse_problem",
        ])
        .optional(),
      min_failures: z.number().optional(),
      min_errors: z.number().optional(),
      min_skipped: z.number().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      text: z.string().optional(),
      limit: z.number().optional(),
      include_cases: z.boolean().optional(),
      brief: z.boolean().optional(),
    },
    (args) => {
      const rows = searchTestReports(db, {
        ...args,
        project_id: rp(args.project_id),
        since: parseTime(args.since) ?? args.since,
        until: parseTime(args.until) ?? args.until,
        limit: clampMcpListLimit(args.limit),
        include_cases: args.include_cases === true,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              args.brief === false || args.include_cases === true
                ? rows
                : rows.map(compactMcpTestReport),
            ),
          },
        ],
      };
    },
  );

  registerTool(
    "test_report_get",
    {
      report_id: z.string(),
      include_cases: z.boolean().optional(),
    },
    ({ report_id, include_cases }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            getTestReport(db, report_id, include_cases !== false),
          ),
        },
      ],
    }),
  );

  registerTool(
    "perf_snapshot",
    {
      project_id: z.string(),
      page_id: z.string().optional(),
    },
    ({ project_id, page_id }) => {
      const snap = getLatestSnapshot(db, rp(project_id) ?? project_id, page_id);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              snap ? { ...snap, label: scoreLabel(snap.score) } : null,
            ),
          },
        ],
      };
    },
  );

  registerTool(
    "perf_trend",
    {
      project_id: z.string(),
      page_id: z.string().optional(),
      since: z.string().optional(),
      limit: z.number().optional(),
    },
    ({ project_id, page_id, since, limit }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            getPerfTrend(
              db,
              rp(project_id) ?? project_id,
              page_id,
              parseTime(since) ?? since,
              limit ?? 50,
            ),
          ),
        },
      ],
    }),
  );

  registerTool(
    "scan_status",
    {
      project_id: z.string().optional(),
      limit: z.number().optional(),
      brief: z.boolean().optional(),
    },
    ({ project_id, limit, brief }) => {
      const rows = listJobs(db, rp(project_id)).slice(
        0,
        clampMcpListLimit(limit),
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              brief === false
                ? rows
                : rows.map((job) => ({
                    id: job.id,
                    project_id: job.project_id,
                    page_id: job.page_id,
                    schedule: compactMcpText(job.schedule, 80),
                    enabled: job.enabled,
                    last_run_at: job.last_run_at,
                  })),
            ),
          },
        ],
      };
    },
  );

  registerTool(
    "list_projects",
    { limit: z.number().optional(), brief: z.boolean().optional() },
    ({ limit, brief }) => {
      const rows = listProjects(db).slice(0, clampMcpListLimit(limit));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              brief === false
                ? rows
                : rows.map((project) => ({
                    id: project.id,
                    name: compactMcpText(project.name, 80),
                    base_url: compactMcpText(project.base_url, 100),
                    github_repo: compactMcpText(project.github_repo, 100),
                    created_at: project.created_at,
                  })),
            ),
          },
        ],
      };
    },
  );

  registerTool(
    "list_pages",
    {
      project_id: z.string(),
      limit: z.number().optional(),
      brief: z.boolean().optional(),
    },
    ({ project_id, limit, brief }) => {
      const rows = listPages(db, rp(project_id) ?? project_id).slice(
        0,
        clampMcpListLimit(limit),
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              brief === false
                ? rows
                : rows.map((page) => ({
                    id: page.id,
                    project_id: page.project_id,
                    url: compactMcpText(page.url, 140),
                    path: compactMcpText(page.path, 80),
                    last_scanned_at: page.last_scanned_at,
                  })),
            ),
          },
        ],
      };
    },
  );

  registerTool(
    "list_issues",
    {
      project_id: z.string().optional(),
      status: z.string().optional(),
      limit: z.number().optional(),
      brief: z.boolean().optional(),
    },
    ({ project_id, status, limit, brief }) => {
      const rows = listIssues(
        db,
        rp(project_id),
        status,
        clampMcpListLimit(limit),
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              brief === false
                ? rows
                : rows.map((issue) => ({
                    id: issue.id,
                    project_id: issue.project_id,
                    status: issue.status,
                    level: issue.level,
                    service: compactMcpText(issue.service, 48),
                    message_template: compactMcpText(issue.message_template),
                    count: issue.count,
                    last_seen: issue.last_seen,
                  })),
            ),
          },
        ],
      };
    },
  );

  registerTool(
    "resolve_issue",
    {
      id: z.string(),
      status: z.enum(["open", "resolved", "ignored"]),
    },
    ({ id, status }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(updateIssueStatus(db, id, status)),
        },
      ],
    }),
  );

  registerTool(
    "create_alert_rule",
    {
      project_id: z.string(),
      name: z.string(),
      level: z.string().optional(),
      service: z.string().optional(),
      threshold_count: z.number().optional(),
      window_seconds: z.number().optional(),
      action: z.enum(["webhook", "log"]).optional(),
      webhook_url: z.string().optional(),
    },
    (args) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            createAlertRule(db, {
              ...args,
              project_id: rp(args.project_id) ?? args.project_id,
            }),
          ),
        },
      ],
    }),
  );

  registerTool(
    "list_alert_rules",
    {
      project_id: z.string().optional(),
      limit: z.number().optional(),
      brief: z.boolean().optional(),
    },
    ({ project_id, limit, brief }) => {
      const rows = listAlertRules(db, rp(project_id)).slice(
        0,
        clampMcpListLimit(limit),
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              brief === false
                ? rows
                : rows.map((rule) =>
                    compactObjectFields(rule as Record<string, unknown>, [
                      "id",
                      "project_id",
                      "name",
                      "level",
                      "service",
                      "threshold_count",
                      "window_seconds",
                      "enabled",
                    ]),
                  ),
            ),
          },
        ],
      };
    },
  );

  registerTool("delete_alert_rule", { id: z.string() }, ({ id }) => {
    deleteAlertRule(db, id);
    return { content: [{ type: "text", text: "deleted" }] };
  });

  registerTool(
    "get_health",
    { verbose: z.boolean().optional() },
    ({ verbose }) => {
      const health = getHealth(db);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              verbose === true
                ? health
                : {
                    status: health.status,
                    total_logs: health.total_logs,
                    projects: health.projects,
                    scheduler_jobs: health.scheduler_jobs,
                    open_issues: health.open_issues,
                    newest_log: health.newest_log,
                  },
            ),
          },
        ],
      };
    },
  );

  registerTool(
    "log_stats",
    {
      project_id: z
        .string()
        .optional()
        .describe("Project name or ID (scope stats to a project)"),
    },
    (args) => {
      const projectId = rp(args.project_id);
      const pFilter = projectId ? "WHERE project_id = ?" : "";
      const pAnd = projectId ? "AND project_id = ?" : "";
      const pParam = projectId ? [projectId] : [];

      const total = (
        db
          .query(`SELECT COUNT(*) as c FROM logs ${pFilter}`)
          .get(...pParam) as {
          c: number;
        }
      ).c;
      const oldest = (
        db
          .query(`SELECT MIN(timestamp) as t FROM logs ${pFilter}`)
          .get(...pParam) as { t: string | null }
      ).t;
      const newest = (
        db
          .query(`SELECT MAX(timestamp) as t FROM logs ${pFilter}`)
          .get(...pParam) as { t: string | null }
      ).t;
      const byLevel = db
        .query(
          `SELECT level, COUNT(*) as c FROM logs ${pFilter} GROUP BY level ORDER BY c DESC`,
        )
        .all(...pParam) as { level: string; c: number }[];
      const topServices = db
        .query(
          `SELECT COALESCE(service, '-') as service, COUNT(*) as c FROM logs ${pFilter} GROUP BY service ORDER BY c DESC LIMIT 5`,
        )
        .all(...pParam) as { service: string; c: number }[];
      const days = db
        .query(
          `SELECT strftime('%Y-%m-%d', timestamp) as day, COUNT(*) as c FROM logs WHERE timestamp >= datetime('now', '-7 days') ${pAnd} GROUP BY day ORDER BY day`,
        )
        .all(...pParam) as { day: string; c: number }[];
      const errors =
        (byLevel.find((r) => r.level === "error")?.c ?? 0) +
        (byLevel.find((r) => r.level === "fatal")?.c ?? 0);
      const error_rate_pct =
        total > 0 ? Number.parseFloat(((errors / total) * 100).toFixed(2)) : 0;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              total,
              oldest,
              newest,
              by_level: Object.fromEntries(byLevel.map((r) => [r.level, r.c])),
              top_services: topServices,
              last_7_days: days,
              error_rate_pct,
            }),
          },
        ],
      };
    },
  );

  registerTrackedTool(
    "send_feedback",
    "Send feedback about this service",
    {
      message: z.string(),
      email: z.string().optional(),
      category: z.enum(["bug", "feature", "general"]).optional(),
    },
    async (params) => {
      try {
        db.run(
          "INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)",
          [
            params.message,
            params.email || null,
            params.category || "general",
            PACKAGE_VERSION,
          ],
        );
        return {
          content: [
            { type: "text" as const, text: "Feedback saved. Thank you!" },
          ],
        };
      } catch (e) {
        return {
          content: [{ type: "text" as const, text: String(e) }],
          isError: true,
        };
      }
    },
  );

  interface McpEventWatchArgs {
    last_event_id?: string;
    event_type?: string;
    source?: string;
    severity?: string;
    project_id?: string;
    machine_id?: string;
    repo_id?: string;
    app_id?: string;
    process_id?: string;
    run_id?: string;
    trace_id?: string;
    session_id?: string;
    environment?: string;
    limit?: number;
    include_raw?: boolean;
    from_start?: boolean;
    include_internal?: boolean;
    brief?: boolean;
  }

  interface McpEventCursor {
    rowid: number;
    event_id: string;
  }

  function watchEventsForMcp(args: McpEventWatchArgs): {
    events: unknown[];
    cursor: string | null;
    has_more: boolean;
    overflow: null | { reason: string; last_event_id: string };
  } {
    const limit = clampMcpWatchLimit(args.limit);
    const latest = latestMcpEventCursor(args);
    let afterRowid = 0;
    let cursor = args.last_event_id ?? latest?.event_id ?? null;
    let overflow: null | { reason: string; last_event_id: string } = null;

    if (args.last_event_id) {
      const anchor = db
        .prepare("SELECT rowid, event_id FROM event_records WHERE event_id = ?")
        .get(args.last_event_id) as McpEventCursor | null;
      if (!anchor) {
        overflow = {
          reason: "last_event_id_unknown",
          last_event_id: args.last_event_id,
        };
        return {
          events: [],
          cursor: latest?.event_id ?? null,
          has_more: false,
          overflow,
        };
      }
      afterRowid = anchor.rowid;
      cursor = anchor.event_id;
    } else if (args.from_start !== true) {
      return { events: [], cursor, has_more: false, overflow: null };
    }

    const rows = queryMcpEventCursors(args, afterRowid, limit + 1);
    const visibleRows = rows.slice(0, limit);
    const events = visibleRows
      .map((row) => getEvent(db, row.event_id, args.include_raw === true))
      .filter(Boolean);
    const last = visibleRows.at(-1);
    if (last) cursor = last.event_id;

    return {
      events:
        args.brief === false || args.include_raw === true
          ? events
          : events.map((event) => compactMcpEvent(event)),
      cursor,
      has_more: rows.length > limit,
      overflow,
    };
  }

  function latestMcpEventCursor(
    args: McpEventWatchArgs,
  ): McpEventCursor | null {
    const { where, params } = buildMcpEventWhere(args, null);
    return db
      .prepare(
        `SELECT rowid, event_id FROM event_records ${where} ORDER BY rowid DESC LIMIT 1`,
      )
      .get(...params) as McpEventCursor | null;
  }

  function queryMcpEventCursors(
    args: McpEventWatchArgs,
    afterRowid: number,
    limit: number,
  ): McpEventCursor[] {
    const { where, params } = buildMcpEventWhere(args, afterRowid);
    return db
      .prepare(
        `SELECT rowid, event_id FROM event_records ${where} ORDER BY rowid ASC LIMIT ?`,
      )
      .all(...params, limit) as McpEventCursor[];
  }

  function buildMcpEventWhere(
    args: McpEventWatchArgs,
    afterRowid: number | null,
  ): { where: string; params: Array<string | number> } {
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (afterRowid !== null) {
      conditions.push("rowid > ?");
      params.push(afterRowid);
    }
    addMcpListFilter(conditions, params, "event_type", args.event_type);
    addMcpListFilter(conditions, params, "source", args.source);
    addMcpListFilter(conditions, params, "severity", args.severity);
    addMcpScalarFilter(conditions, params, "project_id", args.project_id);
    addMcpScalarFilter(conditions, params, "machine_id", args.machine_id);
    addMcpScalarFilter(conditions, params, "repo_id", args.repo_id);
    addMcpScalarFilter(conditions, params, "app_id", args.app_id);
    addMcpScalarFilter(conditions, params, "process_id", args.process_id);
    addMcpScalarFilter(conditions, params, "run_id", args.run_id);
    addMcpScalarFilter(conditions, params, "trace_id", args.trace_id);
    addMcpScalarFilter(conditions, params, "session_id", args.session_id);
    addMcpScalarFilter(conditions, params, "environment", args.environment);
    if (args.include_internal !== true) {
      conditions.push(
        "NOT (event_type = 'agent' AND source = 'mcp' AND metadata LIKE ?)",
      );
      params.push('%"category":"mcp_tool_call"%');
    }
    return {
      where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
      params,
    };
  }

  function addMcpListFilter(
    conditions: string[],
    params: Array<string | number>,
    column: string,
    value: string | undefined,
  ): void {
    const values =
      value
        ?.split(",")
        .map((item) => item.trim())
        .filter(Boolean) ?? [];
    if (values.length === 0) return;
    conditions.push(`${column} IN (${values.map(() => "?").join(",")})`);
    params.push(...values);
  }

  function addMcpScalarFilter(
    conditions: string[],
    params: Array<string | number>,
    column: string,
    value: string | undefined,
  ): void {
    if (!value) return;
    conditions.push(`${column} = ?`);
    params.push(value);
  }

  function clampMcpWatchLimit(value: number | undefined): number {
    if (!Number.isFinite(value) || value === undefined) return 100;
    return Math.min(Math.max(1, Math.floor(value)), 1_000);
  }

  function recordMcpToolCall(
    toolName: string,
    args: unknown,
    result: unknown,
    error: unknown,
    startedAt: number,
  ): void {
    const durationMs = Math.max(0, Math.round(performance.now() - startedAt));
    const status = error ? "error" : isMcpErrorResult(result) ? "error" : "ok";
    const argsSummary = summarizeMcpArguments(args);
    const resultSummary = summarizeMcpResult(result);
    try {
      ingestUniversalEvent(db, {
        type: "agent",
        source: "mcp",
        severity: status === "ok" ? "info" : "error",
        privacy: "internal",
        message: `MCP tool ${toolName} ${status === "ok" ? "completed" : "failed"}`,
        body: {
          mcp: {
            tool_call: {
              tool_name: toolName,
              status,
              duration_ms: durationMs,
              arguments: argsSummary,
              result: resultSummary,
              error: error ? summarizeError(error) : null,
            },
          },
        },
        attributes: {
          category: "mcp_tool_call",
          tool_name: toolName,
          status,
          duration_ms: durationMs,
          argument_keys: argsSummary.keys.join(","),
          argument_count: argsSummary.keys.length,
          result_content_count: resultSummary.content_count,
          result_text_length: resultSummary.text_length,
        },
      });
    } catch {
      // Telemetry must not change MCP tool behavior.
    }
  }

  function recordMcpAgentActivity(
    phase: string,
    agent: _LogsAgent,
    extra: Record<string, unknown> = {},
  ): void {
    try {
      ingestUniversalEvent(db, {
        type: "agent",
        source: "mcp",
        severity: "info",
        privacy: "internal",
        message: `MCP agent ${phase}: ${agent.name}`,
        session_id: agent.session_id ?? undefined,
        attributes: {
          category: "mcp_agent_session",
          phase,
          agent_id: agent.id,
          agent_name: agent.name,
          session_id: agent.session_id,
          project_id: agent.project_id,
          ...extra,
        },
        body: {
          agent: {
            id: agent.id,
            name: agent.name,
            session_id: agent.session_id ?? null,
            project_id: agent.project_id ?? null,
            last_seen_at: agent.last_seen_at,
            phase,
            ...extra,
          },
        },
      });
    } catch {
      // Agent registry actions should survive telemetry persistence failures.
    }
  }

  interface McpArgumentSummary {
    keys: string[];
    shape: unknown;
    values_captured: boolean;
  }

  interface McpResultSummary {
    is_error: boolean;
    content_count: number;
    content_types: string[];
    text_length: number;
  }

  function summarizeMcpArguments(args: unknown): McpArgumentSummary {
    const keys = isRecord(args) ? Object.keys(args).sort() : [];
    return {
      keys,
      shape: summarizeShape(args),
      values_captured: false,
    };
  }

  function summarizeMcpResult(result: unknown): McpResultSummary {
    if (!isRecord(result))
      return {
        is_error: false,
        content_count: 0,
        content_types: [],
        text_length: 0,
      };
    const content = Array.isArray(result.content) ? result.content : [];
    let textLength = 0;
    const types = new Set<string>();
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (typeof item.type === "string") types.add(item.type);
      if (typeof item.text === "string") textLength += item.text.length;
    }
    return {
      is_error: result.isError === true,
      content_count: content.length,
      content_types: [...types].sort(),
      text_length: textLength,
    };
  }

  function summarizeShape(value: unknown, depth = 0): unknown {
    if (value === null) return { type: "null" };
    if (typeof value === "string")
      return { type: "string", length: value.length };
    const valueType = typeof value;
    if (
      valueType === "number" ||
      valueType === "boolean" ||
      valueType === "bigint"
    )
      return { type: valueType };
    if (Array.isArray(value))
      return {
        type: "array",
        length: value.length,
        items: depth >= 2 ? undefined : summarizeArrayItems(value, depth + 1),
      };
    if (isRecord(value)) {
      const keys = Object.keys(value).sort();
      return {
        type: "object",
        keys: depth === 0 ? keys : undefined,
        field_count: keys.length,
        fields:
          depth >= 1
            ? undefined
            : Object.fromEntries(
                keys
                  .slice(0, 25)
                  .map((key) => [key, summarizeShape(value[key], depth + 1)]),
              ),
      };
    }
    return { type: valueType };
  }

  function summarizeArrayItems(values: unknown[], depth: number): unknown[] {
    return values.slice(0, 10).map((value) => summarizeShape(value, depth));
  }

  function summarizeError(error: unknown): Record<string, unknown> {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: error instanceof Error ? error.name : typeof error,
      message_length: message.length,
      message_present: message.length > 0,
    };
  }

  function isMcpErrorResult(value: unknown): boolean {
    return isRecord(value) && value.isError === true;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  // --- Agent Tools ---

  registerTrackedTool(
    "register_agent",
    "Register an agent session. Returns agent_id. Auto-triggers a heartbeat.",
    {
      name: z.string(),
      session_id: z.string().optional(),
    },
    async (params) => {
      const existing = [..._logsAgents.values()].find(
        (a) => a.name === params.name,
      );
      if (existing) {
        existing.last_seen_at = new Date().toISOString();
        if (params.session_id) existing.session_id = params.session_id;
        recordMcpAgentActivity("registered_existing", existing);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(existing) }],
        };
      }
      const id = Math.random().toString(36).slice(2, 10);
      const ag: _LogsAgent = {
        id,
        name: params.name,
        session_id: params.session_id,
        last_seen_at: new Date().toISOString(),
      };
      _logsAgents.set(id, ag);
      recordMcpAgentActivity("registered", ag);
      return { content: [{ type: "text" as const, text: JSON.stringify(ag) }] };
    },
  );

  registerTrackedTool(
    "heartbeat",
    "Update last_seen_at to signal agent is active.",
    {
      agent_id: z.string(),
    },
    async (params) => {
      const ag = _logsAgents.get(params.agent_id);
      if (!ag)
        return {
          content: [
            {
              type: "text" as const,
              text: `Agent not found: ${params.agent_id}`,
            },
          ],
          isError: true,
        };
      ag.last_seen_at = new Date().toISOString();
      recordMcpAgentActivity("heartbeat", ag);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              agent_id: ag.id,
              last_seen_at: ag.last_seen_at,
            }),
          },
        ],
      };
    },
  );

  registerTrackedTool(
    "set_focus",
    "Set active project context for this agent session.",
    {
      agent_id: z.string(),
      project_id: z.string().optional(),
    },
    async (params) => {
      const ag = _logsAgents.get(params.agent_id);
      if (!ag)
        return {
          content: [
            {
              type: "text" as const,
              text: `Agent not found: ${params.agent_id}`,
            },
          ],
          isError: true,
        };
      ag.project_id = params.project_id;
      recordMcpAgentActivity("focus", ag);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              agent_id: ag.id,
              project_id: ag.project_id ?? null,
            }),
          },
        ],
      };
    },
  );

  registerTrackedTool(
    "list_agents",
    "List all registered agents.",
    { limit: z.number().optional(), brief: z.boolean().optional() },
    async ({ limit, brief }) => {
      const agents = [..._logsAgents.values()].slice(
        0,
        clampMcpListLimit(limit),
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              brief === false
                ? agents
                : agents.map((agent) => ({
                    id: agent.id,
                    name: compactMcpText(agent.name, 80),
                    project_id: agent.project_id ?? null,
                    last_seen_at: agent.last_seen_at,
                  })),
            ),
          },
        ],
      };
    },
  );

  registerTrackedTool(
    "storage_status",
    "Check configured logs PostgreSQL remote storage.",
    { verbose: z.boolean().optional() },
    async ({ verbose }) => {
      const status = getStorageStatus();
      if (!status.configured)
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                verbose === true
                  ? status
                  : {
                      configured: status.configured,
                      mode: status.mode,
                      service: status.service,
                      table_count: status.tables.length,
                      activeEnv: status.activeEnv,
                    },
              ),
            },
          ],
        };
      let storage: Awaited<ReturnType<typeof getStoragePg>> | null = null;
      try {
        storage = await getStoragePg();
        await storage.get("SELECT 1 as ok");
        const remoteTables = (await storage.all(
          "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
        )) as Array<{ tablename: string }>;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                verbose === true
                  ? {
                      ...status,
                      connected: true,
                      remoteTables: remoteTables.map((row) => row.tablename),
                    }
                  : {
                      configured: status.configured,
                      mode: status.mode,
                      service: status.service,
                      activeEnv: status.activeEnv,
                      table_count: status.tables.length,
                      connected: true,
                      remote_table_count: remoteTables.length,
                    },
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: String(error) }],
          isError: true,
        };
      } finally {
        if (storage) await storage.close().catch(() => {});
      }
    },
  );

  registerTrackedTool(
    "storage_push",
    "Push local logs data to storage PostgreSQL.",
    { tables: z.array(z.string()).optional() },
    async ({ tables }) => {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(await storagePush({ tables })),
          },
        ],
      };
    },
  );

  registerTrackedTool(
    "storage_pull",
    "Pull logs data from storage PostgreSQL.",
    { tables: z.array(z.string()).optional() },
    async ({ tables }) => {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(await storagePull({ tables })),
          },
        ],
      };
    },
  );

  registerTrackedTool(
    "storage_sync",
    "Push local logs data, then pull storage rows.",
    { tables: z.array(z.string()).optional() },
    async ({ tables }) => {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(await storageSync({ tables })),
          },
        ],
      };
    },
  );

  return server;
}

async function main(): Promise<void> {
  const { isHttpMode, isStdioMode, resolveMcpHttpPort, startMcpHttpServer } =
    await import("./http.ts");

  if (isStdioMode() || !isHttpMode()) {
    const server = buildServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return;
  }

  // Default: shared Streamable HTTP server (one process per MCP, many agents).
  const handle = await startMcpHttpServer(buildServer, {
    port: resolveMcpHttpPort(),
  });
  process.on(
    "SIGINT",
    () => void handle.close().finally(() => process.exit(0)),
  );
  process.on(
    "SIGTERM",
    () => void handle.close().finally(() => process.exit(0)),
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
