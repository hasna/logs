import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { LogEntry, LogRow, LogSource } from "../types/index.ts";
import { ingestLog } from "./ingest.ts";
import { redactString, redactValue } from "./redaction.ts";

export type StructuredLogFormat = "auto" | "pino" | "winston" | "json";

export interface StructuredLogOptions {
  format?: StructuredLogFormat;
  source?: LogSource;
  service?: string;
  project_id?: string;
  page_id?: string;
  machine_id?: string;
  repo_id?: string;
  app_id?: string;
  process_id?: string;
  run_id?: string;
  trace_id?: string;
  span_id?: string;
  parent_span_id?: string;
  session_id?: string;
  release_id?: string;
  environment?: string;
  privacy?: LogEntry["privacy"];
  agent?: string;
  url?: string;
  metadata?: Record<string, unknown>;
  source_event_prefix?: string;
}

export interface StructuredLogPosition {
  index?: number;
  line?: number;
  source?: string;
  byte_offset?: number;
}

export interface StructuredLogPayloadResult {
  entries: LogEntry[];
  batch: boolean;
}

const STRUCTURED_LOG_SOURCES = new Set<LogSource>([
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

const PINO_LEVELS = new Map<number, LogEntry["level"]>([
  [10, "debug"],
  [20, "debug"],
  [30, "info"],
  [40, "warn"],
  [50, "error"],
  [60, "fatal"],
]);

const WINSTON_NUMERIC_LEVELS = new Map<number, LogEntry["level"]>([
  [0, "error"],
  [1, "warn"],
  [2, "info"],
  [3, "info"],
  [4, "debug"],
  [5, "debug"],
  [6, "debug"],
]);

const STRING_LEVELS = new Map<string, LogEntry["level"]>([
  ["trace", "debug"],
  ["debug", "debug"],
  ["silly", "debug"],
  ["verbose", "debug"],
  ["http", "info"],
  ["info", "info"],
  ["notice", "info"],
  ["warn", "warn"],
  ["warning", "warn"],
  ["error", "error"],
  ["err", "error"],
  ["fatal", "fatal"],
  ["crit", "fatal"],
  ["critical", "fatal"],
  ["panic", "fatal"],
]);

export function ingestStructuredLogBatch(
  db: Database,
  payload: unknown,
  options: StructuredLogOptions = {},
): LogRow[] {
  const { entries } = structuredLogPayloadToEntries(payload, options);
  validateStructuredLogReferences(db, entries);
  return entries.map((entry) => ingestLog(db, entry));
}

export function validateStructuredLogReferences(
  db: Database,
  entries: LogEntry[],
): void {
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.project_id && !projectExists(db, entry.project_id)) {
      throw new Error(`entry[${index}].project_id does not exist`);
    }
    if (entry.page_id) {
      const page = pageProject(db, entry.page_id);
      if (!page) throw new Error(`entry[${index}].page_id does not exist`);
      if (entry.project_id && page.project_id !== entry.project_id) {
        throw new Error(
          `entry[${index}].page_id does not belong to entry[${index}].project_id`,
        );
      }
    }
  }
}

export function structuredLogPayloadToEntries(
  payload: unknown,
  options: StructuredLogOptions = {},
): StructuredLogPayloadResult {
  if (Array.isArray(payload)) {
    return {
      entries: payload.map((record, index) =>
        structuredLogToEntry(record, options, { index }),
      ),
      batch: true,
    };
  }

  if (isRecord(payload) && Array.isArray(payload.logs)) {
    const envelope = payload;
    const logs = envelope.logs as unknown[];
    const envelopeOptions = optionsFromEnvelope(envelope, options);
    return {
      entries: logs.map((record, index) =>
        structuredLogToEntry(record, envelopeOptions, { index }),
      ),
      batch: true,
    };
  }

  return {
    entries: [structuredLogToEntry(payload, options)],
    batch: false,
  };
}

export function parseStructuredJsonLines(
  input: string,
  options: StructuredLogOptions = {},
  source = "jsonl",
): LogEntry[] {
  const entries: LogEntry[] = [];
  const lines = input.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(
        `line ${index + 1}: invalid JSON (${errorMessage(error)})`,
      );
    }
    entries.push(
      structuredLogToEntry(parsed, options, {
        index: entries.length,
        line: index + 1,
        source,
      }),
    );
  }
  return entries;
}

