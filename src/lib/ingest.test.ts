import { describe, expect, it } from "bun:test";
import { createTestDb } from "../db/index.ts";
import { getEventRecord, readRawEvent } from "./event-store.ts";
import { ingestBatch, ingestLog } from "./ingest.ts";
import { REDACTED } from "./redaction.ts";

describe("ingest", () => {
  it("inserts a single log entry", () => {
    const db = createTestDb();
    const row = ingestLog(db, {
      level: "error",
      message: "test error",
      service: "api",
    });
    expect(row.id).toBeTruthy();
    expect(row.level).toBe("error");
    expect(row.message).toBe("test error");
    expect(row.service).toBe("api");
    expect(row.source).toBe("sdk");
    expect(row.timestamp).toBeTruthy();
  });

  it("writes a raw event record with a readable segment pointer", () => {
    const db = createTestDb();
    const row = ingestLog(db, {
      level: "warn",
      message: "raw event",
      service: "worker",
    });
    const record = getEventRecord(db, row.id);
    expect(record).toBeTruthy();
    expect(record?.event_id).toBe(row.id);
    expect(record?.event_type).toBe("log");
    expect(record?.segment_path.startsWith("segments/")).toBe(true);
    expect(record?.byte_length).toBeGreaterThan(0);

    const raw = readRawEvent(db, row.id);
    expect(raw?.event_id).toBe(row.id);
    expect(raw?.event_time).toBe(row.timestamp);
    expect(raw?.message).toBe("raw event");
    expect(raw?.body?.log).toMatchObject({
      message: "raw event",
      service: "worker",
    });
  });

  it("preserves producer event id and timestamp", () => {
    const db = createTestDb();
    const timestamp = "2026-06-16T08:30:00.000Z";
    const row = ingestLog(db, {
      id: "producer-evt-1",
      timestamp,
      level: "info",
      message: "producer event",
    });
    expect(row.id).toBe("producer-evt-1");
    expect(row.timestamp).toBe(timestamp);

    const record = getEventRecord(db, "producer-evt-1");
    const raw = readRawEvent(db, "producer-evt-1");
    expect(record?.event_time).toBe(timestamp);
    expect(record?.source_event_id).toBe("producer-evt-1");
    expect(raw?.event_id).toBe("producer-evt-1");
    expect(raw?.source_event_id).toBe("producer-evt-1");
    expect(raw?.event_time).toBe(timestamp);
  });

  it("indexes top-level universal identity and privacy fields", () => {
    const db = createTestDb();
    const row = ingestLog(db, {
      id: "identity-top-level",
      source_event_id: "upstream-log-99",
      timestamp: "2026-06-16T08:45:00.000Z",
      level: "info",
      source: "cli",
      message: "top-level identity",
      privacy: "sensitive",
      machine_id: "machine-top",
      repo_id: "repo-top",
      app_id: "app-top",
      process_id: "process-top",
      run_id: "run-top",
      trace_id: "trace-top",
      span_id: "span-top",
      parent_span_id: "span-parent",
      session_id: "session-top",
      release_id: "release-top",
      environment: "test",
    });

    const record = getEventRecord(db, row.id);
    expect(record).toMatchObject({
      source_event_id: "upstream-log-99",
      source: "cli",
      machine_id: "machine-top",
      repo_id: "repo-top",
      app_id: "app-top",
      process_id: "process-top",
      run_id: "run-top",
      trace_id: "trace-top",
      span_id: "span-top",
      parent_span_id: "span-parent",
      session_id: "session-top",
      release_id: "release-top",
      environment: "test",
      privacy_tier: "sensitive",
    });

    const raw = readRawEvent(db, row.id);
    expect(raw).toMatchObject({
      event_id: "identity-top-level",
      source_event_id: "upstream-log-99",
      source: "cli",
      privacy: "sensitive",
      machine_id: "machine-top",
      repo_id: "repo-top",
      app_id: "app-top",
      process_id: "process-top",
      run_id: "run-top",
      trace_id: "trace-top",
      span_id: "span-top",
      parent_span_id: "span-parent",
      session_id: "session-top",
      release_id: "release-top",
      environment: "test",
    });
  });

  it("redacts canary secrets before raw and SQLite persistence", () => {
    const db = createTestDb();
    const secret = "OPENLOGS_SECRET_CANARY_ingest_12345";
    const row = ingestLog(db, {
      id: "redaction-1",
      level: "error",
      message: `token=${secret}`,
      url: `https://example.test/path?token=${secret}&ok=1`,
      stack_trace: `Error: boom\nAuthorization: Bearer ${secret}`,
      metadata: {
        password: secret,
        nested: {
          api_key: secret,
          note: `email test@example.com and ${secret}`,
        },
      },
    });

    expect(row.message).not.toContain(secret);
    expect(row.url).not.toContain(secret);
    expect(row.stack_trace).not.toContain(secret);
    expect(row.metadata).not.toContain(secret);
    expect(row.message).toContain(REDACTED);

    const metadata = JSON.parse(row.metadata ?? "{}") as {
      redaction?: { applied?: boolean; replacements?: number };
    };
    expect(metadata.redaction?.applied).toBe(true);
    expect(metadata.redaction?.replacements).toBeGreaterThan(0);

    const raw = readRawEvent(db, row.id);
    const rawDump = JSON.stringify(raw);
    const indexedDump = JSON.stringify(getEventRecord(db, row.id));
    expect(rawDump).not.toContain(secret);
    expect(indexedDump).not.toContain(secret);
    expect(rawDump).toContain(REDACTED);
  });

  it("redacts top-level producer and identity fields before persistence", () => {
    const db = createTestDb();
    const secret = "OPENLOGS_SECRET_CANARY_log_identity_12345";
    const row = ingestLog(db, {
      id: "redaction-top-level-log",
      source_event_id: `producer?token=${secret}`,
      level: "info",
      service: `svc?token=${secret}`,
      message: "top-level identity redaction",
      machine_id: `machine?token=${secret}`,
      repo_id: `repo?token=${secret}`,
      app_id: `app?token=${secret}`,
      process_id: `process?token=${secret}`,
      run_id: `run?token=${secret}`,
      trace_id: `trace?token=${secret}`,
      span_id: `span?token=${secret}`,
      parent_span_id: `parent?token=${secret}`,
      session_id: `session?token=${secret}`,
      release_id: `release?token=${secret}`,
      environment: `env?token=${secret}`,
      agent: `agent?token=${secret}`,
    });

    expect(row.service).toBe(`svc?token=${REDACTED}`);
    expect(row.trace_id).toBe(`trace?token=${REDACTED}`);
    expect(row.session_id).toBe(`session?token=${REDACTED}`);
    expect(row.agent).toBe(`agent?token=${REDACTED}`);
    expect(row.metadata).toBeTruthy();

    const rawDump = JSON.stringify(readRawEvent(db, row.id));
    const indexedDump = JSON.stringify(getEventRecord(db, row.id));
    expect(rawDump).not.toContain(secret);
    expect(indexedDump).not.toContain(secret);
    expect(rawDump).toContain(`producer?token=${REDACTED}`);
    expect(rawDump).toContain(`run?token=${REDACTED}`);
    expect(indexedDump).toContain(`trace?token=${REDACTED}`);

    const metadata = JSON.parse(row.metadata ?? "{}") as {
      redaction?: { fields?: string[]; replacements?: number };
    };
    expect(metadata.redaction?.fields).toEqual(
      expect.arrayContaining([
        "source_event_id:openlogs_canary",
        "machine_id:openlogs_canary",
        "run_id:openlogs_canary",
        "trace_id:openlogs_canary",
        "session_id:openlogs_canary",
        "service:openlogs_canary",
        "agent:openlogs_canary",
      ]),
    );
    expect(metadata.redaction?.replacements).toBeGreaterThanOrEqual(14);
  });

  it("derives a stable internal id when a supplied log id needs redaction", () => {
    const db = createTestDb();
    const secret = "OPENLOGS_SECRET_CANARY_id_12345";
    const unsafeId = `producer?token=${secret}`;
    const first = ingestLog(db, {
      id: unsafeId,
      level: "info",
      message: "id redaction",
    });
    const second = ingestLog(db, {
      id: unsafeId,
      level: "info",
      message: "id redaction retry",
    });

    expect(second).toEqual(first);
    expect(first.id).toStartWith("log_redacted_");
    expect(first.id).not.toContain(secret);
    expect(first.id).not.toContain(REDACTED);

    const raw = readRawEvent(db, first.id);
    const record = getEventRecord(db, first.id);
    const persistedDump = JSON.stringify({ first, raw, record });
    expect(persistedDump).not.toContain(secret);
    expect(raw?.event_id).toBe(first.id);
    expect(raw?.source_event_id).toBe(`producer?token=${REDACTED}`);
    expect(record?.event_id).toBe(first.id);
    expect(record?.source_event_id).toBe(`producer?token=${REDACTED}`);

    const metadata = JSON.parse(first.metadata ?? "{}") as {
      redaction?: { fields?: string[] };
    };
    expect(metadata.redaction?.fields).toEqual(
      expect.arrayContaining(["id:openlogs_canary"]),
    );
  });

  it("uses producer id for idempotent retries", () => {
    const db = createTestDb();
    const first = ingestLog(db, {
      id: "retry-evt-1",
      level: "error",
      message: "first write",
    });
    const second = ingestLog(db, {
      id: "retry-evt-1",
      level: "error",
      message: "retry write",
    });

    expect(second).toEqual(first);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM logs WHERE id = ?")
          .get("retry-evt-1") as { count: number }
      ).count,
    ).toBe(1);
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM event_records WHERE event_id = ?",
          )
          .get("retry-evt-1") as { count: number }
      ).count,
    ).toBe(1);
    expect(
      (
        db
          .prepare("SELECT SUM(event_count) AS count FROM event_segments")
          .get() as { count: number }
      ).count,
    ).toBe(1);
  });

  it("indexes identity fields from metadata", () => {
    const db = createTestDb();
    const row = ingestLog(db, {
      level: "info",
      message: "identity event",
      metadata: {
        machine_id: "machine-a",
        repo_id: "repo-a",
        app_id: "app-a",
        process_id: "process-a",
        run_id: "run-a",
        span_id: "span-a",
        parent_span_id: "span-root",
        release_id: "release-a",
        environment: "development",
        artifact_id: "artifact-a",
        privacy_tier: "internal",
      },
    });

    const record = getEventRecord(db, row.id);
    expect(record).toMatchObject({
      machine_id: "machine-a",
      repo_id: "repo-a",
      app_id: "app-a",
      process_id: "process-a",
      run_id: "run-a",
      span_id: "span-a",
      parent_span_id: "span-root",
      release_id: "release-a",
      environment: "development",
      artifact_id: "artifact-a",
      privacy_tier: "internal",
    });
  });

  it("inserts with all optional fields", () => {
    const db = createTestDb();
    const row = ingestLog(db, {
      level: "info",
      message: "hello",
      source: "scanner",
      trace_id: "trace-123",
      session_id: "sess-456",
      agent: "brutus",
      url: "https://example.com",
      stack_trace: "Error at line 1",
      metadata: { foo: "bar" },
    });
    expect(row.trace_id).toBe("trace-123");
    expect(row.agent).toBe("brutus");
    expect(row.metadata).toBe(JSON.stringify({ foo: "bar" }));
  });

  it("inserts a batch", () => {
    const db = createTestDb();
    const rows = ingestBatch(db, [
      { level: "warn", message: "warn 1" },
      { level: "error", message: "err 1" },
      { level: "info", message: "info 1" },
    ]);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.level).toBe("warn");
    expect(rows[2]?.level).toBe("info");
    expect(
      (
        db.prepare("SELECT COUNT(*) as c FROM event_records").get() as {
          c: number;
        }
      ).c,
    ).toBe(3);
  });

  it("batch is transactional", () => {
    const db = createTestDb();
    const before = (
      db.prepare("SELECT COUNT(*) as c FROM logs").get() as { c: number }
    ).c;
    ingestBatch(db, [
      { level: "debug", message: "a" },
      { level: "fatal", message: "b" },
    ]);
    const after = (
      db.prepare("SELECT COUNT(*) as c FROM logs").get() as { c: number }
    ).c;
    expect(after - before).toBe(2);
  });
});
