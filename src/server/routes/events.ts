import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { touchBrowserIngestToken } from "../../lib/browser-ingest-tokens.ts";
import {
  type EventCatalogBusEvent,
  type EventCatalogStreamFilter,
  hasBufferedEventCatalogEvent,
  subscribeEventCatalogEvents,
} from "../../lib/event-bus.ts";
import {
  type EventCatalogQuery,
  exportEventsToJson,
  getEvent,
  searchEvents,
} from "../../lib/events.ts";
import {
  type UniversalEventInput,
  ingestUniversalEvent,
  validateUniversalEventInput,
} from "../../lib/universal-ingest.ts";
import { type LogIngestAuthorization, authorizeLogIngest } from "../auth.ts";
import { readPositiveInt } from "../request.ts";

type EventRecordCursor = { rowid: number; event_id: string };
type StreamEventNameMode = "type" | "event";
type SseMessage = { data: string; event?: string; id?: string };
type SseWriter = { writeSSE: (message: SseMessage) => Promise<void> };

export function eventsRoutes(db: Database) {
  const app = new Hono();

  // POST /api/events — ingest one universal telemetry event or a batch.
  app.post("/", async (c) => {
    const parsed = await readEventIngestBody(db, c);
    if (!parsed.ok) return c.json({ error: parsed.message }, parsed.status);

    try {
      if (!parsed.batch && parsed.events.length === 1) {
        const [event] = parsed.events;
        if (!event)
          return c.json({ error: "body must contain at least one event" }, 422);
        const result = ingestUniversalEvent(db, event);
        if (parsed.authorization.kind === "browser-token")
          touchBrowserIngestToken(db, parsed.authorization.token.id);
        return c.json(result.event, result.inserted ? 201 : 200);
      }

      const results = parsed.events.map((event) =>
        ingestUniversalEvent(db, event),
      );
      if (parsed.authorization.kind === "browser-token")
        touchBrowserIngestToken(db, parsed.authorization.token.id);
      return c.json(
        {
          inserted: results.filter((result) => result.inserted).length,
          events: results.map((result) => result.event),
        },
        201,
      );
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        422,
      );
    }
  });

  // GET /api/events?type=&source=&severity=&project_id=&trace_id=&text=&include_raw=
  app.get("/", (c) => {
    return c.json(searchEvents(db, queryFromRequest(c.req.query())));
  });

  // GET /api/events/export?type=&source=&format=json
  app.get("/export", (c) => {
    const query = queryFromRequest(c.req.query());
    const chunks: string[] = [];
    exportEventsToJson(db, query, (line) => chunks.push(line));
    c.header("Content-Type", "application/json");
    c.header("Content-Disposition", "attachment; filename=events.json");
    return c.text(chunks.join("\n"));
  });

  // GET /api/events/stream?type=&source=&severity=&trace_id=&last_event_id=
  app.get("/stream", (c) => {
    const query = c.req.query();
    const filter = streamFilterFromRequest(query);
    const includeRaw = query.include_raw === "true";
    const eventNameMode = query.event_name === "event" ? "event" : "type";
    const requestedLastId =
      c.req.header("last-event-id") || query.last_event_id || null;
    const debugOptions = streamDebugOptionsFromRequest(query);

    return streamSSE(c, async (stream) => {
      const writer =
        debugOptions.writeDelayMs > 0
          ? delayedSseWriter(stream, debugOptions.writeDelayMs)
          : stream;
      const seen = new Set<string>();
      let lastId = requestedLastId;
      let rowidCursor: number | null = null;

      if (lastId) {
        const anchor = eventCursorById(db, lastId);
        if (!anchor) {
          const requestedLastId = lastId;
          const latest = latestEventCursor(db, filter);
          lastId = latest?.event_id ?? null;
          rowidCursor = latest?.rowid ?? 0;
          await writeEventOverflow(writer, {
            reason: "last_event_id_unknown",
            dropped: 0,
            last_event_id: lastId,
            requested_last_event_id: requestedLastId,
          });
        } else {
          if (!hasBufferedEventCatalogEvent(lastId)) {
            await writeEventOverflow(writer, {
              reason: "buffer_miss_sqlite_catchup",
              dropped: 0,
              last_event_id: lastId,
            });
          }
          const catchup = await writeCatchupEventsAfterRowid(
            db,
            writer,
            filter,
            anchor.rowid,
            seen,
            includeRaw,
            eventNameMode,
          );
          rowidCursor = catchup.last_rowid;
          if (catchup.last_id) {
            lastId = catchup.last_id;
          }
        }
      } else {
        const latest = latestEventCursor(db, filter);
        lastId = latest?.event_id ?? null;
        rowidCursor = latest?.rowid ?? 0;
      }

      const subscription = subscribeEventCatalogEvents(
        filter,
        debugOptions.subscriberQueue
          ? { maxQueue: debugOptions.subscriberQueue }
          : undefined,
      );
      let pendingBusEvent = subscription.next();
      try {
        while (true) {
          const next = await Promise.race([
            pendingBusEvent.then((result) => ({
              kind: "bus" as const,
              result,
            })),
            sleep(500).then(() => ({ kind: "tick" as const })),
          ]);

          if (next.kind === "tick") {
            const catchup = await writeCatchupEventsAfterRowid(
              db,
              writer,
              filter,
              rowidCursor ?? 0,
              seen,
              includeRaw,
              eventNameMode,
            );
            rowidCursor = catchup.last_rowid;
            if (catchup.last_id) lastId = catchup.last_id;
            continue;
          }

          if (next.result.done) break;
          const event = next.result.value;
          pendingBusEvent = subscription.next();
          if (event.kind === "overflow") {
            await writeEventOverflow(writer, event);
            const catchup = await writeCatchupEventsAfterRowid(
              db,
              writer,
              filter,
              rowidCursor ?? 0,
              seen,
              includeRaw,
              eventNameMode,
            );
            rowidCursor = catchup.last_rowid;
            if (catchup.last_id) lastId = catchup.last_id;
            continue;
          }

          const catchup = await writeCatchupEventsAfterRowid(
            db,
            writer,
            filter,
            rowidCursor ?? 0,
            seen,
            includeRaw,
            eventNameMode,
          );
          rowidCursor = catchup.last_rowid;
          if (catchup.last_id) lastId = catchup.last_id;
          if (seen.has(event.id)) continue;
          await writeEventCatalogEntryById(
            db,
            writer,
            event.id,
            includeRaw,
            event.entry,
            eventNameMode,
          );
          seen.add(event.id);
          lastId = event.id;
          const cursor = eventCursorById(db, event.id);
          if (cursor) rowidCursor = Math.max(rowidCursor ?? 0, cursor.rowid);
          trimSeen(seen);
        }
      } finally {
        await subscription.return?.();
      }
    });
  });

  // GET /api/events/:event_id?include_raw=false
  app.get("/:event_id", (c) => {
    const includeRaw = c.req.query("include_raw") !== "false";
    const event = getEvent(db, c.req.param("event_id"), includeRaw);
    if (!event) return c.json({ error: "Event not found" }, 404);
    return c.json(event);
  });

  return app;
}