export function ingestStructuredJsonLines(
  db: Database,
  input: string,
  options: StructuredLogOptions = {},
  source = "jsonl",
): LogRow[] {
  const entries = parseStructuredJsonLines(input, options, source);
  validateStructuredLogReferences(db, entries);
  return entries.map((entry) => ingestLog(db, entry));
}

export function structuredLogToEntry(
  value: unknown,
  options: StructuredLogOptions = {},
  position: StructuredLogPosition = {},
): LogEntry {
  if (!isRecord(value)) {
    throw new Error("structured log record must be an object");
  }

  const format = detectFormat(value, normalizeFormat(options.format ?? "auto"));
  const message = messageFromRecord(value);
  const level = levelFromRecord(value, format);
  const eventTime = timestampFromRecord(value);
  const producerEventId = producerId(value);
  const idRecord = redactedRecordForId(value);
  const sourceEventId = structuredSourceEventId(
    idRecord,
    format,
    producerEventId,
    position,
    options.source_event_prefix,
  );
  const source = options.source ?? defaultSource(format);
  assertSupportedSource(source);
  const service = firstString([
    options.service,
    stringValue(value.service),
    stringPath(value, ["service", "name"]),
    stringValue(value.name),
    stringValue(value.logger),
    stringPath(value, ["logger", "name"]),
  ]);
  const traceId = firstString([
    options.trace_id,
    stringValue(value.trace_id),
    stringValue(value.traceId),
    stringPath(value, ["trace", "id"]),
    stringPath(value, ["otel", "trace_id"]),
    stringValue(value["dd.trace_id"]),
  ]);
  const spanId = firstString([
    options.span_id,
    stringValue(value.span_id),
    stringValue(value.spanId),
    stringPath(value, ["span", "id"]),
    stringPath(value, ["otel", "span_id"]),
    stringValue(value["dd.span_id"]),
  ]);
  const metadata = compactObject({
    ...(options.metadata ?? {}),
    structured_log: compactObject({
      format,
      source,
      producer_event_id: redactedProducerId(producerEventId),
      position: compactObject({ ...position }),
      level_raw: value.level ?? value.severity ?? value.severityText,
      time_raw:
        value.time ??
        value.timestamp ??
        value["@timestamp"] ??
        value.datetime ??
        value.date,
      logger: firstString([
        stringValue(value.name),
        stringValue(value.logger),
        stringPath(value, ["logger", "name"]),
      ]),
      pid:
        numberOrString(value.pid) ??
        numberOrString(isRecord(value.process) ? value.process.pid : undefined),
      hostname:
        stringValue(value.hostname) ?? stringPath(value, ["host", "name"]),
      original: value,
    }),
  });

  return compactObject({
    id: sourceEventId
      ? `log_struct_${stableHash(sourceEventId).slice(0, 32)}`
      : undefined,
    timestamp: eventTime,
    source_event_id: sourceEventId,
    project_id: options.project_id ?? stringValue(value.project_id),
    page_id: options.page_id ?? stringValue(value.page_id),
    level,
    source,
    service,
    message,
    privacy: options.privacy,
    machine_id:
      options.machine_id ??
      stringValue(value.machine_id) ??
      stringPath(value, ["host", "id"]) ??
      stringValue(value.hostname) ??
      stringPath(value, ["host", "name"]),
    repo_id: options.repo_id ?? stringValue(value.repo_id),
    app_id:
      options.app_id ??
      stringValue(value.app_id) ??
      stringPath(value, ["service", "name"]) ??
      service,
    process_id: options.process_id ?? stringValue(value.process_id),
    run_id: options.run_id ?? stringValue(value.run_id),
    trace_id: traceId,
    span_id: spanId,
    parent_span_id:
      options.parent_span_id ??
      stringValue(value.parent_span_id) ??
      stringValue(value.parentSpanId),
    session_id:
      options.session_id ??
      stringValue(value.session_id) ??
      stringValue(value.sessionId),
    release_id:
      options.release_id ??
      stringValue(value.release_id) ??
      stringValue(value.release) ??
      stringValue(value.version),
    environment:
      options.environment ??
      stringValue(value.environment) ??
      stringValue(value.env) ??
      stringPath(value, ["deployment", "environment"]),
    agent: options.agent ?? stringValue(value.agent),
    url:
      options.url ??
      stringValue(value.url) ??
      stringPath(value, ["request", "url"]) ??
      stringPath(value, ["req", "url"]),
    stack_trace:
      stringValue(value.stack) ??
      stringPath(value, ["err", "stack"]) ??
      stringPath(value, ["error", "stack"]) ??
      stringPath(value, ["exception", "stacktrace"]),
    metadata,
  }) as LogEntry;
}

