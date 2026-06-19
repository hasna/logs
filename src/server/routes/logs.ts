import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import type { Context } from "hono";
import { touchBrowserIngestToken } from "../../lib/browser-ingest-tokens.ts";
import { countLogs } from "../../lib/count.ts";
import { exportToCsv, exportToJson } from "../../lib/export.ts";
import { ingestBatch, ingestLog } from "../../lib/ingest.ts";
import { parseTime } from "../../lib/parse-time.ts";
import { resolveProjectId } from "../../lib/projects.ts";
import { getLogContext, searchLogs, tailLogs } from "../../lib/query.ts";
import {
  type StructuredLogFormat,
  type StructuredLogOptions,
  structuredLogPayloadToEntries,
  validateStructuredLogReferences,
} from "../../lib/structured-logs.ts";
import { summarizeLogs } from "../../lib/summarize.ts";
import type {
  LogEntry,
  LogLevel,
  LogSource,
  PrivacyClass,
} from "../../types/index.ts";
import { type LogIngestAuthorization, authorizeLogIngest } from "../auth.ts";

const LOG_LEVELS = new Set<LogLevel>([
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
]);
const LOG_SOURCES = new Set<LogSource>([
  "sdk",
  "script",
  "scanner",
  "browser",
  "node",
  "bun",
  "next",
  "vite",
  "cli",
  "build",
  "test",
  "mcp",
  "agent",
  "otel",
  "system",
  "pino",
  "winston",
  "structured",
]);
const PRIVACY_CLASSES = new Set<PrivacyClass>([
  "public",
  "internal",
  "sensitive",
  "secret",
  "pii",
]);
const LOG_ENTRY_KEYS = new Set([
  "id",
  "timestamp",
  "source_event_id",
  "project_id",
  "page_id",
  "level",
  "source",
  "service",
  "message",
  "privacy",
  "machine_id",
  "repo_id",
  "app_id",
  "process_id",
  "run_id",
  "trace_id",
  "span_id",
  "parent_span_id",
  "session_id",
  "release_id",
  "environment",
  "agent",
  "url",
  "stack_trace",
  "metadata",
]);

type IngestValidation =
  | {
      ok: true;
      entries: LogEntry[];
      batch: boolean;
      authorization: LogIngestAuthorization;
    }
  | { ok: false; status: 400 | 401 | 413 | 415 | 422; message: string };

type EntryValidation =
  | { ok: true; entry: LogEntry }
  | { ok: false; status: 413 | 422; message: string };

