import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { publishEventCatalogEvent } from "./event-bus.ts";
import {
  type EventIndexInput,
  type TelemetryEnvelope,
  appendRawEvent,
  getEventRecord,
  indexRawEvent,
  readRawEvent,
  withEventStoreLock,
} from "./event-store.ts";
import { type EventCatalogEntry, getEvent } from "./events.ts";
import { upsertIssue } from "./issues.ts";
import {
  mergeRedactionReports,
  redactString,
  redactValue,
  redactionMetadata,
} from "./redaction.ts";
import {
  sanitizeSourceMapArtifactRecord,
  sanitizeSourceMapContextRecord,
  sanitizeSourceMapIdentifierValue,
  sanitizeSourceMapTelemetry,
  sourceMapFallbackIdentifier,
  upsertSourceMapProjection,
} from "./source-map-projections.ts";
import {
  sanitizedTestReportMetadata,
  upsertTestReportProjection,
} from "./test-report-projections.ts";

type SqlBinding = string | number | bigint | boolean | null | Uint8Array;

export type UniversalEventType =
  | "log"
  | "exception"
  | "span"
  | "metric"
  | "profile"
  | "replay"
  | "monitor"
  | "release"
  | "build"
  | "process"
  | "agent"
  | "artifact"
  | "network"
  | "filesystem"
  | "session";

export interface UniversalEventInput {
  schema_version?: number;
  event_id?: string;
  id?: string;
  source_event_id?: string | null;
  event_time?: string;
  timestamp?: string;
  type: UniversalEventType;
  source?: string;
  severity?: string | null;
  level?: string | null;
  privacy?: string | null;
  project_id?: string | null;
  page_id?: string | null;
  machine_id?: string | null;
  repo_id?: string | null;
  app_id?: string | null;
  process_id?: string | null;
  run_id?: string | null;
  trace_id?: string | null;
  span_id?: string | null;
  parent_span_id?: string | null;
  session_id?: string | null;
  release_id?: string | null;
  environment?: string | null;
  artifact_id?: string | null;
  message?: string | null;
  body?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface UniversalEventIngestResult {
  inserted: boolean;
  event: EventCatalogEntry;
}

export const UNIVERSAL_EVENT_TYPES: UniversalEventType[] = [
  "log",
  "exception",
  "span",
  "metric",
  "profile",
  "replay",
  "monitor",
  "release",
  "build",
  "process",
  "agent",
  "artifact",
  "network",
  "filesystem",
  "session",
];

const SEVERITIES = new Set(["debug", "info", "warn", "error", "fatal"]);
const PRIVACY_TIERS = new Set([
  "public",
  "internal",
  "sensitive",
  "secret",
  "pii",
]);
const REDACTABLE_TOP_LEVEL_FIELDS = [
  "source_event_id",
  "source",
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
] as const;
const UNIVERSAL_EVENT_KEYS = new Set([
  "schema_version",
  "event_id",
  "id",
  "source_event_id",
  "event_time",
  "timestamp",
  "type",
  "source",
  "severity",
  "level",
  "privacy",
  "project_id",
  "page_id",
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
  "artifact_id",
  "message",
  "body",
  "attributes",
  "metadata",
]);

export function validateUniversalEventInput(
  value: unknown,
  path = "event",
): UniversalEventInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }

  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!UNIVERSAL_EVENT_KEYS.has(key)) {
      throw new Error(`${path}.${key} is not a supported event field`);
    }
  }

  if (
    typeof input.type !== "string" ||
    !UNIVERSAL_EVENT_TYPES.includes(input.type as UniversalEventType)
  ) {
    throw new Error(
      `${path}.type must be one of ${UNIVERSAL_EVENT_TYPES.join(", ")}`,
    );
  }
  if (
    input.schema_version !== undefined &&
    (!Number.isInteger(input.schema_version) ||
      Number(input.schema_version) < 1)
  ) {
    throw new Error(`${path}.schema_version must be a positive integer`);
  }
  const severity = input.severity ?? input.level;
  if (
    severity !== undefined &&
    severity !== null &&
    !SEVERITIES.has(String(severity))
  ) {
    throw new Error(
      `${path}.severity must be one of debug, info, warn, error, fatal`,
    );
  }
  if (
    input.privacy !== undefined &&
    input.privacy !== null &&
    !PRIVACY_TIERS.has(String(input.privacy))
  ) {
    throw new Error(
      `${path}.privacy must be one of public, internal, sensitive, secret, pii`,
    );
  }
  for (const key of ["event_time", "timestamp"]) {
    const item = input[key];
    if (
      typeof item === "string" &&
      item.length > 0 &&
      Number.isNaN(new Date(item).getTime())
    ) {
      throw new Error(`${path}.${key} must be an ISO timestamp`);
    }
  }
  for (const key of [
    "event_id",
    "id",
    "source_event_id",
    "event_time",
    "timestamp",
    "source",
    "severity",
    "level",
    "privacy",
    "project_id",
    "page_id",
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
    "artifact_id",
    "message",
  ]) {
    const item = input[key];
    if (item !== undefined && item !== null && typeof item !== "string") {
      throw new Error(`${path}.${key} must be a string`);
    }
  }
  for (const key of ["body", "attributes", "metadata"]) {
    const item = input[key];
    if (
      item !== undefined &&
      (!item || typeof item !== "object" || Array.isArray(item))
    ) {
      throw new Error(`${path}.${key} must be an object`);
    }
  }

  return input as unknown as UniversalEventInput;
}

