import type { Database } from "bun:sqlite";
import {
  type EventRecord,
  type TelemetryEnvelope,
  getEventRecord,
  readRawEvent,
} from "./event-store.ts";
import { parseTime } from "./parse-time.ts";

export interface EventCatalogQuery {
  event_id?: string;
  event_type?: string | string[];
  source?: string | string[];
  severity?: string | string[];
  project_id?: string;
  page_id?: string;
  machine_id?: string;
  repo_id?: string;
  app_id?: string;
  process_id?: string;
  run_id?: string;
  trace_id?: string;
  span_id?: string;
  session_id?: string;
  release_id?: string;
  environment?: string;
  since?: string;
  until?: string;
  text?: string;
  limit?: number;
  offset?: number;
  include_raw?: boolean;
  exclude_mcp_tool_telemetry?: boolean;
  max_limit?: number;
}

export type EventCatalogEntry = Omit<EventRecord, "metadata"> & {
  metadata: Record<string, unknown> | null;
  raw?: TelemetryEnvelope | null;
};

export function searchEvents(
  db: Database,
  query: EventCatalogQuery = {},
): EventCatalogEntry[] {
  const { where, params } = buildEventWhere(query);
  const limit = clampPositiveInt(query.limit, 100, query.max_limit ?? 1_000);
  const offset = clampNonNegativeInt(query.offset, 0);
  const rows = db
    .query(`
    SELECT *
    FROM event_records
    ${where}
    ORDER BY event_time DESC, event_id DESC
    LIMIT ? OFFSET ?
  `)
    .all(...params, limit, offset) as EventRecord[];

  return rows.map((row) =>
    materializeEvent(db, row, query.include_raw === true),
  );
}

export function getEvent(
  db: Database,
  eventId: string,
  includeRaw = true,
): EventCatalogEntry | null {
  const record = getEventRecord(db, eventId);
  return record ? materializeEvent(db, record, includeRaw) : null;
}

export function exportEventsToJson(
  db: Database,
  query: EventCatalogQuery,
  writeLine: (line: string) => void,
): number {
  writeLine("[");
  let count = 0;
  for (const event of searchEvents(db, {
    ...query,
    limit: query.limit ?? 100_000,
    max_limit: 100_000,
  })) {
    writeLine((count > 0 ? "," : "") + JSON.stringify(event));
    count += 1;
  }
  writeLine("]");
  return count;
}

function materializeEvent(
  db: Database,
  record: EventRecord,
  includeRaw: boolean,
): EventCatalogEntry {
  const { metadata, ...rest } = record;
  return {
    ...rest,
    metadata: parseMetadata(metadata),
    raw: includeRaw ? readRawEvent(db, record) : undefined,
  };
}

function buildEventWhere(query: EventCatalogQuery): {
  where: string;
  params: Array<string | number>;
} {
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  addScalar(conditions, params, "event_id", query.event_id);
  addList(conditions, params, "event_type", query.event_type);
  addList(conditions, params, "source", query.source);
  addList(conditions, params, "severity", query.severity);
  addScalar(conditions, params, "project_id", query.project_id);
  addScalar(conditions, params, "page_id", query.page_id);
  addScalar(conditions, params, "machine_id", query.machine_id);
  addScalar(conditions, params, "repo_id", query.repo_id);
  addScalar(conditions, params, "app_id", query.app_id);
  addScalar(conditions, params, "process_id", query.process_id);
  addScalar(conditions, params, "run_id", query.run_id);
  addScalar(conditions, params, "trace_id", query.trace_id);
  addScalar(conditions, params, "span_id", query.span_id);
  addScalar(conditions, params, "session_id", query.session_id);
  addScalar(conditions, params, "release_id", query.release_id);
  addScalar(conditions, params, "environment", query.environment);

  if (query.since) {
    conditions.push("event_time >= ?");
    params.push(parseTime(query.since) ?? query.since);
  }
  if (query.until) {
    conditions.push("event_time <= ?");
    params.push(parseTime(query.until) ?? query.until);
  }
  if (query.text) {
    const needle = `%${escapeLike(query.text)}%`;
    conditions.push(
      "(event_id LIKE ? ESCAPE '\\' OR source_event_id LIKE ? ESCAPE '\\' OR message LIKE ? ESCAPE '\\' OR metadata LIKE ? ESCAPE '\\')",
    );
    params.push(needle, needle, needle, needle);
  }
  if (query.exclude_mcp_tool_telemetry) {
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

function addScalar(
  conditions: string[],
  params: Array<string | number>,
  column: string,
  value: string | undefined,
): void {
  if (!value) return;
  conditions.push(`${column} = ?`);
  params.push(value);
}

function addList(
  conditions: string[],
  params: Array<string | number>,
  column: string,
  value: string | string[] | undefined,
): void {
  if (!value) return;
  const values = (Array.isArray(value) ? value : value.split(","))
    .map((item) => item.trim())
    .filter(Boolean);
  if (values.length === 0) return;
  conditions.push(`${column} IN (${values.map(() => "?").join(",")})`);
  params.push(...values);
}

function parseMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function clampPositiveInt(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.min(Math.max(1, Math.floor(value)), max);
}

function clampNonNegativeInt(
  value: number | undefined,
  fallback: number,
): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(0, Math.floor(value));
}