function optionsFromEnvelope(
  envelope: Record<string, unknown>,
  defaults: StructuredLogOptions,
): StructuredLogOptions {
  return compactObject({
    ...defaults,
    format: formatValue(envelope.format) ?? defaults.format,
    source: sourceValue(envelope.source) ?? defaults.source,
    service: stringValue(envelope.service) ?? defaults.service,
    project_id: stringValue(envelope.project_id) ?? defaults.project_id,
    page_id: stringValue(envelope.page_id) ?? defaults.page_id,
    machine_id: stringValue(envelope.machine_id) ?? defaults.machine_id,
    repo_id: stringValue(envelope.repo_id) ?? defaults.repo_id,
    app_id: stringValue(envelope.app_id) ?? defaults.app_id,
    process_id: stringValue(envelope.process_id) ?? defaults.process_id,
    run_id: stringValue(envelope.run_id) ?? defaults.run_id,
    trace_id: stringValue(envelope.trace_id) ?? defaults.trace_id,
    span_id: stringValue(envelope.span_id) ?? defaults.span_id,
    parent_span_id:
      stringValue(envelope.parent_span_id) ?? defaults.parent_span_id,
    session_id: stringValue(envelope.session_id) ?? defaults.session_id,
    release_id: stringValue(envelope.release_id) ?? defaults.release_id,
    environment: stringValue(envelope.environment) ?? defaults.environment,
    agent: stringValue(envelope.agent) ?? defaults.agent,
    url: stringValue(envelope.url) ?? defaults.url,
    source_event_prefix:
      stringValue(envelope.source_event_prefix) ?? defaults.source_event_prefix,
    metadata: metadataValue(envelope.metadata) ?? defaults.metadata,
  });
}

function detectFormat(
  value: Record<string, unknown>,
  requested: StructuredLogFormat,
): Exclude<StructuredLogFormat, "auto"> {
  if (requested !== "auto") return requested;
  if (typeof value.level === "number" || "msg" in value) return "pino";
  if (typeof value.level === "string" && "message" in value) return "winston";
  return "json";
}

function normalizeFormat(value: unknown): StructuredLogFormat {
  if (
    value === "auto" ||
    value === "pino" ||
    value === "winston" ||
    value === "json"
  ) {
    return value;
  }
  throw new Error("format must be auto, pino, winston, or json");
}

function defaultSource(
  format: Exclude<StructuredLogFormat, "auto">,
): LogSource {
  if (format === "pino") return "pino";
  if (format === "winston") return "winston";
  return "structured";
}

function levelFromRecord(
  value: Record<string, unknown>,
  format: Exclude<StructuredLogFormat, "auto">,
): LogEntry["level"] {
  const raw = value.level ?? value.severity ?? value.severityText;
  if (raw === undefined || raw === null || raw === "") return "info";
  if (typeof raw === "number") {
    const mapped =
      format === "winston"
        ? WINSTON_NUMERIC_LEVELS.get(raw)
        : (PINO_LEVELS.get(raw) ?? WINSTON_NUMERIC_LEVELS.get(raw));
    if (mapped) return mapped;
    throw new Error(`unsupported numeric log level: ${raw}`);
  }
  if (typeof raw === "string") {
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && raw.trim() !== "") {
      return levelFromRecord({ level: numeric }, format);
    }
    const mapped = STRING_LEVELS.get(raw.toLowerCase());
    if (mapped) return mapped;
  }
  throw new Error(`unsupported log level: ${String(raw)}`);
}

function messageFromRecord(value: Record<string, unknown>): string {
  const raw =
    value.msg ??
    value.message ??
    value.body ??
    stringPath(value, ["err", "message"]) ??
    stringPath(value, ["error", "message"]);
  const message = messageValue(raw);
  if (!message)
    throw new Error("structured log record must include msg or message");
  return message;
}

function messageValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? value : null;
  }
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (value && typeof value === "object") {
    return stableStringify(value);
  }
  return null;
}

function timestampFromRecord(
  value: Record<string, unknown>,
): string | undefined {
  const raw =
    value.time ??
    value.timestamp ??
    value["@timestamp"] ??
    value.datetime ??
    value.date;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const timestamp = timestampValue(raw);
  if (!timestamp) throw new Error(`unsupported timestamp: ${String(raw)}`);
  return timestamp;
}

function timestampValue(value: unknown): string | null {
  if (typeof value === "number") return epochNumberToIso(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) return epochNumberToIso(numeric);
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

function epochNumberToIso(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  let milliseconds = value;
  if (value > 10_000_000_000_000_000) {
    milliseconds = value / 1_000_000;
  } else if (value > 10_000_000_000_000) {
    milliseconds = value / 1_000;
  } else if (value < 10_000_000_000) {
    milliseconds = value * 1_000;
  }
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function producerId(value: Record<string, unknown>): string | null {
  return (
    firstString([
      stringValue(value.id),
      stringValue(value.event_id),
      stringValue(value.eventId),
      stringValue(value.source_event_id),
      stringValue(value.log_id),
      stringValue(value.logId),
      stringValue(value._open_logs_event_id),
    ]) ?? null
  );
}

function structuredSourceEventId(
  value: Record<string, unknown>,
  format: Exclude<StructuredLogFormat, "auto">,
  producerEventId: string | null,
  position: StructuredLogPosition,
  prefix = "structured",
): string | undefined {
  if (producerEventId) {
    const redacted = redactString(producerEventId, "source_event_id");
    if (!redacted.report.applied) {
      return `${prefix}:${format}:producer:${stableHash(redacted.value)}`;
    }
  }
  if (!hasPosition(position)) return undefined;
  return `${prefix}:${format}:${stableHash({
    position,
    timestamp:
      value.time ??
      value.timestamp ??
      value["@timestamp"] ??
      value.datetime ??
      value.date,
    level: value.level ?? value.severity ?? value.severityText,
    message: value.msg ?? value.message ?? value.body,
    service: value.service ?? value.name ?? value.logger,
    original: value,
  })}`;
}

function redactedProducerId(value: string | null): string | undefined {
  return value
    ? redactString(value, "metadata.structured_log.producer_event_id").value
    : undefined;
}

function redactedRecordForId(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return redactValue(value, "structured_log_id").value as Record<
    string,
    unknown
  >;
}

function hasPosition(position: StructuredLogPosition): boolean {
  return (
    position.index !== undefined ||
    position.line !== undefined ||
    position.source !== undefined
  );
}

function assertSupportedSource(source: LogSource): void {
  if (!STRUCTURED_LOG_SOURCES.has(source)) {
    throw new Error(`unsupported structured log source: ${source}`);
  }
}

function formatValue(value: unknown): StructuredLogFormat | undefined {
  if (value === undefined) return undefined;
  return normalizeFormat(value);
}

function sourceValue(value: unknown): LogSource | undefined {
  if (value === undefined) return undefined;
  const source = stringValue(value) as LogSource | null;
  if (!source) throw new Error("source must be a string");
  assertSupportedSource(source);
  return source;
}

function metadataValue(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("metadata must be an object");
  return value;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" || typeof value === "bigint")
    return String(value);
  return undefined;
}

function numberOrString(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) return value;
  return undefined;
}

function stringPath(
  value: Record<string, unknown>,
  path: string[],
): string | undefined {
  let current: unknown = value;
  for (const part of path) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return stringValue(current);
}

function firstString(
  values: Array<string | undefined | null>,
): string | undefined {
  return values.find(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function projectExists(db: Database, projectId: string): boolean {
  const row = db
    .prepare("SELECT id FROM projects WHERE id = ?")
    .get(projectId) as { id: string } | null;
  return Boolean(row);
}

function pageProject(
  db: Database,
  pageId: string,
): { project_id: string } | null {
  return db
    .prepare("SELECT project_id FROM pages WHERE id = ?")
    .get(pageId) as { project_id: string } | null;
}