export function ingestUniversalEvent(
  db: Database,
  input: UniversalEventInput,
): UniversalEventIngestResult {
  const envelope = normalizeUniversalEvent(validateUniversalEventInput(input));
  return withEventStoreLock(db, () => {
    const existing = getEventRecord(db, envelope.event_id);
    if (existing) {
      const event = getEvent(db, existing.event_id, false);
      if (!event)
        throw new Error(
          `Event index exists but cannot be read: ${existing.event_id}`,
        );
      return { inserted: false, event };
    }

    const redacted = redactEnvelope(envelope);
    const safeEnvelope = redacted.envelope;
    const write = appendRawEvent(db, safeEnvelope);
    db.transaction(() => {
      const index = indexFromEnvelope(db, safeEnvelope, redacted.metadata);
      indexRawEvent(db, index, write);
      applyCompatibilityProjections(db, safeEnvelope, index);
    })();

    const event = getEvent(db, safeEnvelope.event_id, false);
    if (!event)
      throw new Error(
        `Event was written but cannot be read: ${safeEnvelope.event_id}`,
      );
    publishEventCatalogEvent(event);
    return { inserted: true, event };
  });
}

export function normalizeUniversalEvent(
  input: UniversalEventInput,
): TelemetryEnvelope {
  const now = new Date().toISOString();
  const source = sanitizeOptionalString(input.source) ?? "sdk";
  const sourceEventId = sanitizeOptionalString(input.source_event_id);
  const eventId =
    sanitizeOptionalString(input.event_id ?? input.id) ??
    deterministicSourceEventId(source, sourceEventId) ??
    `evt_${randomBytes(16).toString("hex")}`;
  const eventTime = normalizeIsoTime(
    input.event_time ?? input.timestamp,
    "event_time",
  );
  const severity = sanitizeOptionalString(input.severity ?? input.level);
  const privacy = sanitizeOptionalString(input.privacy) ?? "internal";
  if (!UNIVERSAL_EVENT_TYPES.includes(input.type)) {
    throw new Error(`type must be one of ${UNIVERSAL_EVENT_TYPES.join(", ")}`);
  }
  if (severity && !SEVERITIES.has(severity)) {
    throw new Error("severity must be one of debug, info, warn, error, fatal");
  }
  if (!PRIVACY_TIERS.has(privacy)) {
    throw new Error(
      "privacy must be one of public, internal, sensitive, secret, pii",
    );
  }

  const attributes = compactObject({
    ...(input.metadata ?? {}),
    ...(input.attributes ?? {}),
    project_id:
      input.project_id ??
      input.attributes?.project_id ??
      input.metadata?.project_id,
    page_id:
      input.page_id ?? input.attributes?.page_id ?? input.metadata?.page_id,
    artifact_id:
      input.artifact_id ??
      input.attributes?.artifact_id ??
      input.metadata?.artifact_id,
  });

  return {
    schema_version: input.schema_version ?? 1,
    event_id: eventId,
    source_event_id: sourceEventId ?? null,
    event_time: eventTime ?? now,
    ingest_time: now,
    type: input.type,
    source,
    severity: severity ?? null,
    privacy,
    machine_id: sanitizeNullableString(input.machine_id),
    repo_id: sanitizeNullableString(input.repo_id),
    app_id: sanitizeNullableString(input.app_id),
    process_id: sanitizeNullableString(input.process_id),
    run_id: sanitizeNullableString(input.run_id),
    trace_id: sanitizeNullableString(input.trace_id),
    span_id: sanitizeNullableString(input.span_id),
    parent_span_id: sanitizeNullableString(input.parent_span_id),
    session_id: sanitizeNullableString(input.session_id),
    release_id: sanitizeNullableString(input.release_id),
    environment: sanitizeNullableString(input.environment),
    message: sanitizeNullableString(input.message),
    body: input.body ?? {},
    attributes,
  };
}

