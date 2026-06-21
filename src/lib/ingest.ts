import type { Database as DbAdapter } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { LogEntry, LogRow } from "../types/index.ts";
import { evaluateAlerts } from "./alerts.ts";
import { publishEventCatalogEvent, publishLogEvent } from "./event-bus.ts";
import {
  type TelemetryEnvelope,
  appendRawEvent,
  indexRawEvent,
  withEventStoreLock,
} from "./event-store.ts";
import { getEvent } from "./events.ts";
import { upsertIssue } from "./issues.ts";
import {
  mergeRedactionReports,
  redactLogEntry,
  redactString,
  redactionMetadata,
} from "./redaction.ts";

const ERROR_LEVELS = new Set(["warn", "error", "fatal"]);

export function ingestLog(db: DbAdapter, entry: LogEntry): LogRow {
  return withEventStoreLock(db, () => ingestLogLocked(db, entry));
}

function ingestLogLocked(db: DbAdapter, entry: LogEntry): LogRow {
  const eventIdRedaction =
    typeof entry.id === "string" ? redactString(entry.id, "id") : null;
  const eventId = entry.id
    ? eventIdRedaction?.report.applied
      ? createRedactedEventId(entry.id)
      : entry.id
    : createEventId();
  const existing = db.prepare("SELECT * FROM logs WHERE id = ?").get(eventId) as
    | LogRow
    | undefined;
  if (existing) return existing;
  const eventTime = entry.timestamp ?? new Date().toISOString();
  const ingestTime = new Date().toISOString();
  const source = entry.source ?? "sdk";
  const sourceEventId = entry.source_event_id ?? entry.id ?? null;
  const normalized: LogEntry = {
    ...entry,
    id: eventId,
    timestamp: eventTime,
    source,
    source_event_id: sourceEventId ?? undefined,
    privacy: entry.privacy ?? "internal",
  };
  const redacted = redactLogEntry(normalized);
  const safeEntry = redacted.value;
  if (eventIdRedaction?.report.applied) {
    const report = mergeRedactionReports(
      eventIdRedaction.report,
      redacted.report,
    );
    safeEntry.metadata = {
      ...(safeEntry.metadata ?? {}),
      redaction: redactionMetadata(report),
    };
  }
  const safeSourceEventId = safeEntry.source_event_id ?? null;
  const identity = extractIdentity(safeEntry);
  const envelope = createLogEnvelope(
    safeEntry,
    eventId,
    eventTime,
    ingestTime,
    identity,
  );
  const write = appendRawEvent(db, envelope);

  const stmt = db.prepare(`
    INSERT INTO logs (id, timestamp, project_id, page_id, level, source, service, message, trace_id, session_id, agent, url, stack_trace, metadata)
    VALUES ($id, $timestamp, $project_id, $page_id, $level, $source, $service, $message, $trace_id, $session_id, $agent, $url, $stack_trace, $metadata)
    RETURNING *
  `);
  const row = db.transaction(() => {
    const inserted = stmt.get({
      $id: eventId,
      $timestamp: eventTime,
      $project_id: safeEntry.project_id ?? null,
      $page_id: safeEntry.page_id ?? null,
      $level: safeEntry.level,
      $source: source,
      $service: safeEntry.service ?? null,
      $message: safeEntry.message,
      $trace_id: safeEntry.trace_id ?? null,
      $session_id: safeEntry.session_id ?? null,
      $agent: safeEntry.agent ?? null,
      $url: safeEntry.url ?? null,
      $stack_trace: safeEntry.stack_trace ?? null,
      $metadata: safeEntry.metadata ? JSON.stringify(safeEntry.metadata) : null,
    }) as LogRow;

    indexRawEvent(
      db,
      {
        event_id: eventId,
        schema_version: envelope.schema_version,
        source_event_id: safeSourceEventId,
        event_type: envelope.type,
        event_time: eventTime,
        ingest_time: ingestTime,
        severity: safeEntry.level,
        source,
        project_id: safeEntry.project_id ?? null,
        page_id: safeEntry.page_id ?? null,
        log_id: inserted.id,
        machine_id: identity.machine_id,
        repo_id: identity.repo_id,
        app_id: identity.app_id,
        process_id: identity.process_id,
        run_id: identity.run_id,
        trace_id: safeEntry.trace_id ?? null,
        span_id: identity.span_id,
        parent_span_id: identity.parent_span_id,
        session_id: safeEntry.session_id ?? null,
        release_id: identity.release_id,
        environment: identity.environment,
        artifact_id: identity.artifact_id,
        privacy_tier: identity.privacy_tier,
        message: safeEntry.message,
        metadata: safeEntry.metadata ?? null,
      },
      write,
    );

    return inserted;
  })();

  // Side effects: issue grouping + alert evaluation (fire-and-forget)
  if (ERROR_LEVELS.has(safeEntry.level)) {
    if (safeEntry.project_id) {
      upsertIssue(db, {
        project_id: safeEntry.project_id,
        level: safeEntry.level,
        service: safeEntry.service,
        message: safeEntry.message,
        stack_trace: safeEntry.stack_trace,
      });
      evaluateAlerts(
        db,
        safeEntry.project_id,
        safeEntry.service ?? null,
        safeEntry.level,
      ).catch(() => {});
    }
  }

  publishLogEvent(row);
  const catalogEvent = getEvent(db, eventId, false);
  if (catalogEvent) publishEventCatalogEvent(catalogEvent);

  return row;
}