type EventBodyResult =
  | {
      ok: true;
      events: UniversalEventInput[];
      batch: boolean;
      authorization: LogIngestAuthorization;
    }
  | { ok: false; status: 400 | 401 | 413 | 415 | 422; message: string };

async function readEventIngestBody(
  db: Database,
  c: Context,
): Promise<EventBodyResult> {
  const authorization = authorizeLogIngest(db, c);
  if (!authorization) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }

  const request = c.req.raw;
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
    raw = await request.text();
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

  const maxBatchSize = readPositiveInt(
    "HASNA_LOGS_MAX_EVENT_BATCH_SIZE",
    readPositiveInt("HASNA_LOGS_MAX_BATCH_SIZE", 1_000),
  );
  const batch =
    Array.isArray(body) ||
    Boolean(
      body &&
        typeof body === "object" &&
        !Array.isArray(body) &&
        Array.isArray((body as { events?: unknown }).events),
    );
  const rawEvents = Array.isArray(body) ? body : eventArrayFromObject(body);
  if (rawEvents.length > maxBatchSize) {
    return {
      ok: false,
      status: 413,
      message: `Batch exceeds ${maxBatchSize} events`,
    };
  }
  if (rawEvents.length === 0) {
    return {
      ok: false,
      status: 422,
      message: "body must contain at least one event",
    };
  }

  try {
    const events = rawEvents.map((event, index) => {
      const validated = validateUniversalEventInput(event, `event[${index}]`);
      return applyEventIngestAuthorization(
        validated,
        authorization,
        `event[${index}]`,
      );
    });
    return { ok: true, events, batch, authorization };
  } catch (error) {
    return {
      ok: false,
      status: 422,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

const BROWSER_EVENT_TYPES = new Set([
  "log",
  "exception",
  "span",
  "metric",
  "network",
  "replay",
  "session",
]);
const BROWSER_FORBIDDEN_IDENTITY_FIELDS = [
  "project_id",
  "page_id",
  "machine_id",
  "repo_id",
  "process_id",
  "run_id",
  "artifact_id",
] as const;
const BROWSER_FORBIDDEN_IDENTITY_FIELD_SET = new Set<string>(
  BROWSER_FORBIDDEN_IDENTITY_FIELDS,
);

function applyEventIngestAuthorization(
  event: UniversalEventInput,
  authorization: LogIngestAuthorization,
  path: string,
): UniversalEventInput {
  if (authorization.kind !== "browser-token") return event;
  if (!BROWSER_EVENT_TYPES.has(event.type)) {
    throw new Error(
      `${path}.type cannot be ${event.type} when using a browser ingest token`,
    );
  }
  if (
    event.source !== undefined &&
    event.source !== "script" &&
    event.source !== "browser"
  ) {
    throw new Error(
      `${path}.source must be script or browser when using a browser ingest token`,
    );
  }
  for (const field of BROWSER_FORBIDDEN_IDENTITY_FIELDS) {
    if (event[field] !== undefined && event[field] !== null) {
      throw new Error(
        `${path}.${field} cannot be set when using a browser ingest token`,
      );
    }
  }
  rejectBrowserScopedIdentity(event.attributes, `${path}.attributes`);
  rejectBrowserScopedIdentity(event.metadata, `${path}.metadata`);
  const browserMetadata = {
    browser_token_id: authorization.token.id,
    browser_token_prefix: authorization.token.token_prefix,
    ingest_scope: "browser",
  };
  const producerId =
    event.event_id ?? event.id ?? event.source_event_id ?? undefined;
  const source = event.source ?? "browser";
  return {
    ...event,
    event_id: producerId
      ? browserScopedEventId(authorization.token.project_id, source, producerId)
      : undefined,
    source_event_id:
      event.source_event_id ?? event.event_id ?? event.id ?? undefined,
    project_id: authorization.token.project_id,
    source,
    attributes: {
      ...(event.attributes ?? {}),
      ...browserMetadata,
      project_id: authorization.token.project_id,
    },
    metadata: {
      ...(event.metadata ?? {}),
      ...browserMetadata,
    },
  };
}

function browserScopedEventId(
  projectId: string,
  source: string,
  producerId: string,
): string {
  const digest = createHash("sha256")
    .update(projectId)
    .update("\0")
    .update(source)
    .update("\0")
    .update(producerId)
    .digest("hex")
    .slice(0, 32);
  return `evt_browser_${digest}`;
}

function rejectBrowserScopedIdentity(
  value: Record<string, unknown> | undefined,
  path: string,
): void {
  if (!value) return;
  for (const key of Object.keys(value)) {
    if (
      BROWSER_FORBIDDEN_IDENTITY_FIELD_SET.has(key) &&
      value[key] !== undefined &&
      value[key] !== null
    ) {
      throw new Error(
        `${path}.${key} cannot be set when using a browser ingest token`,
      );
    }
  }
}

async function writeCatchupEventsAfterRowid(
  db: Database,
  stream: SseWriter,
  filter: EventCatalogStreamFilter,
  afterRowid: number,
  seen: Set<string>,
  includeRaw: boolean,
  eventNameMode: StreamEventNameMode,
): Promise<{ last_id: string | null; last_rowid: number }> {
  let cursor = afterRowid;
  let lastWritten: string | null = null;
  let total = 0;
  while (total < 1_000) {
    const rows = queryEventsAfterRowid(db, filter, cursor, 100);
    if (rows.length === 0) break;
    for (const row of rows) {
      cursor = row.rowid;
      if (seen.has(row.event_id)) continue;
      const written = await writeEventCatalogEntryById(
        db,
        stream,
        row.event_id,
        includeRaw,
        undefined,
        eventNameMode,
      );
      if (!written) continue;
      seen.add(row.event_id);
      lastWritten = row.event_id;
      total += 1;
      trimSeen(seen);
    }
    if (rows.length < 100) break;
  }
  if (total >= 1_000) {
    await writeEventOverflow(stream, {
      reason: "sqlite_catchup_truncated",
      dropped: 0,
      last_event_id: lastWritten,
    });
  }
  return { last_id: lastWritten, last_rowid: cursor };
}

function latestEventCursor(
  db: Database,
  filter: EventCatalogStreamFilter,
): EventRecordCursor | null {
  const { where, params } = buildEventRecordWhere(filter, null);
  const row = db
    .prepare(
      `SELECT rowid, event_id FROM event_records ${where} ORDER BY rowid DESC LIMIT 1`,
    )
    .get(...params) as EventRecordCursor | null;
  return row ?? null;
}

function eventCursorById(
  db: Database,
  eventId: string,
): EventRecordCursor | null {
  const row = db
    .prepare("SELECT rowid, event_id FROM event_records WHERE event_id = ?")
    .get(eventId) as EventRecordCursor | null;
  return row ?? null;
}

function queryEventsAfterRowid(
  db: Database,
  filter: EventCatalogStreamFilter,
  rowid: number,
  limit: number,
): EventRecordCursor[] {
  const { where, params } = buildEventRecordWhere(filter, rowid);
  return db
    .prepare(
      `SELECT rowid, event_id FROM event_records ${where} ORDER BY rowid ASC LIMIT ?`,
    )
    .all(...params, limit) as EventRecordCursor[];
}

function buildEventRecordWhere(
  filter: EventCatalogStreamFilter,
  afterRowid: number | null,
): { where: string; params: Array<string | number> } {
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (afterRowid !== null) {
    conditions.push("rowid > ?");
    params.push(afterRowid);
  }
  addListCondition(conditions, params, "event_type", filter.event_type);
  addListCondition(conditions, params, "source", filter.source);
  addListCondition(conditions, params, "severity", filter.severity);
  addScalarCondition(conditions, params, "project_id", filter.project_id);
  addScalarCondition(conditions, params, "page_id", filter.page_id);
  addScalarCondition(conditions, params, "machine_id", filter.machine_id);
  addScalarCondition(conditions, params, "repo_id", filter.repo_id);
  addScalarCondition(conditions, params, "app_id", filter.app_id);
  addScalarCondition(conditions, params, "process_id", filter.process_id);
  addScalarCondition(conditions, params, "run_id", filter.run_id);
  addScalarCondition(conditions, params, "trace_id", filter.trace_id);
  addScalarCondition(conditions, params, "span_id", filter.span_id);
  addScalarCondition(conditions, params, "session_id", filter.session_id);
  addScalarCondition(conditions, params, "release_id", filter.release_id);
  addScalarCondition(conditions, params, "environment", filter.environment);

  return {
    where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

function streamFilterFromRequest(
  query: Record<string, string>,
): EventCatalogStreamFilter {
  return {
    event_type: splitCsv(query.type || query.event_type),
    source: splitCsv(query.source),
    severity: splitCsv(query.severity || query.level),
    project_id: query.project_id || undefined,
    page_id: query.page_id || undefined,
    machine_id: query.machine_id || undefined,
    repo_id: query.repo_id || undefined,
    app_id: query.app_id || undefined,
    process_id: query.process_id || undefined,
    run_id: query.run_id || undefined,
    trace_id: query.trace_id || undefined,
    span_id: query.span_id || undefined,
    session_id: query.session_id || undefined,
    release_id: query.release_id || undefined,
    environment: query.environment || undefined,
  };
}

function splitCsv(value: string | undefined): string[] | undefined {
  const values =
    value
      ?.split(",")
      .map((item) => item.trim())
      .filter(Boolean) ?? [];
  return values.length > 0 ? values : undefined;
}

function streamDebugOptionsFromRequest(query: Record<string, string>): {
  subscriberQueue?: number;
  writeDelayMs: number;
} {
  if (process.env.HASNA_LOGS_STREAM_TEST_HOOKS !== "1") {
    return { writeDelayMs: 0 };
  }

  return {
    subscriberQueue: boundedIntQuery(query.debug_subscriber_queue, {
      min: 1,
      max: 10_000,
    }),
    writeDelayMs:
      boundedIntQuery(query.debug_write_delay_ms, { min: 0, max: 5_000 }) ?? 0,
  };
}

function boundedIntQuery(
  value: string | undefined,
  bounds: { min: number; max: number },
): number | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < bounds.min) return undefined;
  return Math.min(parsed, bounds.max);
}

function delayedSseWriter(stream: SseWriter, delayMs: number): SseWriter {
  return {
    async writeSSE(message) {
      await sleep(delayMs);
      await stream.writeSSE(message);
    },
  };
}

function addScalarCondition(
  conditions: string[],
  params: Array<string | number>,
  column: string,
  value: string | undefined,
): void {
  if (!value) return;
  conditions.push(`${column} = ?`);
  params.push(value);
}

function addListCondition(
  conditions: string[],
  params: Array<string | number>,
  column: string,
  values: string[] | undefined,
): void {
  if (!values || values.length === 0) return;
  conditions.push(`${column} IN (${values.map(() => "?").join(",")})`);
  params.push(...values);
}

async function writeEventCatalogEntry(
  stream: SseWriter,
  entry: NonNullable<ReturnType<typeof getEvent>>,
  eventNameMode: StreamEventNameMode,
): Promise<void> {
  await stream.writeSSE({
    data: JSON.stringify(entry),
    id: entry.event_id,
    event: eventNameMode === "event" ? "event" : entry.event_type,
  });
}

async function writeEventCatalogEntryById(
  db: Database,
  stream: SseWriter,
  eventId: string,
  includeRaw: boolean,
  fallback?: NonNullable<ReturnType<typeof getEvent>>,
  eventNameMode: StreamEventNameMode = "type",
): Promise<boolean> {
  try {
    const entry = includeRaw
      ? getEvent(db, eventId, true)
      : (fallback ?? getEvent(db, eventId, false));
    if (!entry) return false;
    await writeEventCatalogEntry(stream, entry, eventNameMode);
    return true;
  } catch (error) {
    await writeEventOverflow(stream, {
      reason: "raw_event_unreadable",
      dropped: 0,
      last_event_id: eventId,
    });
    const entry = fallback ?? getEvent(db, eventId, false);
    if (!entry) return false;
    await writeEventCatalogEntry(stream, entry, eventNameMode);
    return true;
  }
}

async function writeEventOverflow(
  stream: SseWriter,
  data:
    | {
        reason: string;
        dropped: number;
        last_event_id?: string | null;
        requested_last_event_id?: string | null;
      }
    | Extract<EventCatalogBusEvent, { kind: "overflow" }>,
): Promise<void> {
  await stream.writeSSE({
    event: "overflow",
    data: JSON.stringify({
      type: "overflow",
      reason: data.reason,
      dropped: data.dropped,
      last_event_id: "last_event_id" in data ? data.last_event_id : null,
      requested_last_event_id:
        "requested_last_event_id" in data ? data.requested_last_event_id : null,
      created_at:
        "created_at" in data ? data.created_at : new Date().toISOString(),
    }),
  });
}

function trimSeen(seen: Set<string>): void {
  while (seen.size > 2_000) {
    const first = seen.values().next().value;
    if (!first) return;
    seen.delete(first);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function eventArrayFromObject(body: unknown): unknown[] {
  if (
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    Array.isArray((body as { events?: unknown }).events)
  ) {
    return (body as { events: unknown[] }).events;
  }
  return [body];
}

function queryFromRequest(query: Record<string, string>): EventCatalogQuery {
  return {
    event_type: query.type || query.event_type || undefined,
    source: query.source || undefined,
    severity: query.severity || query.level || undefined,
    project_id: query.project_id || undefined,
    page_id: query.page_id || undefined,
    machine_id: query.machine_id || undefined,
    repo_id: query.repo_id || undefined,
    app_id: query.app_id || undefined,
    process_id: query.process_id || undefined,
    run_id: query.run_id || undefined,
    trace_id: query.trace_id || undefined,
    span_id: query.span_id || undefined,
    session_id: query.session_id || undefined,
    release_id: query.release_id || undefined,
    environment: query.environment || undefined,
    since: query.since || undefined,
    until: query.until || undefined,
    text: query.text || undefined,
    limit: query.limit ? Number(query.limit) : 100,
    offset: query.offset ? Number(query.offset) : 0,
    include_raw: query.include_raw === "true",
  };
}