function redactEnvelope(envelope: TelemetryEnvelope): {
  envelope: TelemetryEnvelope;
  metadata: Record<string, unknown>;
} {
  const topLevelResults = REDACTABLE_TOP_LEVEL_FIELDS.map(
    (field) => [field, redactNullableString(envelope[field], field)] as const,
  );
  const message = envelope.message
    ? redactString(envelope.message, "message")
    : null;
  const body = redactValue(envelope.body ?? {}, "body");
  const attributes = redactValue(envelope.attributes ?? {}, "attributes");
  const report = mergeRedactionReports(
    ...topLevelResults.map(([, result]) => result.report),
    message?.report ?? emptyRedactionReport(),
    body.report,
    attributes.report,
  );
  const safeAttributes = attributes.value as Record<string, unknown>;
  if (report.applied) {
    safeAttributes.redaction = redactionMetadata(report);
  }

  const safeEnvelope: TelemetryEnvelope = sanitizeUniversalSourceMapPayloads({
    ...envelope,
    ...Object.fromEntries(
      topLevelResults.map(([field, result]) => [field, result.value]),
    ),
    message: message ? message.value : envelope.message,
    body: body.value as Record<string, unknown>,
    attributes: safeAttributes,
  });

  return { envelope: safeEnvelope, metadata: safeEnvelope.attributes ?? {} };
}

function sanitizeUniversalSourceMapPayloads(
  envelope: TelemetryEnvelope,
): TelemetryEnvelope {
  const body = sanitizeSourceMapContainers(envelope.body ?? {});
  const sanitizedAttributes = sanitizeSourceMapContainers(
    envelope.attributes ?? {},
  );
  const attributes =
    hasSourceMapContainer(body) || hasSourceMapContainer(sanitizedAttributes)
      ? sanitizeSourceMapContextRecord(sanitizedAttributes)
      : sanitizedAttributes;
  return {
    ...envelope,
    body,
    attributes,
  };
}

function sanitizeSourceMapContainers(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const output = { ...record };
  if ("source_map" in output) {
    const sourceMap = sanitizeSourceMapTelemetry(output.source_map);
    if (sourceMap) output.source_map = sourceMap;
    else output.source_map = undefined;
  }
  const artifact = objectRecord(output.artifact);
  if (Object.keys(artifact).length > 0) {
    output.artifact = sanitizeSourceMapArtifactRecord(artifact);
  }
  return shouldSanitizeRootSourceMapArtifact(output)
    ? sanitizeSourceMapArtifactRecord(output)
    : output;
}