export function ingestBatch(
  db: DbAdapter,
  entries: LogEntry[],
  sharedTraceId?: string | null,
): LogRow[] {
  // Apply shared trace_id to entries that don't have their own
  const mappedEntries = sharedTraceId
    ? entries.map((e) => (e.trace_id ? e : { ...e, trace_id: sharedTraceId }))
    : entries;
  return mappedEntries.map((entry) => ingestLog(db, entry));
}

interface ExtractedIdentity {
  machine_id: string | null;
  repo_id: string | null;
  app_id: string | null;
  process_id: string | null;
  run_id: string | null;
  span_id: string | null;
  parent_span_id: string | null;
  release_id: string | null;
  environment: string | null;
  artifact_id: string | null;
  privacy_tier: string | null;
}

function createLogEnvelope(
  entry: LogEntry,
  eventId: string,
  eventTime: string,
  ingestTime: string,
  identity: ExtractedIdentity,
): TelemetryEnvelope {
  return {
    schema_version: 1,
    event_id: eventId,
    source_event_id: entry.source_event_id ?? null,
    event_time: eventTime,
    ingest_time: ingestTime,
    type: "log",
    source: entry.source ?? "sdk",
    severity: entry.level,
    privacy: identity.privacy_tier,
    machine_id: identity.machine_id,
    repo_id: identity.repo_id,
    app_id: identity.app_id,
    process_id: identity.process_id,
    run_id: identity.run_id,
    trace_id: entry.trace_id ?? null,
    span_id: identity.span_id,
    parent_span_id: identity.parent_span_id,
    session_id: entry.session_id ?? null,
    release_id: identity.release_id,
    environment: identity.environment,
    message: entry.message,
    body: {
      log: {
        id: eventId,
        timestamp: eventTime,
        source_event_id: entry.source_event_id ?? null,
        project_id: entry.project_id ?? null,
        page_id: entry.page_id ?? null,
        level: entry.level,
        source: entry.source ?? "sdk",
        service: entry.service ?? null,
        message: entry.message,
        privacy: identity.privacy_tier,
        machine_id: identity.machine_id,
        repo_id: identity.repo_id,
        app_id: identity.app_id,
        process_id: identity.process_id,
        run_id: identity.run_id,
        trace_id: entry.trace_id ?? null,
        span_id: identity.span_id,
        parent_span_id: identity.parent_span_id,
        session_id: entry.session_id ?? null,
        release_id: identity.release_id,
        environment: identity.environment,
        agent: entry.agent ?? null,
        url: entry.url ?? null,
        stack_trace: entry.stack_trace ?? null,
        metadata: entry.metadata ?? null,
      },
    },
    attributes: {
      project_id: entry.project_id ?? null,
      page_id: entry.page_id ?? null,
      service: entry.service ?? null,
      trace_id: entry.trace_id ?? null,
      session_id: entry.session_id ?? null,
      agent: entry.agent ?? null,
      url: entry.url ?? null,
      ...identity,
    },
  };
}

function extractIdentity(entry: LogEntry): ExtractedIdentity {
  const metadata = entry.metadata;
  return {
    machine_id: entry.machine_id ?? stringMetadata(metadata, "machine_id"),
    repo_id: entry.repo_id ?? stringMetadata(metadata, "repo_id"),
    app_id: entry.app_id ?? stringMetadata(metadata, "app_id"),
    process_id: entry.process_id ?? stringMetadata(metadata, "process_id"),
    run_id: entry.run_id ?? stringMetadata(metadata, "run_id"),
    span_id: entry.span_id ?? stringMetadata(metadata, "span_id"),
    parent_span_id:
      entry.parent_span_id ?? stringMetadata(metadata, "parent_span_id"),
    release_id: entry.release_id ?? stringMetadata(metadata, "release_id"),
    environment: entry.environment ?? stringMetadata(metadata, "environment"),
    artifact_id: stringMetadata(metadata, "artifact_id"),
    privacy_tier:
      entry.privacy ??
      stringMetadata(metadata, "privacy_tier") ??
      stringMetadata(metadata, "privacy") ??
      "internal",
  };
}

function stringMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = metadata?.[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint")
    return String(value);
  return null;
}

function createEventId(): string {
  return randomBytes(16).toString("hex");
}

function createRedactedEventId(value: string): string {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `log_redacted_${digest}`;
}
