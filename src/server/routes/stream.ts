import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  type LogBusEvent,
  type LogStreamFilter,
  hasBufferedLogEvent,
  subscribeLogEvents,
} from "../../lib/event-bus.ts";
import type { LogLevel, LogRow } from "../../types/index.ts";

type LogRowWithRowid = LogRow & { rowid: number };

export function streamRoutes(db: Database) {
  const app = new Hono();

  // GET /api/logs/stream?project_id=&level=&service=&last_event_id=
  app.get("/", (c) => {
    const { project_id, level, service, last_event_id } = c.req.query();
    const filter: LogStreamFilter = {
      project_id: project_id || undefined,
      levels: level
        ? (level.split(",").filter(Boolean) as LogLevel[])
        : undefined,
      service: service || undefined,
    };
    const requestedLastId =
      c.req.header("last-event-id") || last_event_id || null;

    return streamSSE(c, async (stream) => {
      const seen = new Set<string>();
      let lastId = requestedLastId;

      if (lastId) {
        if (!logIdExists(db, lastId)) {
          const requestedLastId = lastId;
          lastId = latestLogId(db, filter);
          await writeOverflow(stream, {
            reason: "last_event_id_unknown",
            dropped: 0,
            last_event_id: lastId,
            requested_last_event_id: requestedLastId,
          });
        } else {
          if (!hasBufferedLogEvent(lastId)) {
            await writeOverflow(stream, {
              reason: "buffer_miss_sqlite_catchup",
              dropped: 0,
              last_event_id: lastId,
            });
          }
          const catchup = await writeCatchupRows(
            db,
            stream,
            filter,
            lastId,
            seen,
          );
          if (catchup.last_id) {
            lastId = catchup.last_id;
          }
        }
      } else {
        lastId = latestLogId(db, filter);
      }

      const subscription = subscribeLogEvents(filter);
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
            if (!lastId) {
              lastId = latestLogId(db, filter);
              continue;
            }
            const catchup = await writeCatchupRows(
              db,
              stream,
              filter,
              lastId,
              seen,
            );
            if (catchup.last_id) lastId = catchup.last_id;
            continue;
          }

          if (next.result.done) break;
          const event = next.result.value;
          pendingBusEvent = subscription.next();
          if (event.kind === "overflow") {
            await writeOverflow(stream, event);
            if (lastId) {
              const catchup = await writeCatchupRows(
                db,
                stream,
                filter,
                lastId,
                seen,
              );
              if (catchup.last_id) lastId = catchup.last_id;
            }
            continue;
          }

          if (seen.has(event.id)) continue;
          await writeLogRow(stream, event.row);
          seen.add(event.id);
          lastId = event.id;
          trimSeen(seen);
        }
      } finally {
        await subscription.return?.();
      }
    });
  });

  return app;
}

async function writeCatchupRows(
  db: Database,
  stream: {
    writeSSE: (message: {
      data: string;
      event?: string;
      id?: string;
    }) => Promise<void>;
  },
  filter: LogStreamFilter,
  lastId: string,
  seen: Set<string>,
): Promise<{ anchor_found: boolean; last_id: string | null }> {
  const anchor = db
    .prepare("SELECT rowid FROM logs WHERE id = ?")
    .get(lastId) as { rowid: number } | null;
  if (!anchor) return { anchor_found: false, last_id: null };

  let cursor = anchor.rowid;
  let lastWritten: string | null = null;
  let total = 0;
  while (total < 1_000) {
    const rows = queryRowsAfterRowid(db, filter, cursor, 100);
    if (rows.length === 0) break;
    for (const row of rows) {
      cursor = row.rowid;
      if (seen.has(row.id)) continue;
      await writeLogRow(stream, row);
      seen.add(row.id);
      lastWritten = row.id;
      total += 1;
      trimSeen(seen);
    }
    if (rows.length < 100) break;
  }
  if (total >= 1_000) {
    await writeOverflow(stream, {
      reason: "sqlite_catchup_truncated",
      dropped: 0,
      last_event_id: lastWritten ?? lastId,
    });
  }
  return { anchor_found: true, last_id: lastWritten };
}

function latestLogId(db: Database, filter: LogStreamFilter): string | null {
  const { where, params } = buildWhere(filter, null);
  const row = db
    .prepare(`SELECT id FROM logs ${where} ORDER BY rowid DESC LIMIT 1`)
    .get(params) as { id: string } | null;
  return row?.id ?? null;
}

function logIdExists(db: Database, id: string): boolean {
  const row = db
    .prepare("SELECT 1 AS found FROM logs WHERE id = ?")
    .get(id) as { found: number } | null;
  return Boolean(row);
}

function queryRowsAfterRowid(
  db: Database,
  filter: LogStreamFilter,
  rowid: number,
  limit: number,
): LogRowWithRowid[] {
  const { where, params } = buildWhere(filter, rowid);
  return db
    .prepare(
      `SELECT rowid, * FROM logs ${where} ORDER BY rowid ASC LIMIT $limit`,
    )
    .all({ ...params, $limit: limit }) as LogRowWithRowid[];
}

function buildWhere(
  filter: LogStreamFilter,
  afterRowid: number | null,
): { where: string; params: Record<string, string | number | null> } {
  const conditions: string[] = [];
  const params: Record<string, string | number | null> = {};

  if (afterRowid !== null) {
    conditions.push("rowid > $rowid");
    params.$rowid = afterRowid;
  }
  if (filter.project_id) {
    conditions.push("project_id = $project_id");
    params.$project_id = filter.project_id;
  }
  if (filter.levels && filter.levels.length > 0) {
    const placeholders = filter.levels
      .map((_, index) => `$level${index}`)
      .join(",");
    filter.levels.forEach((level, index) => {
      params[`$level${index}`] = level;
    });
    conditions.push(`level IN (${placeholders})`);
  }
  if (filter.service) {
    conditions.push("service = $service");
    params.$service = filter.service;
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

async function writeLogRow(
  stream: {
    writeSSE: (message: {
      data: string;
      event?: string;
      id?: string;
    }) => Promise<void>;
  },
  row: LogRow,
): Promise<void> {
  await stream.writeSSE({
    data: JSON.stringify(row),
    id: row.id,
    event: row.level,
  });
}

async function writeOverflow(
  stream: {
    writeSSE: (message: {
      data: string;
      event?: string;
      id?: string;
    }) => Promise<void>;
  },
  data:
    | {
        reason: string;
        dropped: number;
        last_event_id?: string | null;
        requested_last_event_id?: string | null;
      }
    | Extract<LogBusEvent, { kind: "overflow" }>,
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