function shouldSanitizeRootSourceMapArtifact(
  record: Record<string, unknown>,
): boolean {
  const artifactType =
    stringAttr(record, "artifact_type") ?? stringAttr(record, "type");
  const path = stringAttr(record, "path");
  const hasSourceArrayShape =
    "sources" in record &&
    ("version" in record ||
      "mappings" in record ||
      "sourcesContent" in record ||
      "source_map_path" in record ||
      "file" in record ||
      "sourceRoot" in record ||
      "source_root" in record);
  return (
    artifactType === "source_map" ||
    artifactType === "source-map" ||
    artifactType === "sourcemap" ||
    Boolean(path?.endsWith(".map")) ||
    hasSourceArrayShape ||
    [
      "source_map_id",
      "source_map_artifact_id",
      "source_map_path",
      "javascript_artifact_id",
      "javascript_path",
      "linked_by",
      "file",
      "sourceRoot",
      "source_root",
      "validation_status",
      "validation_error",
      "source_count",
      "section_count",
      "names_count",
      "has_sources_content",
      "sources",
      "sections",
      "sourcesContent",
      "names",
      "mappings",
      "mappings_length",
      "raw_json",
    ].some((key) => hasSourceMapRootValue(record[key]))
  );
}

function hasSourceMapRootValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "boolean") return value;
  return true;
}

function hasSourceMapContainer(record: Record<string, unknown>): boolean {
  if (Object.keys(objectRecord(record.source_map)).length > 0) return true;
  const artifact = objectRecord(record.artifact);
  if (Object.keys(objectRecord(artifact.source_map)).length > 0) return true;
  const artifactType =
    stringAttr(record, "artifact_type") ??
    stringAttr(record, "type") ??
    stringAttr(artifact, "artifact_type") ??
    stringAttr(artifact, "type");
  const path = stringAttr(record, "path") ?? stringAttr(artifact, "path");
  return (
    artifactType === "source_map" ||
    artifactType === "source-map" ||
    artifactType === "sourcemap" ||
    Boolean(path?.endsWith(".map"))
  );
}

function indexFromEnvelope(
  db: Database,
  envelope: TelemetryEnvelope,
  metadata: Record<string, unknown>,
): EventIndexInput {
  const rawAttrs = envelope.attributes ?? {};
  const rawBody = envelope.body ?? {};
  const rawArtifact = objectRecord(rawBody.artifact);
  const body =
    envelope.type === "artifact"
      ? sanitizeSourceMapArtifactRecord(rawBody)
      : rawBody;
  const artifact = sanitizeSourceMapArtifactRecord(rawArtifact);
  const isSourceMapArtifact =
    envelope.type === "artifact" &&
    (hasSourceMapContainer(body) ||
      hasSourceMapContainer(artifact) ||
      hasSourceMapContainer(rawAttrs));
  const attrs = isSourceMapArtifact
    ? sanitizeSourceMapContextRecord(rawAttrs)
    : rawAttrs;
  const testReport = objectRecord(body.test_report);
  const projectId = stringAttr(attrs, "project_id");
  const pageId = stringAttr(attrs, "page_id");
  const rootArtifact = { ...body };
  rootArtifact.artifact = undefined;
  const artifactContext = isSourceMapArtifact
    ? compactObject({ ...rootArtifact, ...artifact })
    : artifact;
  const attributeMetadata = compactObject(metadata);
  const metadataForIndex =
    envelope.type === "artifact"
      ? compactObject({ ...artifactContext, ...attributeMetadata })
      : stringAttr(attrs, "category") === "test_report"
        ? sanitizedTestReportMetadata(testReport, metadata, attrs)
        : metadata;
  return {
    event_id: envelope.event_id,
    schema_version: envelope.schema_version,
    source_event_id: envelope.source_event_id ?? null,
    event_type: envelope.type,
    event_time: envelope.event_time,
    ingest_time: envelope.ingest_time,
    severity: envelope.severity ?? null,
    source: envelope.source,
    project_id:
      projectId && rowExists(db, "projects", projectId) ? projectId : null,
    page_id: pageId && rowExists(db, "pages", pageId) ? pageId : null,
    machine_id: envelope.machine_id ?? stringAttr(attrs, "machine_id"),
    repo_id: envelope.repo_id ?? stringAttr(attrs, "repo_id"),
    app_id: envelope.app_id ?? stringAttr(attrs, "app_id"),
    process_id: envelope.process_id ?? stringAttr(attrs, "process_id"),
    run_id: envelope.run_id ?? stringAttr(attrs, "run_id"),
    trace_id: envelope.trace_id ?? stringAttr(attrs, "trace_id"),
    span_id: envelope.span_id ?? stringAttr(attrs, "span_id"),
    parent_span_id:
      envelope.parent_span_id ?? stringAttr(attrs, "parent_span_id"),
    session_id: envelope.session_id ?? stringAttr(attrs, "session_id"),
    release_id: envelope.release_id ?? stringAttr(attrs, "release_id"),
    environment: envelope.environment ?? stringAttr(attrs, "environment"),
    artifact_id:
      stringAttr(attrs, "artifact_id") ??
      stringAttr(body, "artifact_id") ??
      stringAttr(artifact, "artifact_id"),
    privacy_tier:
      envelope.privacy ??
      stringAttr(attrs, "privacy_tier") ??
      stringAttr(attrs, "privacy"),
    message: envelope.message ?? null,
    metadata: metadataForIndex,
  };
}

