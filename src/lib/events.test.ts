import { describe, expect, it } from "bun:test";
import { createTestDb } from "../db/index.ts";
import { exportEventsToJson, getEvent, searchEvents } from "./events.ts";
import { ingestLog } from "./ingest.ts";

describe("event catalog queries", () => {
  it("searches event_records by metadata dimensions and reconstructs raw envelopes", () => {
    const db = createTestDb();
    ingestLog(db, {
      id: "event-catalog-1",
      source_event_id: "producer-event-1",
      level: "error",
      source: "cli",
      message: "catalog needle",
      machine_id: "machine-1",
      repo_id: "repo-1",
      app_id: "app-1",
      process_id: "process-1",
      run_id: "run-1",
      trace_id: "trace-1",
      session_id: "session-1",
      environment: "test",
      privacy: "internal",
      metadata: { area: "events", nested: { ok: true } },
    });

    const rows = searchEvents(db, {
      event_type: "log",
      source: "cli",
      severity: "error",
      machine_id: "machine-1",
      run_id: "run-1",
      trace_id: "trace-1",
      text: "needle",
      include_raw: true,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_id).toBe("event-catalog-1");
    expect(rows[0]?.source_event_id).toBe("producer-event-1");
    expect(rows[0]?.metadata).toEqual({ area: "events", nested: { ok: true } });
    expect(rows[0]?.raw?.event_id).toBe("event-catalog-1");
    expect(rows[0]?.raw?.body?.log).toMatchObject({
      message: "catalog needle",
      run_id: "run-1",
    });
  });

  it("gets one event with raw payload and exports matching events as JSON", () => {
    const db = createTestDb();
    ingestLog(db, {
      id: "event-export-1",
      level: "info",
      source: "sdk",
      message: "first export",
      trace_id: "trace-export",
    });
    ingestLog(db, {
      id: "event-export-2",
      level: "warn",
      source: "sdk",
      message: "second export",
      trace_id: "trace-export",
    });

    const one = getEvent(db, "event-export-1");
    expect(one?.raw?.message).toBe("first export");

    const chunks: string[] = [];
    const count = exportEventsToJson(
      db,
      { trace_id: "trace-export", include_raw: true },
      (line) => chunks.push(line),
    );
    const body = JSON.parse(chunks.join("\n")) as Array<{
      event_id: string;
      raw?: { trace_id?: string | null };
    }>;
    expect(count).toBe(2);
    expect(body.map((row) => row.event_id).sort()).toEqual([
      "event-export-1",
      "event-export-2",
    ]);
    expect(body.every((row) => row.raw?.trace_id === "trace-export")).toBe(
      true,
    );
  });
});