export function logsRoutes(db: Database) {
  const app = new Hono();

  // POST /api/logs/structured — normalize Pino/Winston/JSON logs into canonical log events.
  app.post("/structured", async (c) => {
    const validation = await validateStructuredIngestRequest(db, c);
    if (!validation.ok)
      return c.json({ error: validation.message }, validation.status);

    const rows = validation.entries.map((entry) => ingestLog(db, entry));
    return c.json(
      {
        inserted: rows.length,
        events: rows.map((row) => ({
          id: row.id,
          timestamp: row.timestamp,
          level: row.level,
          source: row.source,
          service: row.service,
          message: row.message,
          trace_id: row.trace_id,
        })),
      },
      201,
    );
  });

  // POST /api/logs — ingest single or batch
  app.post("/", async (c) => {
    const validation = await validateIngestRequest(db, c);
    if (!validation.ok)
      return c.json({ error: validation.message }, validation.status);

    if (validation.batch) {
      const rows = ingestBatch(db, validation.entries);
      if (validation.authorization.kind === "browser-token")
        touchBrowserIngestToken(db, validation.authorization.token.id);
      return c.json({ inserted: rows.length }, 201);
    }
    const [entry] = validation.entries;
    if (!entry) return c.json({ error: "No log entry provided" }, 422);
    const row = ingestLog(db, entry);
    if (validation.authorization.kind === "browser-token")
      touchBrowserIngestToken(db, validation.authorization.token.id);
    return c.json(row, 201);
  });

  // GET /api/logs
  app.get("/", (c) => {
    const {
      project_id,
      page_id,
      level,
      service,
      since,
      until,
      text,
      trace_id,
      limit,
      offset,
      fields,
    } = c.req.query();
    const rows = searchLogs(db, {
      project_id: project_id || undefined,
      page_id: page_id || undefined,
      level: level ? (level.split(",") as LogLevel[]) : undefined,
      service: service || undefined,
      since: since || undefined,
      until: until || undefined,
      text: text || undefined,
      trace_id: trace_id || undefined,
      limit: limit ? Number(limit) : 100,
      offset: offset ? Number(offset) : 0,
    });
    if (fields) {
      const keys = fields.split(",");
      return c.json(
        rows.map((r) =>
          Object.fromEntries(
            keys.map((k) => [k, (r as unknown as Record<string, unknown>)[k]]),
          ),
        ),
      );
    }
    return c.json(rows);
  });

  // GET /api/logs/tail
  app.get("/tail", (c) => {
    const { project_id, n } = c.req.query();
    const rows = tailLogs(db, project_id || undefined, n ? Number(n) : 50);
    return c.json(rows);
  });

  // GET /api/logs/summary
  app.get("/summary", (c) => {
    const { project_id, since } = c.req.query();
    const summary = summarizeLogs(
      db,
      resolveProjectId(db, project_id) || undefined,
      parseTime(since) || since || undefined,
    );
    return c.json(summary);
  });

  // GET /api/logs/count
  app.get("/count", (c) => {
    const { project_id, service, level, since, until } = c.req.query();
    return c.json(
      countLogs(db, {
        project_id: resolveProjectId(db, project_id) || undefined,
        service: service || undefined,
        level: level || undefined,
        since: since || undefined,
        until: until || undefined,
      }),
    );
  });

  // GET /api/logs/recent-errors
  app.get("/recent-errors", (c) => {
    const { project_id, since, limit } = c.req.query();
    const rows = searchLogs(db, {
      project_id: resolveProjectId(db, project_id) || undefined,
      level: ["error", "fatal"],
      since: parseTime(since || "1h"),
      limit: limit ? Number(limit) : 20,
    });
    return c.json(
      rows.map((r) => ({
        id: r.id,
        timestamp: r.timestamp,
        level: r.level,
        message: r.message,
        service: r.service,
        age_seconds: Math.floor(
          (Date.now() - new Date(r.timestamp).getTime()) / 1000,
        ),
      })),
    );
  });

  // GET /api/logs/:trace_id/context
  app.get("/:trace_id/context", (c) => {
    const rows = getLogContext(db, c.req.param("trace_id"));
    return c.json(rows);
  });

  // GET /api/logs/export?format=json|csv&project_id=&since=&level=
  app.get("/export", (c) => {
    const { project_id, since, until, level, service, format, limit } =
      c.req.query();
    const opts = {
      project_id: project_id || undefined,
      since: since || undefined,
      until: until || undefined,
      level: level || undefined,
      service: service || undefined,
      limit: limit ? Number(limit) : undefined,
    };

    if (format === "csv") {
      c.header("Content-Type", "text/csv");
      c.header("Content-Disposition", "attachment; filename=logs.csv");
      const chunks: string[] = [];
      exportToCsv(db, opts, (s) => chunks.push(s));
      return c.text(chunks.join(""));
    }

    c.header("Content-Type", "application/json");
    c.header("Content-Disposition", "attachment; filename=logs.json");
    const chunks: string[] = [];
    exportToJson(db, opts, (s) => chunks.push(s));
    return c.text(chunks.join("\n"));
  });

  return app;
}