function applyCompatibilityProjections(
  db: Database,
  envelope: TelemetryEnvelope,
  index: EventIndexInput,
): void {
  const skipProcessRunProjection = isTestReportBuildEvent(envelope);
  if (index.trace_id) upsertTraceProjection(db, envelope, index);
  if (envelope.type === "span") upsertSpanProjection(db, envelope, index);
  if (index.session_id || envelope.type === "session")
    upsertSessionProjection(db, envelope, index);
  if (index.release_id || envelope.type === "release")
    upsertReleaseProjection(db, envelope, index);
  if (index.artifact_id || envelope.type === "artifact") {
    upsertArtifactProjection(db, envelope, index);
    upsertSourceMapProjection(db, envelope, index);
  }
  if (skipProcessRunProjection) upsertTestReportProjection(db, envelope, index);
  if (
    !skipProcessRunProjection &&
    (index.process_id ||
      index.run_id ||
      envelope.type === "process" ||
      envelope.type === "build")
  )
    upsertProcessRunProjection(db, envelope, index);
  if (envelope.type === "exception" && envelope.message) {
    upsertIssue(db, {
      project_id: index.project_id ?? undefined,
      level: envelope.severity ?? "error",
      service: stringAttr(envelope.attributes, "service"),
      message: envelope.message,
      stack_trace:
        stringAttr(envelope.attributes, "stack_trace") ??
        stringAttr(envelope.body, "stack_trace"),
    });
  }
}

function isTestReportBuildEvent(envelope: TelemetryEnvelope): boolean {
  return (
    envelope.type === "build" &&
    stringAttr(envelope.attributes, "category") === "test_report"
  );
}

