import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { upsertIssue } from "./issues.ts";
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

const dbDataDirs = new WeakMap<Database, string>();
const dbLockDepths = new WeakMap<Database, number>();

export interface TelemetryEnvelope {
  schema_version: number;
  event_id: string;
  source_event_id?: string | null;
  event_time: string;
  ingest_time: string;
  type: string;
  source: string;
  severity?: string | null;
  privacy?: string | null;
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
  message?: string | null;
  body?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
}

export interface RawEventWrite {
  segment_id: string;
  segment_path: string;
  manifest_path: string;
  byte_offset: number;
  byte_length: number;
  record_hash: string;
}

export interface EventRecord {
  event_id: string;
  schema_version: number;
  source_event_id: string | null;
  event_type: string;
  event_time: string;
  ingest_time: string;
  severity: string | null;
  source: string;
  project_id: string | null;
  page_id: string | null;
  log_id: string | null;
  machine_id: string | null;
  repo_id: string | null;
  app_id: string | null;
  process_id: string | null;
  run_id: string | null;
  trace_id: string | null;
  span_id: string | null;
  parent_span_id: string | null;
  session_id: string | null;
  release_id: string | null;
  environment: string | null;
  artifact_id: string | null;
  privacy_tier: string | null;
  segment_id: string;
  segment_path: string;
  byte_offset: number;
  byte_length: number;
  record_hash: string;
  message: string | null;
  metadata: string | null;
  created_at: string;
}