async function validateStructuredIngestRequest(
  db: Database,
  c: Context,
): Promise<IngestValidation> {
  const authorization = authorizeLogIngest(db, c);
  if (!authorization || authorization.kind === "browser-token") {
    return {
      ok: false,
      status: 401,
      message: "Structured server log ingest requires a trusted API token",
    };
  }

  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return {
      ok: false,
      status: 415,
      message: "Content-Type must be application/json",
    };
  }

  const maxPayloadBytes = readPositiveInt(
    "HASNA_LOGS_MAX_PAYLOAD_BYTES",
    1_048_576,
  );
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxPayloadBytes) {
    return {
      ok: false,
      status: 413,
      message: `Payload exceeds ${maxPayloadBytes} bytes`,
    };
  }

  let raw = "";
  try {
    raw = await c.req.text();
  } catch {
    return { ok: false, status: 400, message: "Unable to read request body" };
  }

  if (Buffer.byteLength(raw, "utf8") > maxPayloadBytes) {
    return {
      ok: false,
      status: 413,
      message: `Payload exceeds ${maxPayloadBytes} bytes`,
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, message: "Invalid JSON body" };
  }

  const maxBatchSize = readPositiveInt("HASNA_LOGS_MAX_BATCH_SIZE", 1_000);
  const count = structuredPayloadCount(body);
  if (count > maxBatchSize) {
    return {
      ok: false,
      status: 413,
      message: `Batch exceeds ${maxBatchSize} entries`,
    };
  }

  let result: { entries: LogEntry[]; batch: boolean };
  try {
    result = structuredLogPayloadToEntries(
      body,
      structuredOptionsFromRequest(c),
    );
  } catch (error) {
    return {
      ok: false,
      status: 422,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  for (let index = 0; index < result.entries.length; index += 1) {
    const entry = result.entries[index];
    if (entry?.source === "browser" || entry?.source === "script") {
      return {
        ok: false,
        status: 422,
        message: `entry[${index}].source cannot be browser or script for structured server log ingest`,
      };
    }
  }

  try {
    validateStructuredLogReferences(db, result.entries);
  } catch (error) {
    return {
      ok: false,
      status: 422,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const maxMessageChars = readPositiveInt(
    "HASNA_LOGS_MAX_MESSAGE_CHARS",
    262_144,
  );
  for (let index = 0; index < result.entries.length; index += 1) {
    const entry = result.entries[index];
    if (entry && entry.message.length > maxMessageChars) {
      return {
        ok: false,
        status: 413,
        message: `entry[${index}].message is too large`,
      };
    }
  }

  return {
    ok: true,
    entries: result.entries,
    batch: result.batch,
    authorization,
  };
}

async function validateIngestRequest(
  db: Database,
  c: Context,
): Promise<IngestValidation> {
  const authorization = authorizeLogIngest(db, c);
  if (!authorization) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }

  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return {
      ok: false,
      status: 415,
      message: "Content-Type must be application/json",
    };
  }

  const maxPayloadBytes = readPositiveInt(
    "HASNA_LOGS_MAX_PAYLOAD_BYTES",
    1_048_576,
  );
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxPayloadBytes) {
    return {
      ok: false,
      status: 413,
      message: `Payload exceeds ${maxPayloadBytes} bytes`,
    };
  }

  let raw = "";
  try {
    raw = await c.req.text();
  } catch {
    return { ok: false, status: 400, message: "Unable to read request body" };
  }

  if (Buffer.byteLength(raw, "utf8") > maxPayloadBytes) {
    return {
      ok: false,
      status: 413,
      message: `Payload exceeds ${maxPayloadBytes} bytes`,
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, message: "Invalid JSON body" };
  }

  const maxBatchSize = readPositiveInt("HASNA_LOGS_MAX_BATCH_SIZE", 1_000);
  if (Array.isArray(body)) {
    if (body.length > maxBatchSize) {
      return {
        ok: false,
        status: 413,
        message: `Batch exceeds ${maxBatchSize} entries`,
      };
    }
    const entries: LogEntry[] = [];
    for (let index = 0; index < body.length; index += 1) {
      const result = validateLogEntry(body[index], `entry[${index}]`);
      if (!result.ok) return result;
      const authorized = applyLogIngestAuthorization(
        result.entry,
        authorization,
        `entry[${index}]`,
      );
      if (!authorized.ok) return authorized;
      entries.push(authorized.entry);
    }
    return { ok: true, entries, batch: true, authorization };
  }

  const result = validateLogEntry(body, "entry");
  if (!result.ok) return result;
  const authorized = applyLogIngestAuthorization(
    result.entry,
    authorization,
    "entry",
  );
  if (!authorized.ok) return authorized;
  return { ok: true, entries: [authorized.entry], batch: false, authorization };
}