function upsertTraceProjection(
  db: Database,
  envelope: TelemetryEnvelope,
  index: EventIndexInput,
): void {
  if (!index.trace_id) return;
  db.prepare(`
    INSERT INTO traces (id, project_id, app_id, root_span_id, started_at, ended_at, status, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project_id = COALESCE(traces.project_id, excluded.project_id),
      app_id = COALESCE(traces.app_id, excluded.app_id),
      root_span_id = COALESCE(traces.root_span_id, excluded.root_span_id),
      started_at = CASE
        WHEN excluded.started_at IS NOT NULL
          AND (traces.started_at IS NULL OR excluded.started_at < traces.started_at)
        THEN excluded.started_at
        ELSE traces.started_at
      END,
      ended_at = COALESCE(excluded.ended_at, traces.ended_at),
      status = COALESCE(excluded.status, traces.status),
      metadata = excluded.metadata
  `).run(
    index.trace_id,
    index.project_id ?? null,
    index.app_id ?? null,
    index.span_id ?? null,
    stringAttr(envelope.attributes, "started_at") ?? envelope.event_time,
    stringAttr(envelope.attributes, "ended_at"),
    stringAttr(envelope.attributes, "status"),
    JSON.stringify(index.metadata ?? {}),
  );
}

function upsertSpanProjection(
  db: Database,
  envelope: TelemetryEnvelope,
  index: EventIndexInput,
): void {
  const spanId = index.span_id ?? envelope.event_id;
  db.prepare(`
    INSERT INTO spans (id, trace_id, parent_span_id, app_id, process_id, name, operation, status, started_at, ended_at, duration_ms, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      trace_id = COALESCE(spans.trace_id, excluded.trace_id),
      parent_span_id = COALESCE(spans.parent_span_id, excluded.parent_span_id),
      app_id = COALESCE(spans.app_id, excluded.app_id),
      process_id = COALESCE(spans.process_id, excluded.process_id),
      name = COALESCE(spans.name, excluded.name),
      operation = COALESCE(spans.operation, excluded.operation),
      ended_at = COALESCE(excluded.ended_at, spans.ended_at),
      duration_ms = COALESCE(excluded.duration_ms, spans.duration_ms),
      status = COALESCE(excluded.status, spans.status),
      metadata = excluded.metadata
  `).run(
    ...sqlArgs(
      spanId,
      index.trace_id ?? null,
      index.parent_span_id ?? null,
      index.app_id ?? null,
      index.process_id ?? null,
      stringAttr(envelope.attributes, "name") ??
        stringAttr(envelope.body, "name") ??
        envelope.message ??
        null,
      stringAttr(envelope.attributes, "operation") ??
        stringAttr(envelope.body, "operation"),
      stringAttr(envelope.attributes, "status") ?? envelope.severity ?? null,
      stringAttr(envelope.attributes, "started_at") ?? envelope.event_time,
      stringAttr(envelope.attributes, "ended_at"),
      numberAttr(envelope.attributes, "duration_ms") ??
        numberAttr(envelope.body, "duration_ms"),
      JSON.stringify(index.metadata ?? {}),
    ),
  );
}

function upsertSessionProjection(
  db: Database,
  envelope: TelemetryEnvelope,
  index: EventIndexInput,
): void {
  const sessionId = index.session_id ?? envelope.event_id;
  db.prepare(`
    INSERT INTO sessions (id, project_id, app_id, user_hash, started_at, ended_at, status, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project_id = COALESCE(sessions.project_id, excluded.project_id),
      app_id = COALESCE(sessions.app_id, excluded.app_id),
      user_hash = COALESCE(sessions.user_hash, excluded.user_hash),
      started_at = CASE
        WHEN excluded.started_at IS NOT NULL
          AND (sessions.started_at IS NULL OR excluded.started_at < sessions.started_at)
        THEN excluded.started_at
        ELSE sessions.started_at
      END,
      ended_at = COALESCE(excluded.ended_at, sessions.ended_at),
      status = COALESCE(excluded.status, sessions.status),
      metadata = excluded.metadata
  `).run(
    sessionId,
    index.project_id ?? null,
    index.app_id ?? null,
    stringAttr(envelope.attributes, "user_hash"),
    stringAttr(envelope.attributes, "started_at") ?? envelope.event_time,
    stringAttr(envelope.attributes, "ended_at"),
    stringAttr(envelope.attributes, "status"),
    JSON.stringify(index.metadata ?? {}),
  );
}