export interface EventIndexInput {
  event_id: string;
  schema_version?: number;
  source_event_id?: string | null;
  event_type: string;
  event_time: string;
  ingest_time: string;
  severity?: string | null;
  source: string;
  project_id?: string | null;
  page_id?: string | null;
  log_id?: string | null;
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
  privacy_tier?: string | null;
  message?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface ReplayedRawEvent {
  event: TelemetryEnvelope;
  write: RawEventWrite;
}

export interface EventStoreVerification {
  ok: boolean;
  checked_records: number;
  checked_segments: number;
  checked_raw_events: number;
  unindexed_raw_events: number;
  errors: string[];
}

export interface RebuildEventStoreIndexResult {
  indexed_events: number;
  indexed_segments: number;
  skipped_events: number;
  errors: string[];
}

export interface EventStoreSegmentRepairLine {
  byte_offset: number;
  byte_length: number;
  reason: "malformed" | "partial";
  message: string;
}

export interface EventStoreSegmentRepair {
  segment_path: string;
  quarantine_path: string;
  quarantine_manifest_path: string;
  original_byte_length: number;
  repaired_byte_length: number;
  original_hash: string;
  repaired_hash: string;
  retained_events: number;
  removed_lines: EventStoreSegmentRepairLine[];
  removed_bytes: number;
  partial_truncated: boolean;
  malformed_lines: number;
  applied: boolean;
}

export interface RepairEventStoreSegmentsResult {
  applied: boolean;
  scanned_segments: number;
  repaired_segments: number;
  quarantined_bytes: number;
  repairs: EventStoreSegmentRepair[];
  rebuild?: RebuildEventStoreIndexResult;
  verification?: EventStoreVerification;
  errors: string[];
}

interface SegmentCandidate {
  id: string;
  relative_path: string;
  manifest_path: string;
}

export function setEventStoreDataDir(db: Database, dataDir: string): void {
  dbDataDirs.set(db, dataDir);
}

export function getEventStoreDataDir(db: Database): string {
  const mapped = dbDataDirs.get(db);
  if (mapped) return mapped;

  const explicit = process.env.HASNA_LOGS_DATA_DIR ?? process.env.LOGS_DATA_DIR;
  if (explicit) return explicit;

  return join(process.env.HOME ?? "~", ".hasna", "logs");
}

export function appendRawEvent(
  db: Database,
  event: TelemetryEnvelope,
): RawEventWrite {
  return withEventStoreLock(db, () => {
    const line = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
    const candidate = getActiveSegment(db, event.ingest_time, line.byteLength);
    const absolutePath = resolveDataPath(db, candidate.relative_path);

    mkdirSync(dirname(absolutePath), { recursive: true });

    const byteOffset = existsSync(absolutePath)
      ? statSync(absolutePath).size
      : 0;
    appendAndFlush(absolutePath, line);

    const byteLength = line.byteLength;
    const currentSize = byteOffset + byteLength;
    const recordHash = sha256(line);
    const segmentHash = shouldHashSegmentOnAppend()
      ? sha256(readFileSync(absolutePath))
      : null;

    db.prepare(`
      INSERT INTO event_segments (
        id, relative_path, manifest_path, byte_length, event_count,
        first_event_time, last_event_time, segment_hash, updated_at
      )
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ON CONFLICT(id) DO UPDATE SET
        byte_length = excluded.byte_length,
        event_count = event_segments.event_count + 1,
        first_event_time = COALESCE(event_segments.first_event_time, excluded.first_event_time),
        last_event_time = excluded.last_event_time,
        segment_hash = excluded.segment_hash,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    `).run(
      candidate.id,
      candidate.relative_path,
      candidate.manifest_path,
      currentSize,
      event.event_time,
      event.event_time,
      segmentHash,
    );

    writeSegmentManifest(db, candidate.id);

    return {
      segment_id: candidate.id,
      segment_path: candidate.relative_path,
      manifest_path: candidate.manifest_path,
      byte_offset: byteOffset,
      byte_length: byteLength,
      record_hash: recordHash,
    };
  });
}

export function indexRawEvent(
  db: Database,
  event: EventIndexInput,
  write: RawEventWrite,
): void {
  const existing = getEventRecord(db, event.event_id);
  if (existing) {
    if (matchesRawEventIndex(existing, event, write)) return;
    throw new Error(
      `Event record already indexed with different raw pointer: ${event.event_id}`,
    );
  }

  db.prepare(`
    INSERT INTO event_records (
      event_id, schema_version, source_event_id, event_type, event_time, ingest_time,
      severity, source, project_id, page_id, log_id, trace_id, session_id,
      machine_id, repo_id, app_id, process_id, run_id, span_id, parent_span_id,
      release_id, environment, artifact_id, privacy_tier,
      segment_id, segment_path, byte_offset, byte_length, record_hash,
      message, metadata
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.event_id,
    event.schema_version ?? 1,
    event.source_event_id ?? null,
    event.event_type,
    event.event_time,
    event.ingest_time,
    event.severity ?? null,
    event.source,
    event.project_id ?? null,
    event.page_id ?? null,
    event.log_id ?? null,
    event.trace_id ?? null,
    event.session_id ?? null,
    event.machine_id ?? null,
    event.repo_id ?? null,
    event.app_id ?? null,
    event.process_id ?? null,
    event.run_id ?? null,
    event.span_id ?? null,
    event.parent_span_id ?? null,
    event.release_id ?? null,
    event.environment ?? null,
    event.artifact_id ?? null,
    event.privacy_tier ?? null,
    write.segment_id,
    write.segment_path,
    write.byte_offset,
    write.byte_length,
    write.record_hash,
    event.message ?? null,
    event.metadata ? JSON.stringify(event.metadata) : null,
  );
}

function matchesRawEventIndex(
  existing: EventRecord,
  event: EventIndexInput,
  write: RawEventWrite,
): boolean {
  return (
    existing.schema_version === (event.schema_version ?? 1) &&
    existing.source_event_id === (event.source_event_id ?? null) &&
    existing.event_type === event.event_type &&
    existing.event_time === event.event_time &&
    existing.ingest_time === event.ingest_time &&
    existing.source === event.source &&
    existing.segment_id === write.segment_id &&
    existing.segment_path === write.segment_path &&
    existing.byte_offset === write.byte_offset &&
    existing.byte_length === write.byte_length &&
    existing.record_hash === write.record_hash
  );
}

export function getEventRecord(
  db: Database,
  eventId: string,
): EventRecord | null {
  const row = db
    .prepare("SELECT * FROM event_records WHERE event_id = ?")
    .get(eventId) as EventRecord | undefined;
  return row ?? null;
}

export function readRawEvent(
  db: Database,
  eventOrRecord: string | EventRecord,
): TelemetryEnvelope | null {
  const record =
    typeof eventOrRecord === "string"
      ? getEventRecord(db, eventOrRecord)
      : eventOrRecord;
  if (!record) return null;

  const bytes = readFileSync(resolveDataPath(db, record.segment_path));
  const line = bytes.subarray(
    record.byte_offset,
    record.byte_offset + record.byte_length,
  );
  const actualHash = sha256(line);
  if (actualHash !== record.record_hash) {
    throw new Error(`Raw event hash mismatch for ${record.event_id}`);
  }

  return JSON.parse(line.toString("utf8")) as TelemetryEnvelope;
}

export function replayRawEvents(
  db: Database,
  segmentPath?: string,
): ReplayedRawEvent[] {
  const paths = segmentPath ? [segmentPath] : listKnownSegmentPaths(db);
  return paths.flatMap((path) => readSegmentEvents(db, path));
}

export function verifyEventStore(db: Database): EventStoreVerification {
  const errors: string[] = [];
  const segments = db
    .prepare("SELECT * FROM event_segments ORDER BY relative_path")
    .all() as Array<{
    id: string;
    relative_path: string;
    manifest_path: string | null;
    byte_length: number;
    event_count: number;
    segment_hash: string | null;
  }>;
  const records = db
    .prepare("SELECT * FROM event_records ORDER BY event_time, event_id")
    .all() as EventRecord[];
  const segmentsByPath = new Map(
    segments.map((segment) => [segment.relative_path, segment]),
  );
  const recordsByEventId = new Map(
    records.map((record) => [record.event_id, record]),
  );
  const paths = [
    ...new Set([
      ...segments.map((segment) => segment.relative_path),
      ...listSegmentFiles(db),
    ]),
  ].sort();
  let checkedRawEvents = 0;
  let unindexedRawEvents = 0;

  for (const relativePath of paths) {
    const segment = segmentsByPath.get(relativePath);
    try {
      const path = resolveDataPath(db, relativePath);
      if (!existsSync(path)) {
        errors.push(`Missing segment file: ${relativePath}`);
        continue;
      }

      const scan = scanSegmentEvents(db, relativePath, { strict: false });
      checkedRawEvents += scan.events.length;
      errors.push(...scan.errors);

      if (!segment) {
        errors.push(`Segment file is not indexed in SQLite: ${relativePath}`);
      } else {
        if (scan.byte_length !== segment.byte_length) {
          errors.push(
            `Segment size mismatch for ${relativePath}: sqlite=${segment.byte_length} file=${scan.byte_length}`,
          );
        }
        if (
          segment.segment_hash &&
          scan.segment_hash !== segment.segment_hash
        ) {
          errors.push(`Segment hash mismatch for ${relativePath}`);
        }
        if (
          segment.manifest_path &&
          !existsSync(resolveDataPath(db, segment.manifest_path))
        ) {
          errors.push(`Missing segment manifest: ${segment.manifest_path}`);
        }
        if (scan.events.length !== segment.event_count) {
          errors.push(
            `Segment event count mismatch for ${relativePath}: sqlite=${segment.event_count} file=${scan.events.length}`,
          );
        }
      }

      for (const item of scan.events) {
        const record = recordsByEventId.get(item.event.event_id);
        if (!record) {
          unindexedRawEvents += 1;
          errors.push(
            `Raw event is not indexed in SQLite: ${item.event.event_id} at ${relativePath}:${item.write.byte_offset}`,
          );
          continue;
        }
        if (
          record.segment_path !== item.write.segment_path ||
          record.byte_offset !== item.write.byte_offset ||
          record.byte_length !== item.write.byte_length
        ) {
          errors.push(`Raw event pointer mismatch for ${item.event.event_id}`);
        }
        if (record.record_hash !== item.write.record_hash) {
          errors.push(
            `Raw event hash index mismatch for ${item.event.event_id}`,
          );
        }
      }
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }

  for (const record of records) {
    try {
      const raw = readRawEvent(db, record);
      if (raw?.event_id !== record.event_id) {
        errors.push(`Raw event id mismatch for ${record.event_id}`);
      }
      if (raw?.event_time !== record.event_time) {
        errors.push(`Raw event time mismatch for ${record.event_id}`);
      }
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }

  return {
    ok: errors.length === 0,
    checked_records: records.length,
    checked_segments: paths.length,
    checked_raw_events: checkedRawEvents,
    unindexed_raw_events: unindexedRawEvents,
    errors,
  };
}

export function rebuildEventStoreIndex(
  db: Database,
): RebuildEventStoreIndexResult {
  return withEventStoreLock(db, () => rebuildEventStoreIndexLocked(db));
}

function rebuildEventStoreIndexLocked(
  db: Database,
): RebuildEventStoreIndexResult {
  const segmentPaths = listSegmentFiles(db);
  let indexedEvents = 0;
  let skippedEvents = 0;
  const errors: string[] = [];

  db.transaction(() => {
    db.run("DELETE FROM event_records");
    db.run("DELETE FROM event_segments");
    clearCompatibilityProjections(db);

    for (const path of segmentPaths) {
      const scan = scanSegmentEvents(db, path, { strict: false });
      errors.push(...scan.errors);
      const candidate = segmentCandidate(path);
      const first = scan.events[0]?.event.event_time ?? null;
      const last = scan.events.at(-1)?.event.event_time ?? null;

      db.prepare(`
        INSERT INTO event_segments (
          id, relative_path, manifest_path, byte_length, event_count,
          first_event_time, last_event_time, segment_hash, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      `).run(
        candidate.id,
        candidate.relative_path,
        candidate.manifest_path,
        scan.byte_length,
        scan.events.length,
        first,
        last,
        scan.segment_hash,
      );

      for (const item of scan.events) {
        try {
          const index = eventIndexFromEnvelope(db, item.event);
          if (item.event.type === "log")
            replayLogProjection(db, item.event, index);
          indexRawEvent(db, index, item.write);
          applyReplayedCompatibilityProjections(db, item.event, index);
          indexedEvents += 1;
        } catch (error) {
          skippedEvents += 1;
          errors.push(
            `Skipped raw event ${item.event.event_id} from ${path}:${item.write.byte_offset}: ${errorMessage(error)}`,
          );
        }
      }

      writeSegmentManifest(db, candidate.id);
    }
  })();

  return {
    indexed_events: indexedEvents,
    indexed_segments: segmentPaths.length,
    skipped_events: skippedEvents,
    errors,
  };
}

export function repairEventStoreSegments(
  db: Database,
  options: { apply?: boolean } = {},
): RepairEventStoreSegmentsResult {
  const apply = options.apply === true;
  if (apply)
    return withEventStoreLock(db, () =>
      repairEventStoreSegmentsLocked(db, true),
    );
  return repairEventStoreSegmentsLocked(db, false);
}

function repairEventStoreSegmentsLocked(
  db: Database,
  apply: boolean,
): RepairEventStoreSegmentsResult {
  const segmentPaths = listSegmentFiles(db);
  const repairs: EventStoreSegmentRepair[] = [];
  const errors: string[] = [];

  for (const segmentPath of segmentPaths) {
    try {
      const plan = planSegmentRepair(db, segmentPath);
      if (plan.repair.removed_lines.length === 0) continue;
      if (apply) applySegmentRepair(db, plan);
      repairs.push({ ...plan.repair, applied: apply });
    } catch (error) {
      errors.push(`Failed to repair ${segmentPath}: ${errorMessage(error)}`);
    }
  }

  let rebuild: RebuildEventStoreIndexResult | undefined;
  let verification: EventStoreVerification | undefined;
  if (apply) {
    rebuild = rebuildEventStoreIndex(db);
    verification = verifyEventStore(db);
  }

  return {
    applied: apply,
    scanned_segments: segmentPaths.length,
    repaired_segments: repairs.length,
    quarantined_bytes: repairs.reduce(
      (total, repair) => total + repair.removed_bytes,
      0,
    ),
    repairs,
    rebuild,
    verification,
    errors,
  };
}

function getActiveSegment(
  db: Database,
  ingestTime: string,
  eventByteLength: number,
): SegmentCandidate {
  const prefix = segmentPrefix(ingestTime);
  const maxSegmentBytes = getMaxSegmentBytes();
  const latest = db
    .prepare(`
      SELECT id, relative_path, byte_length, sealed_at
      FROM event_segments
      WHERE relative_path LIKE ?
      ORDER BY relative_path DESC
      LIMIT 1
    `)
    .get(`${prefix}/events-%.jsonl`) as
    | {
        id: string;
        relative_path: string;
        byte_length: number;
        sealed_at: string | null;
      }
    | undefined;

  if (
    latest &&
    !latest.sealed_at &&
    latest.byte_length + eventByteLength <= maxSegmentBytes
  ) {
    return segmentCandidate(latest.relative_path);
  }

  if (latest && !latest.sealed_at) {
    sealSegment(db, latest.id);
  }

  const lastSequence = latest ? parseSegmentSequence(latest.relative_path) : 0;
  return segmentCandidate(
    `${prefix}/events-${String(lastSequence + 1).padStart(6, "0")}.jsonl`,
  );
}

function segmentPrefix(isoTime: string): string {
  const date = new Date(isoTime);
  const valid = Number.isNaN(date.getTime()) ? new Date() : date;
  const year = valid.getUTCFullYear();
  const month = String(valid.getUTCMonth() + 1).padStart(2, "0");
  const day = String(valid.getUTCDate()).padStart(2, "0");
  return `segments/${year}/${month}/${day}`;
}

function segmentCandidate(relativePath: string): SegmentCandidate {
  return {
    id: sha256(relativePath).slice(0, 24),
    relative_path: relativePath,
    manifest_path: relativePath.replace(/\.jsonl$/, ".manifest.json"),
  };
}

function parseSegmentSequence(relativePath: string): number {
  const match = /events-(\d+)\.jsonl$/.exec(relativePath);
  return match?.[1] ? Number.parseInt(match[1], 10) : 0;
}

function writeSegmentManifest(db: Database, segmentId: string): void {
  const segment = db
    .prepare("SELECT * FROM event_segments WHERE id = ?")
    .get(segmentId) as Record<string, unknown> | undefined;
  if (!segment || typeof segment.manifest_path !== "string") return;

  const manifestPath = resolveDataPath(db, segment.manifest_path);
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ schema_version: 1, segment }, null, 2)}\n`,
    "utf8",
  );
}

function readSegmentEvents(
  db: Database,
  relativePath: string,
): ReplayedRawEvent[] {
  return scanSegmentEvents(db, relativePath, { strict: true }).events;
}

function scanSegmentEvents(
  db: Database,
  relativePath: string,
  options: { strict: boolean },
): {
  events: ReplayedRawEvent[];
  errors: string[];
  byte_length: number;
  segment_hash: string;
} {
  const absolutePath = resolveDataPath(db, relativePath);
  const bytes = readFileSync(absolutePath);
  const candidate = segmentCandidate(relativePath);
  const events: ReplayedRawEvent[] = [];
  const errors: string[] = [];
  let offset = 0;

  while (offset < bytes.byteLength) {
    const newline = bytes.indexOf(10, offset);
    if (newline === -1) {
      const message = `Partial raw event line in ${relativePath} at byte ${offset}`;
      if (options.strict) throw new Error(message);
      errors.push(message);
      break;
    }

    const end = newline + 1;
    const line = bytes.subarray(offset, end);
    if (line.toString("utf8").trim().length > 0) {
      try {
        const event = JSON.parse(line.toString("utf8")) as TelemetryEnvelope;
        events.push({
          event,
          write: {
            segment_id: candidate.id,
            segment_path: candidate.relative_path,
            manifest_path: candidate.manifest_path,
            byte_offset: offset,
            byte_length: line.byteLength,
            record_hash: sha256(line),
          },
        });
      } catch (error) {
        const message = `Malformed raw event line in ${relativePath} at byte ${offset}: ${errorMessage(error)}`;
        if (options.strict) throw new Error(message);
        errors.push(message);
      }
    }
    offset = end;
  }

  return {
    events,
    errors,
    byte_length: bytes.byteLength,
    segment_hash: sha256(bytes),
  };
}

interface SegmentRepairPlan {
  repair: EventStoreSegmentRepair;
  repaired_bytes: Buffer;
  quarantine_bytes: Buffer;
}

function planSegmentRepair(
  db: Database,
  relativePath: string,
): SegmentRepairPlan {
  const absolutePath = resolveDataPath(db, relativePath);
  const bytes = readFileSync(absolutePath);
  const originalHash = sha256(bytes);
  const retainedChunks: Buffer[] = [];
  const quarantineChunks: Buffer[] = [];
  const removedLines: EventStoreSegmentRepairLine[] = [];
  let retainedEvents = 0;
  let malformedLines = 0;
  let partialTruncated = false;
  let offset = 0;

  while (offset < bytes.byteLength) {
    const newline = bytes.indexOf(10, offset);
    if (newline === -1) {
      const line = bytes.subarray(offset);
      const message = `Partial raw event line in ${relativePath} at byte ${offset}`;
      quarantineChunks.push(line);
      removedLines.push({
        byte_offset: offset,
        byte_length: line.byteLength,
        reason: "partial",
        message,
      });
      partialTruncated = true;
      break;
    }

    const end = newline + 1;
    const line = bytes.subarray(offset, end);
    if (line.toString("utf8").trim().length === 0) {
      retainedChunks.push(line);
      offset = end;
      continue;
    }

    try {
      JSON.parse(line.toString("utf8")) as TelemetryEnvelope;
      retainedChunks.push(line);
      retainedEvents += 1;
    } catch (error) {
      const message = `Malformed raw event line in ${relativePath} at byte ${offset}: ${errorMessage(error)}`;
      quarantineChunks.push(line);
      removedLines.push({
        byte_offset: offset,
        byte_length: line.byteLength,
        reason: "malformed",
        message,
      });
      malformedLines += 1;
    }
    offset = end;
  }

  const repairedBytes = Buffer.concat(retainedChunks);
  const quarantineBytes = Buffer.concat(quarantineChunks);
  const repairedHash = sha256(repairedBytes);
  const quarantinePath = quarantinePathForSegment(relativePath, originalHash);
  const quarantineManifestPath = quarantinePath.replace(
    /\.bad$/,
    ".manifest.json",
  );

  return {
    repaired_bytes: repairedBytes,
    quarantine_bytes: quarantineBytes,
    repair: {
      segment_path: relativePath,
      quarantine_path: quarantinePath,
      quarantine_manifest_path: quarantineManifestPath,
      original_byte_length: bytes.byteLength,
      repaired_byte_length: repairedBytes.byteLength,
      original_hash: originalHash,
      repaired_hash: repairedHash,
      retained_events: retainedEvents,
      removed_lines: removedLines,
      removed_bytes: quarantineBytes.byteLength,
      partial_truncated: partialTruncated,
      malformed_lines: malformedLines,
      applied: false,
    },
  };
}

function applySegmentRepair(db: Database, plan: SegmentRepairPlan): void {
  const repair = plan.repair;
  const segmentPath = resolveDataPath(db, repair.segment_path);
  const quarantinePath = resolveDataPath(db, repair.quarantine_path);
  const quarantineManifestPath = resolveDataPath(
    db,
    repair.quarantine_manifest_path,
  );
  mkdirSync(dirname(quarantinePath), { recursive: true });
  mkdirSync(dirname(quarantineManifestPath), { recursive: true });
  writeFileSync(quarantinePath, plan.quarantine_bytes);
  writeFileSync(
    quarantineManifestPath,
    `${JSON.stringify(
      {
        schema_version: 1,
        original_segment_path: repair.segment_path,
        quarantine_path: repair.quarantine_path,
        original_byte_length: repair.original_byte_length,
        repaired_byte_length: repair.repaired_byte_length,
        original_hash: repair.original_hash,
        repaired_hash: repair.repaired_hash,
        removed_bytes: repair.removed_bytes,
        removed_lines: repair.removed_lines,
        repaired_at: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const tmpPath = `${segmentPath}.repair-${process.pid}-${Date.now()}.tmp`;
  writeFileSync(tmpPath, plan.repaired_bytes);
  renameSync(tmpPath, segmentPath);
}

function quarantinePathForSegment(
  relativePath: string,
  originalHash: string,
): string {
  return `quarantine/${relativePath.replace(
    /\.jsonl$/,
    `.${originalHash.slice(0, 12)}.bad`,
  )}`;
}

function listKnownSegmentPaths(db: Database): string[] {
  const rows = db
    .prepare("SELECT relative_path FROM event_segments ORDER BY relative_path")
    .all() as Array<{ relative_path: string }>;
  return [
    ...new Set([
      ...rows.map((row) => row.relative_path),
      ...listSegmentFiles(db),
    ]),
  ].sort();
}

function listSegmentFiles(db: Database): string[] {
  const root = resolveDataPath(db, "segments");
  if (!existsSync(root)) return [];

  const paths: string[] = [];
  walkSegmentDir(root, "segments", paths);
  return paths.filter((path) => path.endsWith(".jsonl")).sort();
}

function walkSegmentDir(
  absoluteDir: string,
  relativeDir: string,
  paths: string[],
): void {
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const relativePath = `${relativeDir}/${entry.name}`;
    const absolutePath = join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      walkSegmentDir(absolutePath, relativePath, paths);
    } else if (entry.isFile()) {
      paths.push(relativePath);
    }
  }
}

function hasSourceMapContainer(record: Record<string, unknown>): boolean {
  if (Object.keys(objectRecord(record.source_map)).length > 0) return true;
  const artifact = objectRecord(record.artifact);
  if (Object.keys(objectRecord(artifact.source_map)).length > 0) return true;
  const artifactType =
    stringAttribute(record, "artifact_type") ??
    stringAttribute(record, "type") ??
    stringAttribute(artifact, "artifact_type") ??
    stringAttribute(artifact, "type");
  const path =
    stringAttribute(record, "path") ?? stringAttribute(artifact, "path");
  return (
    artifactType === "source_map" ||
    artifactType === "source-map" ||
    artifactType === "sourcemap" ||
    Boolean(path?.endsWith(".map"))
  );
}

function eventIndexFromEnvelope(
  db: Database,
  event: TelemetryEnvelope,
): EventIndexInput {
  const rawAttrs = objectRecord(event.attributes);
  const rawBody = objectRecord(event.body);
  const body =
    event.type === "artifact"
      ? sanitizeSourceMapArtifactRecord(rawBody)
      : rawBody;
  const artifact = sanitizeSourceMapArtifactRecord(
    objectRecord(rawBody.artifact),
  );
  const attrs =
    event.type === "artifact" &&
    (hasSourceMapContainer(body) ||
      hasSourceMapContainer(artifact) ||
      hasSourceMapContainer(rawAttrs))
      ? sanitizeSourceMapContextRecord(rawAttrs)
      : rawAttrs;
  const log = objectRecord(event.body?.log);
  const rawProjectId =
    stringAttribute(attrs, "project_id") ?? stringAttribute(log, "project_id");
  const rawPageId =
    stringAttribute(attrs, "page_id") ?? stringAttribute(log, "page_id");

  return {
    event_id: event.event_id,
    schema_version: event.schema_version,
    source_event_id: event.source_event_id ?? null,
    event_type: event.type,
    event_time: event.event_time,
    ingest_time: event.ingest_time,
    severity: event.severity ?? null,
    source: event.source,
    project_id:
      rawProjectId && rowExists(db, "projects", rawProjectId)
        ? rawProjectId
        : null,
    page_id: rawPageId && rowExists(db, "pages", rawPageId) ? rawPageId : null,
    log_id: event.type === "log" ? event.event_id : null,
    machine_id: event.machine_id ?? stringAttribute(attrs, "machine_id"),
    repo_id: event.repo_id ?? stringAttribute(attrs, "repo_id"),
    app_id: event.app_id ?? stringAttribute(attrs, "app_id"),
    process_id: event.process_id ?? stringAttribute(attrs, "process_id"),
    run_id: event.run_id ?? stringAttribute(attrs, "run_id"),
    trace_id:
      event.trace_id ??
      stringAttribute(attrs, "trace_id") ??
      stringAttribute(log, "trace_id"),
    span_id: event.span_id ?? stringAttribute(attrs, "span_id"),
    parent_span_id:
      event.parent_span_id ?? stringAttribute(attrs, "parent_span_id"),
    session_id:
      event.session_id ??
      stringAttribute(attrs, "session_id") ??
      stringAttribute(log, "session_id"),
    release_id: event.release_id ?? stringAttribute(attrs, "release_id"),
    environment: event.environment ?? stringAttribute(attrs, "environment"),
    artifact_id:
      stringAttribute(attrs, "artifact_id") ??
      stringAttribute(body, "artifact_id") ??
      stringAttribute(artifact, "artifact_id"),
    privacy_tier: event.privacy ?? stringAttribute(attrs, "privacy_tier"),
    message: event.message ?? null,
    metadata: metadataFromEnvelope(event),
  };
}

function clearCompatibilityProjections(db: Database): void {
  db.run("DELETE FROM issues");
  db.run("DELETE FROM logs");
  db.run("DELETE FROM spans");
  db.run("DELETE FROM traces");
  db.run("DELETE FROM sessions");
  db.run("DELETE FROM source_map_sources");
  db.run("DELETE FROM source_maps");
  db.run("DELETE FROM test_cases");
  db.run("DELETE FROM test_reports");
  db.run("DELETE FROM artifacts");
  db.run("DELETE FROM releases");
  db.run("DELETE FROM processes");
  db.run("DELETE FROM runs");
}

function applyReplayedCompatibilityProjections(
  db: Database,
  event: TelemetryEnvelope,
  index: EventIndexInput,
): void {
  const attrs = objectRecord(event.attributes);
  const category = stringAttribute(attrs, "category");
  const isCommandRunSummary =
    event.type === "build" && category === "command_run_summary";
  const isTestReportEvent =
    event.type === "build" && category === "test_report";
  if (index.trace_id) replayTraceProjection(db, event, index);
  if (event.type === "span") replaySpanProjection(db, event, index);
  if (index.session_id || event.type === "session")
    replaySessionProjection(db, event, index);
  if (index.release_id || event.type === "release")
    replayReleaseProjection(db, event, index);
  if (index.artifact_id || event.type === "artifact") {
    replayArtifactProjection(db, event, index);
    upsertSourceMapProjection(db, event, index);
  }
  if (isTestReportEvent) upsertTestReportProjection(db, event, index);
  if (isCommandRunSummary) {
    replayProcessRunProjection(db, event, index, {
      preserveExistingMetadata: true,
    });
  } else if (
    !isTestReportEvent &&
    (index.process_id ||
      index.run_id ||
      event.type === "process" ||
      event.type === "build")
  ) {
    replayProcessRunProjection(db, event, index);
  }
  replayIssueProjection(db, event, index);
}

function replayLogProjection(
  db: Database,
  event: TelemetryEnvelope,
  index: EventIndexInput,
): void {
  const log = objectRecord(event.body?.log);
  const level = normalizeLogLevel(
    event.severity ?? stringAttribute(log, "level"),
  );
  const metadata = objectRecord(log.metadata);
  db.prepare(`
    INSERT INTO logs (id, timestamp, project_id, page_id, level, source, service, message, trace_id, session_id, agent, url, stack_trace, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      timestamp = excluded.timestamp,
      project_id = excluded.project_id,
      page_id = excluded.page_id,
      level = excluded.level,
      source = excluded.source,
      service = excluded.service,
      message = excluded.message,
      trace_id = excluded.trace_id,
      session_id = excluded.session_id,
      agent = excluded.agent,
      url = excluded.url,
      stack_trace = excluded.stack_trace,
      metadata = excluded.metadata
  `).run(
    event.event_id,
    event.event_time,
    index.project_id ?? null,
    index.page_id ?? null,
    level,
    stringAttribute(log, "source") ?? event.source,
    stringAttribute(log, "service") ??
      stringAttribute(objectRecord(event.attributes), "service"),
    stringAttribute(log, "message") ?? event.message ?? "",
    index.trace_id ?? null,
    index.session_id ?? null,
    stringAttribute(log, "agent"),
    stringAttribute(log, "url"),
    stringAttribute(log, "stack_trace"),
    Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : null,
  );
}

function replayTraceProjection(
  db: Database,
  event: TelemetryEnvelope,
  index: EventIndexInput,
): void {
  if (!index.trace_id) return;
  const attrs = objectRecord(event.attributes);
  const body = objectRecord(event.body);
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
    stringAttribute(attrs, "started_at") ?? event.event_time,
    stringAttribute(attrs, "ended_at") ?? stringAttribute(body, "ended_at"),
    stringAttribute(attrs, "status") ?? stringAttribute(body, "status"),
    JSON.stringify(index.metadata ?? {}),
  );
}

function replaySpanProjection(
  db: Database,
  event: TelemetryEnvelope,
  index: EventIndexInput,
): void {
  const attrs = objectRecord(event.attributes);
  const body = objectRecord(event.body);
  const spanId = index.span_id ?? event.event_id;
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
    spanId,
    index.trace_id ?? null,
    index.parent_span_id ?? null,
    index.app_id ?? null,
    index.process_id ?? null,
    stringAttribute(attrs, "name") ??
      stringAttribute(body, "name") ??
      event.message ??
      null,
    stringAttribute(attrs, "operation") ?? stringAttribute(body, "operation"),
    stringAttribute(attrs, "status") ?? event.severity ?? null,
    stringAttribute(attrs, "started_at") ?? event.event_time,
    stringAttribute(attrs, "ended_at"),
    numberAttribute(attrs, "duration_ms") ??
      numberAttribute(body, "duration_ms"),
    JSON.stringify(index.metadata ?? {}),
  );
}

function replaySessionProjection(
  db: Database,
  event: TelemetryEnvelope,
  index: EventIndexInput,
): void {
  const attrs = objectRecord(event.attributes);
  const sessionId = index.session_id ?? event.event_id;
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
    stringAttribute(attrs, "user_hash"),
    stringAttribute(attrs, "started_at") ?? event.event_time,
    stringAttribute(attrs, "ended_at"),
    stringAttribute(attrs, "status"),
    JSON.stringify(index.metadata ?? {}),
  );
}

function replayReleaseProjection(
  db: Database,
  event: TelemetryEnvelope,
  index: EventIndexInput,
): void {
  const attrs = objectRecord(event.attributes);
  const releaseId = index.release_id ?? event.event_id;
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
    releaseId,
    index.project_id ?? null,
    index.app_id ?? null,
    stringAttribute(attrs, "version") ?? event.message ?? null,
    stringAttribute(attrs, "commit_sha"),
    stringAttribute(attrs, "build_id"),
    stringAttribute(attrs, "deployed_at") ?? event.event_time,
    JSON.stringify(index.metadata ?? {}),
  );
}

function replayArtifactProjection(
  db: Database,
  event: TelemetryEnvelope,
  index: EventIndexInput,
): void {
  const sanitizedAttrs = sanitizeSourceMapArtifactRecord(
    objectRecord(event.attributes),
  );
  const rawBody = objectRecord(event.body);
  const body = sanitizeSourceMapArtifactRecord(rawBody);
  const artifact = sanitizeSourceMapArtifactRecord(
    objectRecord(rawBody.artifact),
  );
  const attrs =
    hasSourceMapContainer(body) ||
    hasSourceMapContainer(artifact) ||
    hasSourceMapContainer(sanitizedAttrs)
      ? sanitizeSourceMapContextRecord(sanitizedAttrs)
      : sanitizedAttrs;
  const isSourceMapArtifact =
    hasSourceMapContainer(body) ||
    hasSourceMapContainer(artifact) ||
    hasSourceMapContainer(attrs);
  const artifactIdCandidate =
    index.artifact_id ??
    stringAttribute(attrs, "artifact_id") ??
    stringAttribute(body, "artifact_id") ??
    stringAttribute(artifact, "artifact_id");
  const artifactId = isSourceMapArtifact
    ? (sanitizeSourceMapIdentifierValue(artifactIdCandidate) ??
      sourceMapFallbackIdentifier(event.event_id))
    : (artifactIdCandidate ?? event.event_id);
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
    stringAttribute(attrs, "artifact_type") ??
      stringAttribute(attrs, "type") ??
      stringAttribute(artifact, "artifact_type") ??
      stringAttribute(artifact, "type") ??
      event.type,
    stringAttribute(attrs, "path") ??
      stringAttribute(body, "path") ??
      stringAttribute(artifact, "path"),
    stringAttribute(attrs, "content_hash") ??
      stringAttribute(body, "content_hash") ??
      stringAttribute(artifact, "content_hash"),
    numberAttribute(attrs, "size_bytes") ??
      numberAttribute(body, "size_bytes") ??
      numberAttribute(artifact, "size_bytes"),
    JSON.stringify(index.metadata ?? {}),
  );
}

function replayProcessRunProjection(
  db: Database,
  event: TelemetryEnvelope,
  index: EventIndexInput,
  options: { preserveExistingMetadata?: boolean } = {},
): void {
  const attrs = objectRecord(event.attributes);
  const processBody = objectRecord(event.body?.process);
  const lifecycleBody = objectRecord(event.body?.lifecycle);
  const body =
    Object.keys(processBody).length > 0 ? processBody : lifecycleBody;
  const preserveExistingMetadata = options.preserveExistingMetadata ? 1 : 0;
  const metadataObject = index.metadata ?? {};
  const metadata = JSON.stringify(metadataObject);
  const processMetadata =
    preserveExistingMetadata && index.process_id
      ? mergedReplayMetadata(db, "processes", index.process_id, metadataObject)
      : metadata;
  const runMetadata =
    preserveExistingMetadata && index.run_id
      ? mergedReplayMetadata(db, "runs", index.run_id, metadataObject)
      : metadata;
  const exitCode =
    numberAttribute(attrs, "exit_code") ?? numberAttribute(body, "exit_code");
  const signal =
    stringAttribute(attrs, "signal") ?? stringAttribute(body, "signal");
  const status =
    stringAttribute(attrs, "status") ??
    stringAttribute(body, "status") ??
    statusFromExit(exitCode, signal);
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
      numberAttribute(attrs, "pid") ?? numberAttribute(body, "pid"),
      numberAttribute(attrs, "ppid") ?? numberAttribute(body, "ppid"),
      commandString(stringAttribute(attrs, "command") ?? body.command),
      stringAttribute(attrs, "cwd") ?? stringAttribute(body, "cwd"),
      stringAttribute(attrs, "started_at") ??
        stringAttribute(body, "started_at") ??
        event.event_time,
      stringAttribute(attrs, "ended_at") ?? stringAttribute(body, "ended_at"),
      exitCode,
      processMetadata,
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
      index.run_id,
      index.process_id ?? null,
      stringAttribute(attrs, "run_type") ??
        stringAttribute(body, "run_type") ??
        stringAttribute(body, "kind") ??
        event.type,
      stringAttribute(attrs, "name") ??
        commandString(body.command) ??
        event.message ??
        null,
      status,
      stringAttribute(attrs, "started_at") ??
        stringAttribute(body, "started_at") ??
        event.event_time,
      stringAttribute(attrs, "ended_at") ?? stringAttribute(body, "ended_at"),
      exitCode,
      runMetadata,
    );
  }
}

function mergedReplayMetadata(
  db: Database,
  table: "processes" | "runs",
  id: string,
  incoming: Record<string, unknown>,
): string {
  const row = db
    .prepare(`SELECT metadata FROM ${table} WHERE id = ?`)
    .get(id) as { metadata: string | null } | undefined;
  const existing = parseJsonRecord(row?.metadata);
  return JSON.stringify({ ...incoming, ...existing });
}

function statusFromExit(
  exitCode: number | null,
  signal: string | null,
): "completed" | "failed" | null {
  if (signal) return "failed";
  if (exitCode === null) return null;
  return exitCode === 0 ? "completed" : "failed";
}

function replayIssueProjection(
  db: Database,
  event: TelemetryEnvelope,
  index: EventIndexInput,
): void {
  if (event.type === "exception" && event.message) {
    upsertIssue(db, {
      project_id: index.project_id ?? undefined,
      level: event.severity ?? "error",
      service: stringAttribute(objectRecord(event.attributes), "service"),
      message: event.message,
      stack_trace:
        stringAttribute(objectRecord(event.attributes), "stack_trace") ??
        stringAttribute(objectRecord(event.body), "stack_trace"),
    });
    return;
  }
  if (
    event.type !== "log" ||
    !index.project_id ||
    !event.message ||
    !index.severity ||
    !["warn", "error", "fatal"].includes(index.severity)
  )
    return;
  const log = objectRecord(event.body?.log);
  upsertIssue(db, {
    project_id: index.project_id,
    level: index.severity,
    service:
      stringAttribute(log, "service") ??
      stringAttribute(objectRecord(event.attributes), "service"),
    message: event.message,
    stack_trace: stringAttribute(log, "stack_trace"),
  });
}

function metadataFromEnvelope(
  event: TelemetryEnvelope,
): Record<string, unknown> | null {
  const attrs = objectRecord(event.attributes);
  const body = objectRecord(event.body);
  const log = objectRecord(body.log);
  const logMetadata = objectRecord(log.metadata);
  if (event.type === "log")
    return Object.keys(logMetadata).length > 0 ? logMetadata : null;

  const processBody = objectRecord(body.process);
  if (Object.keys(processBody).length > 0) return { ...attrs, ...processBody };

  const chunkBody = objectRecord(body.process_stream_chunk);
  if (Object.keys(chunkBody).length > 0) return { ...attrs, ...chunkBody };

  const lifecycleBody = objectRecord(body.lifecycle);
  if (Object.keys(lifecycleBody).length > 0)
    return { ...attrs, ...lifecycleBody };

  const testReportBody = objectRecord(body.test_report);
  if (Object.keys(testReportBody).length > 0)
    return sanitizedTestReportMetadata(testReportBody, attrs, attrs);

  const artifactBody = objectRecord(body.artifact);
  if (Object.keys(artifactBody).length > 0)
    return sanitizedArtifactMetadata({ ...artifactBody, ...attrs });

  if (event.type === "artifact" && Object.keys(body).length > 0)
    return sanitizedArtifactMetadata({ ...body, ...attrs });

  if (event.type === "artifact" && Object.keys(attrs).length > 0)
    return sanitizedArtifactMetadata(attrs);

  return Object.keys(attrs).length > 0 ? attrs : null;
}

function sanitizedArtifactMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const output = { ...metadata };
  if ("source_map" in output) {
    const sourceMap = sanitizeSourceMapTelemetry(output.source_map);
    if (sourceMap) output.source_map = sourceMap;
    else output.source_map = undefined;
  }
  return sanitizeSourceMapArtifactRecord(output);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseJsonRecord(
  value: string | null | undefined,
): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return objectRecord(parsed);
  } catch {
    return {};
  }
}

function stringAttribute(
  attrs: Record<string, unknown>,
  key: string,
): string | null {
  const value = attrs[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint")
    return String(value);
  return null;
}

function numberAttribute(
  attrs: Record<string, unknown>,
  key: string,
): number | null {
  const value = attrs[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function commandString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.map((item) =>
      typeof item === "string" ||
      typeof item === "number" ||
      typeof item === "bigint"
        ? String(item)
        : null,
    );
    return parts.every(Boolean) ? parts.join(" ") : null;
  }
  return null;
}

function normalizeLogLevel(
  value: string | null,
): "debug" | "info" | "warn" | "error" | "fatal" {
  if (
    value === "debug" ||
    value === "info" ||
    value === "warn" ||
    value === "error" ||
    value === "fatal"
  )
    return value;
  return "info";
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

function sealSegment(db: Database, segmentId: string): void {
  const segment = db
    .prepare("SELECT relative_path FROM event_segments WHERE id = ?")
    .get(segmentId) as { relative_path: string } | undefined;
  const segmentHash = segment
    ? sha256(readFileSync(resolveDataPath(db, segment.relative_path)))
    : null;
  db.prepare(`
    UPDATE event_segments
    SET sealed_at = COALESCE(sealed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        segment_hash = COALESCE(?, segment_hash),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(segmentHash, segmentId);
  writeSegmentManifest(db, segmentId);
}

function appendAndFlush(path: string, bytes: Buffer): void {
  const fd = openSync(path, "a");
  try {
    let written = 0;
    while (written < bytes.byteLength) {
      const n = writeSync(fd, bytes, written, bytes.byteLength - written);
      if (n <= 0) throw new Error(`Failed to append bytes to ${path}`);
      written += n;
    }
    if (shouldFsync()) {
      fsyncSync(fd);
    }
  } finally {
    closeSync(fd);
  }
}

export function withEventStoreLock<T>(db: Database, fn: () => T): T {
  const depth = dbLockDepths.get(db) ?? 0;
  if (depth > 0) {
    dbLockDepths.set(db, depth + 1);
    try {
      return fn();
    } finally {
      const nextDepth = (dbLockDepths.get(db) ?? 1) - 1;
      if (nextDepth > 0) dbLockDepths.set(db, nextDepth);
      else dbLockDepths.delete(db);
    }
  }

  const lockRoot = resolveDataPath(db, ".locks");
  const lockDir = resolveDataPath(db, ".locks/segments.lock");
  mkdirSync(lockRoot, { recursive: true });

  const timeoutMs = readPositiveIntEnv("HASNA_LOGS_LOCK_TIMEOUT_MS", 10_000);
  const staleMs = readPositiveIntEnv("HASNA_LOGS_LOCK_STALE_MS", 120_000);
  const start = Date.now();

  while (true) {
    try {
      mkdirSync(lockDir);
      writeFileSync(
        join(lockDir, "owner.json"),
        `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`,
        "utf8",
      );
      break;
    } catch (error) {
      if (!isFileExistsError(error)) throw error;

      try {
        const ageMs = Date.now() - statSync(lockDir).mtimeMs;
        if (ageMs > staleMs) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // If the lock disappeared between mkdir attempts, retry immediately.
        continue;
      }

      if (Date.now() - start > timeoutMs) {
        throw new Error(`Timed out waiting for event store lock: ${lockDir}`);
      }
      sleepSync(20);
    }
  }

  try {
    dbLockDepths.set(db, 1);
    return fn();
  } finally {
    dbLockDepths.delete(db);
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isFileExistsError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "EEXIST",
  );
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function getMaxSegmentBytes(): number {
  const configured =
    process.env.HASNA_LOGS_SEGMENT_MAX_BYTES ??
    process.env.OPEN_LOGS_SEGMENT_MAX_BYTES;
  const parsed = configured
    ? Number.parseInt(configured, 10)
    : 64 * 1024 * 1024;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 64 * 1024 * 1024;
}

function shouldFsync(): boolean {
  return (
    process.env.HASNA_LOGS_FSYNC !== "0" && process.env.OPEN_LOGS_FSYNC !== "0"
  );
}

function shouldHashSegmentOnAppend(): boolean {
  return (
    process.env.HASNA_LOGS_SEGMENT_HASH_ON_APPEND !== "0" &&
    process.env.OPEN_LOGS_SEGMENT_HASH_ON_APPEND !== "0"
  );
}

function resolveDataPath(db: Database, relativePath: string): string {
  const root = resolve(getEventStoreDataDir(db));
  const fullPath = resolve(root, ...relativePath.split("/"));
  if (fullPath !== root && !fullPath.startsWith(root + sep)) {
    throw new Error(
      `Refusing to access path outside event store: ${relativePath}`,
    );
  }
  return fullPath;
}

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