function structuredOptionsFromRequest(c: Context): StructuredLogOptions {
  const query = c.req.query();
  const format = query.format as StructuredLogFormat | undefined;
  if (
    format !== undefined &&
    format !== "auto" &&
    format !== "pino" &&
    format !== "winston" &&
    format !== "json"
  ) {
    throw new Error("format must be auto, pino, winston, or json");
  }
  return {
    format,
    source: query.source as LogSource | undefined,
    service: query.service,
    project_id: query.project_id,
    page_id: query.page_id,
    machine_id: query.machine_id,
    repo_id: query.repo_id,
    app_id: query.app_id,
    process_id: query.process_id,
    run_id: query.run_id,
    trace_id: query.trace_id,
    span_id: query.span_id,
    parent_span_id: query.parent_span_id,
    session_id: query.session_id,
    release_id: query.release_id,
    environment: query.environment,
    agent: query.agent,
    url: query.url,
  };
}

function structuredPayloadCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as Record<string, unknown>).logs)
  ) {
    return ((value as Record<string, unknown>).logs as unknown[]).length;
  }
  return 1;
}

function applyLogIngestAuthorization(
  entry: LogEntry,
  authorization: LogIngestAuthorization,
  path: string,
): EntryValidation {
  if (authorization.kind !== "browser-token") return { ok: true, entry };
  if (
    entry.source !== undefined &&
    entry.source !== "script" &&
    entry.source !== "browser"
  ) {
    return {
      ok: false,
      status: 422,
      message: `${path}.source must be script or browser when using a browser ingest token`,
    };
  }
  return {
    ok: true,
    entry: {
      ...entry,
      project_id: authorization.token.project_id,
      source: entry.source ?? "browser",
    },
  };
}

function validateLogEntry(value: unknown, path: string): EntryValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, status: 422, message: `${path} must be an object` };
  }

  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!LOG_ENTRY_KEYS.has(key)) {
      return {
        ok: false,
        status: 422,
        message: `${path}.${key} is not a supported log field`,
      };
    }
  }

  if (!LOG_LEVELS.has(input.level as LogLevel)) {
    return {
      ok: false,
      status: 422,
      message: `${path}.level must be one of debug, info, warn, error, fatal`,
    };
  }
  if (typeof input.message !== "string" || input.message.length === 0) {
    return {
      ok: false,
      status: 422,
      message: `${path}.message must be a non-empty string`,
    };
  }
  if (
    input.message.length >
    readPositiveInt("HASNA_LOGS_MAX_MESSAGE_CHARS", 262_144)
  ) {
    return { ok: false, status: 413, message: `${path}.message is too large` };
  }
  if (
    input.source !== undefined &&
    !LOG_SOURCES.has(input.source as LogSource)
  ) {
    return {
      ok: false,
      status: 422,
      message: `${path}.source is not supported`,
    };
  }
  if (
    input.privacy !== undefined &&
    !PRIVACY_CLASSES.has(input.privacy as PrivacyClass)
  ) {
    return {
      ok: false,
      status: 422,
      message: `${path}.privacy is not supported`,
    };
  }
  if (
    input.metadata !== undefined &&
    (!input.metadata ||
      typeof input.metadata !== "object" ||
      Array.isArray(input.metadata))
  ) {
    return {
      ok: false,
      status: 422,
      message: `${path}.metadata must be an object`,
    };
  }

  const entry: LogEntry = {
    level: input.level as LogLevel,
    message: input.message,
  };
  const entryRecord = entry as unknown as Record<string, unknown>;

  const optionalStringKeys = [
    "id",
    "timestamp",
    "source_event_id",
    "project_id",
    "page_id",
    "source",
    "service",
    "privacy",
    "machine_id",
    "repo_id",
    "app_id",
    "process_id",
    "run_id",
    "trace_id",
    "span_id",
    "parent_span_id",
    "session_id",
    "release_id",
    "environment",
    "agent",
    "url",
    "stack_trace",
  ];
  for (const key of optionalStringKeys) {
    const copied = copyOptionalString(input, entryRecord, key, path);
    if (!copied.ok) return copied;
  }
  if (input.metadata !== undefined)
    entry.metadata = input.metadata as Record<string, unknown>;

  return { ok: true, entry };
}

function copyOptionalString(
  input: Record<string, unknown>,
  entry: Record<string, unknown>,
  key: string,
  path: string,
): { ok: true } | { ok: false; status: 422; message: string } {
  const value = input[key];
  if (value === undefined) return { ok: true };
  if (typeof value !== "string") {
    return {
      ok: false,
      status: 422,
      message: `${path}.${key} must be a string`,
    };
  }
  entry[key] = value;
  return { ok: true };
}

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