function upsertReleaseProjection(
  db: Database,
  envelope: TelemetryEnvelope,
  index: EventIndexInput,
): void {
  const releaseId = index.release_id ?? envelope.event_id;
  db.prepare(`
    INSERT INTO releases (id, project_id, app_id, version, commit_sha, build_id, deployed_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project_id = COALESCE(releases.project_id, excluded.project_id),
      app_id = COALESCE(releases.app_id, excluded.app_id),
      version = COALESCE(releases.version, excluded.version),
      commit_sha = COALESCE(releases.commit_sha, excluded.commit_sha),
      build_id = COALESCE(releases.build_id, excluded.build_id),
      deployed_at = COALESCE(excluded.deployed_at, releases.deployed_at),
      metadata = excluded.metadata
  `).run(
    ...sqlArgs(
      releaseId,
      index.project_id ?? null,
      index.app_id ?? null,
      stringAttr(envelope.attributes, "version") ?? envelope.message ?? null,
      stringAttr(envelope.attributes, "commit_sha"),
      stringAttr(envelope.attributes, "build_id"),
      stringAttr(envelope.attributes, "deployed_at") ?? envelope.event_time,
      JSON.stringify(index.metadata ?? {}),
    ),
  );
}

function upsertArtifactProjection(
  db: Database,
  envelope: TelemetryEnvelope,
  index: EventIndexInput,
): void {
  const body = envelope.body ?? {};
  const artifact = objectRecord(body.artifact);
  const isSourceMapArtifact =
    hasSourceMapContainer(body) ||
    hasSourceMapContainer(artifact) ||
    hasSourceMapContainer(envelope.attributes ?? {});
  const artifactIdCandidate =
    index.artifact_id ??
    stringAttr(envelope.attributes, "artifact_id") ??
    stringAttr(body, "artifact_id") ??
    stringAttr(artifact, "artifact_id");
  const artifactId = isSourceMapArtifact
    ? (sanitizeSourceMapIdentifierValue(artifactIdCandidate) ??
      sourceMapFallbackIdentifier(envelope.event_id))
    : (artifactIdCandidate ?? envelope.event_id);
  db.prepare(`
    INSERT INTO artifacts (id, release_id, artifact_type, path, content_hash, size_bytes, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      release_id = COALESCE(artifacts.release_id, excluded.release_id),
      artifact_type = COALESCE(artifacts.artifact_type, excluded.artifact_type),
      path = COALESCE(excluded.path, artifacts.path),
      content_hash = COALESCE(excluded.content_hash, artifacts.content_hash),
      size_bytes = COALESCE(excluded.size_bytes, artifacts.size_bytes),
      metadata = excluded.metadata
  `).run(
    artifactId,
    index.release_id ?? null,
    stringAttr(envelope.attributes, "artifact_type") ??
      stringAttr(envelope.attributes, "type") ??
      stringAttr(artifact, "artifact_type") ??
      stringAttr(artifact, "type") ??
      envelope.type,
    stringAttr(envelope.attributes, "path") ??
      stringAttr(body, "path") ??
      stringAttr(artifact, "path"),
    stringAttr(envelope.attributes, "content_hash") ??
      stringAttr(body, "content_hash") ??
      stringAttr(artifact, "content_hash"),
    numberAttr(envelope.attributes, "size_bytes") ??
      numberAttr(body, "size_bytes") ??
      numberAttr(artifact, "size_bytes"),
    JSON.stringify(index.metadata ?? {}),
  );
}

