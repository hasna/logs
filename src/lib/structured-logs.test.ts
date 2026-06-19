import { describe, expect, it } from "bun:test";
import { createTestDb } from "../db/index.ts";
import { readRawEvent, verifyEventStore } from "./event-store.ts";
import { searchEvents } from "./events.ts";
import {
  ingestStructuredJsonLines,
  ingestStructuredLogBatch,
  structuredLogToEntry,
} from "./structured-logs.ts";

describe("structured log ingest", () => {
  it("maps Pino records into raw-backed logs and redacts preserved originals", () => {
    const db = createTestDb();
    const secret = "OPENLOGS_SECRET_CANARY_structured_pino_12345";
    const rows = ingestStructuredLogBatch(db, {
      level: 50,
      event_id: "pino-event-1",
      time: 1781596800000,
      msg: `checkout failed token=${secret}`,
      name: "checkout-api",
      hostname: "host-a",
      pid: 4242,
      traceId: "trace-pino",
      spanId: "span-pino",
      err: {
        message: "payment unavailable",
        stack: `Error: payment unavailable ${secret}`,
      },
      token: secret,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      timestamp: "2026-06-16T08:00:00.000Z",
      level: "error",
      source: "pino",
      service: "checkout-api",
      trace_id: "trace-pino",
      stack_trace: "Error: payment unavailable [REDACTED]",
    });
    expect(rows[0]?.message).toBe("checkout failed token=[REDACTED]");

    const events = searchEvents(db, {
      event_type: "log",
      source: "pino",
      trace_id: "trace-pino",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event_type: "log",
      source: "pino",
      severity: "error",
      machine_id: "host-a",
      app_id: "checkout-api",
      span_id: "span-pino",
    });

    const raw = readRawEvent(db, rows[0]?.id ?? "");
    expect(JSON.stringify(raw)).not.toContain(secret);
    expect(JSON.stringify(raw)).toContain("[REDACTED]");

    const metadata = JSON.parse(rows[0]?.metadata ?? "{}") as {
      structured_log?: { original?: Record<string, unknown>; pid?: number };
      redaction?: unknown;
    };
    expect(metadata.structured_log?.pid).toBe(4242);
    expect(metadata.structured_log?.original?.token).toBe("[REDACTED]");
    expect(metadata.redaction).toBeTruthy();

    const retry = ingestStructuredLogBatch(db, {
      level: 50,
      event_id: "pino-event-1",
      time: 1781596800000,
      msg: `checkout failed token=${secret}`,
      name: "checkout-api",
      hostname: "host-a",
      pid: 4242,
      traceId: "trace-pino",
      spanId: "span-pino",
      err: {
        message: "payment unavailable",
        stack: `Error: payment unavailable ${secret}`,
      },
      token: secret,
    });
    expect(retry[0]?.id).toBe(rows[0]?.id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM logs").get()).toEqual({
      count: 1,
    });
  });

  it("maps Winston envelopes and preserves common correlation fields", () => {
    const db = createTestDb();
    const rows = ingestStructuredLogBatch(db, {
      format: "winston",
      service: "billing-worker",
      environment: "test",
      logs: [
        {
          level: "warn",
          timestamp: "2026-06-16T09:15:00.000Z",
          message: "invoice retry scheduled",
          trace_id: "trace-winston",
          span_id: "span-winston",
          release: "2026.06.16",
          defaultMeta: { shard: "a" },
        },
      ],
      metadata: { import_id: "winston-fixture" },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      timestamp: "2026-06-16T09:15:00.000Z",
      level: "warn",
      source: "winston",
      service: "billing-worker",
      trace_id: "trace-winston",
    });

    const event = searchEvents(db, { event_type: "log", source: "winston" })[0];
    expect(event).toMatchObject({
      environment: "test",
      release_id: "2026.06.16",
      span_id: "span-winston",
    });
    const metadata = JSON.parse(rows[0]?.metadata ?? "{}") as {
      import_id?: string;
      structured_log?: { original?: Record<string, unknown> };
    };
    expect(metadata.import_id).toBe("winston-fixture");
    expect(metadata.structured_log?.original?.defaultMeta).toEqual({
      shard: "a",
    });
  });

  it("uses JSONL line positions to preserve repeated identical records while keeping retry IDs stable", () => {
    const db = createTestDb();
    const input = [
      JSON.stringify({
        level: 30,
        time: 1781596800000,
        msg: "same line",
        name: "api",
      }),
      JSON.stringify({
        level: 30,
        time: 1781596800000,
        msg: "same line",
        name: "api",
      }),
    ].join("\n");

    const rows = ingestStructuredJsonLines(
      db,
      input,
      { format: "pino" },
      "fixture.jsonl",
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.id).not.toBe(rows[1]?.id);

    const retry = ingestStructuredJsonLines(
      db,
      input,
      { format: "pino" },
      "fixture.jsonl",
    );
    expect(retry.map((row) => row.id)).toEqual(rows.map((row) => row.id));
    expect(db.prepare("SELECT COUNT(*) AS count FROM logs").get()).toEqual({
      count: 2,
    });
  });

  it("uses SDK transport producer IDs instead of retry batch position fallback", () => {
    const first = structuredLogToEntry(
      {
        level: 30,
        msg: "transport retry",
        _open_logs_event_id: "pino_transport_1:record:2",
      },
      { format: "pino", source_event_prefix: "retry-prefix" },
      { index: 1 },
    );
    const retry = structuredLogToEntry(
      {
        level: 30,
        msg: "transport retry",
        _open_logs_event_id: "pino_transport_1:record:2",
      },
      { format: "pino", source_event_prefix: "retry-prefix" },
      { index: 0 },
    );

    expect(first.source_event_id).toBe(retry.source_event_id);
    expect(first.source_event_id).toContain("retry-prefix:pino:producer:");
  });

  it("does not collapse repeated singleton records without producer IDs", () => {
    const db = createTestDb();

    const first = ingestStructuredLogBatch(db, {
      level: "info",
      message: "heartbeat",
    });
    const second = ingestStructuredLogBatch(db, {
      level: "info",
      message: "heartbeat",
    });

    expect(first[0]?.id).not.toBe(second[0]?.id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM logs").get()).toEqual({
      count: 2,
    });
  });

  it("redacts producer IDs before raw persistence and preflights references before append", () => {
    const db = createTestDb();
    const secret = "OPENLOGS_SECRET_CANARY_structured_event_id_12345";

    const rows = ingestStructuredLogBatch(db, {
      event_id: secret,
      level: "info",
      message: "producer id should not leak",
    });
    expect(rows).toHaveLength(1);

    const raw = readRawEvent(db, rows[0]?.id ?? "");
    expect(JSON.stringify(raw)).not.toContain(secret);
    const record = db
      .prepare("SELECT source_event_id FROM event_records WHERE event_id = ?")
      .get(rows[0]?.id ?? "") as { source_event_id: string | null };
    expect(record.source_event_id ?? "").not.toContain(secret);

    expect(() =>
      ingestStructuredLogBatch(
        db,
        { level: "info", message: "missing project" },
        { project_id: "missing-project" },
      ),
    ).toThrow("project_id does not exist");
    expect(db.prepare("SELECT COUNT(*) AS count FROM logs").get()).toEqual({
      count: 1,
    });
    expect(verifyEventStore(db).unindexed_raw_events).toBe(0);
  });

  it("rejects malformed structured records", () => {
    expect(() => structuredLogToEntry("not an object")).toThrow(
      "structured log record must be an object",
    );
    expect(() => structuredLogToEntry({ level: "info" })).toThrow(
      "must include msg or message",
    );
    expect(() =>
      structuredLogToEntry({ level: "nope", message: "bad" }),
    ).toThrow("unsupported log level");
    expect(() =>
      structuredLogToEntry(
        { level: "info", message: "ok" },
        { source: "invalid" as never },
      ),
    ).toThrow("unsupported structured log source");
  });
});