function upsertProcessRunProjection(
  db: Database,
  envelope: TelemetryEnvelope,
  index: EventIndexInput,
): void {
  if (index.process_id) {
    db.prepare(`
      INSERT INTO processes (id, machine_id, repo_id, app_id, pid, ppid, command, cwd, started_at, ended_at, exit_code, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        machine_id = COALESCE(processes.machine_id, excluded.machine_id),
        repo_id = COALESCE(processes.repo_id, excluded.repo_id),
        app_id = COALESCE(processes.app_id, excluded.app_id),
        pid = COALESCE(processes.pid, excluded.pid),
        ppid = COALESCE(processes.ppid, excluded.ppid),
        command = COALESCE(processes.command, excluded.command),
        cwd = COALESCE(processes.cwd, excluded.cwd),
        ended_at = COALESCE(excluded.ended_at, processes.ended_at),
        exit_code = COALESCE(excluded.exit_code, processes.exit_code),
        metadata = excluded.metadata
    `).run(
      index.process_id,
      index.machine_id ?? null,
      index.repo_id ?? null,
      index.app_id ?? null,
      numberAttr(envelope.attributes, "pid"),
      numberAttr(envelope.attributes, "ppid"),
      stringAttr(envelope.attributes, "command"),
      stringAttr(envelope.attributes, "cwd"),
      stringAttr(envelope.attributes, "started_at") ?? envelope.event_time,
      stringAttr(envelope.attributes, "ended_at"),
      numberAttr(envelope.attributes, "exit_code"),
      JSON.stringify(index.metadata ?? {}),
    );
  }

  if (index.run_id) {
    db.prepare(`
      INSERT INTO runs (id, process_id, run_type, name, status, started_at, ended_at, exit_code, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        process_id = COALESCE(runs.process_id, excluded.process_id),
        run_type = COALESCE(runs.run_type, excluded.run_type),
        name = COALESCE(runs.name, excluded.name),
        ended_at = COALESCE(excluded.ended_at, runs.ended_at),
        exit_code = COALESCE(excluded.exit_code, runs.exit_code),
        status = COALESCE(excluded.status, runs.status),
        metadata = excluded.metadata
    `).run(
      ...sqlArgs(
        index.run_id,
        index.process_id ?? null,
        stringAttr(envelope.attributes, "run_type") ?? envelope.type,
        stringAttr(envelope.attributes, "name") ?? envelope.message ?? null,
        stringAttr(envelope.attributes, "status"),
        stringAttr(envelope.attributes, "started_at") ?? envelope.event_time,
        stringAttr(envelope.attributes, "ended_at"),
        numberAttr(envelope.attributes, "exit_code"),
        JSON.stringify(index.metadata ?? {}),
      ),
    );
  }
}

function normalizeIsoTime(
  value: string | undefined,
  field: string,
): string | null {
  if (value === undefined || value.length === 0) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    throw new Error(`${field} must be an ISO timestamp`);
  return date.toISOString();
}

function deterministicSourceEventId(
  source: string,
  sourceEventId: string | undefined,
): string | undefined {
  if (!sourceEventId) return undefined;
  const digest = createHash("sha256")
    .update(source)
    .update("\0")
    .update(sourceEventId)
    .digest("hex")
    .slice(0, 32);
  return `evt_src_${digest}`;
}

function compactObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, item]) => item !== undefined && item !== null,
    ),
  );
}

function sanitizeOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("expected string field");
  return value;
}

function sanitizeNullableString(value: unknown): string | null {
  return sanitizeOptionalString(value) ?? null;
}

function redactNullableString(value: string | null | undefined, path: string) {
  if (value === null || value === undefined)
    return { value: value ?? null, report: emptyRedactionReport() };
  return redactString(value, path);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringAttr(
  record: Record<string, unknown> | undefined,
  key: string,
): string | null {
  const value = record?.[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint")
    return String(value);
  return null;
}

function numberAttr(
  record: Record<string, unknown> | undefined,
  key: string,
): number | null {
  const value = record?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function rowExists(
  db: Database,
  table: "projects" | "pages",
  id: string,
): boolean {
  const row = db
    .prepare(`SELECT 1 AS found FROM ${table} WHERE id = ? LIMIT 1`)
    .get(id) as { found: number } | undefined;
  return Boolean(row);
}

function emptyRedactionReport() {
  return { applied: false, fields: [], replacements: 0 };
}

function sqlArgs(...values: SqlBinding[]): SqlBinding[] {
  return values;
}
