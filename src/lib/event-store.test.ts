import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createTestDb } from "../db/index.ts";
import {
  appendRawEvent,
  getEventRecord,
  getEventStoreDataDir,
  indexRawEvent,
  rebuildEventStoreIndex,
  repairEventStoreSegments,
  replayRawEvents,
  verifyEventStore,
} from "./event-store.ts";
import { ingestLog } from "./ingest.ts";
import { ingestUniversalEvent } from "./universal-ingest.ts";

describe("event store", () => {
  it("verifies raw segments and event records", () => {
    const db = createTestDb();
    ingestLog(db, { id: "verify-1", level: "info", message: "verify one" });
    ingestLog(db, { id: "verify-2", level: "warn", message: "verify two" });

    const result = verifyEventStore(db);
    expect(result.ok).toBe(true);
    expect(result.checked_records).toBe(2);
    expect(result.checked_segments).toBe(1);
    expect(result.checked_raw_events).toBe(2);
    expect(result.unindexed_raw_events).toBe(0);

    const replayed = replayRawEvents(db);
    expect(replayed.map((item) => item.event.event_id)).toEqual([
      "verify-1",
      "verify-2",
    ]);
  });

  it("detects tampered raw segment data", () => {
    const db = createTestDb();
    const row = ingestLog(db, {
      id: "tamper-1",
      level: "error",
      message: "tamperable",
    });
    const record = getEventRecord(db, row.id);
    if (!record) throw new Error("expected event record");
    const path = join(getEventStoreDataDir(db), record.segment_path);

    writeFileSync(path, `${readFileSync(path, "utf8")}partial-write`);

    const result = verifyEventStore(db);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("detects raw events that exist on disk but are not indexed", () => {
    const db = createTestDb();
    ingestLog(db, { id: "unindexed-1", level: "info", message: "raw only" });

    db.run("DELETE FROM event_records");
    db.run("DELETE FROM event_segments");

    const before = verifyEventStore(db);
    expect(before.ok).toBe(false);
    expect(before.checked_segments).toBe(1);
    expect(before.checked_raw_events).toBe(1);
    expect(before.unindexed_raw_events).toBe(1);
    expect(before.errors.some((error) => error.includes("not indexed"))).toBe(
      true,
    );

    const rebuilt = rebuildEventStoreIndex(db);
    expect(rebuilt).toEqual({
      indexed_events: 1,
      indexed_segments: 1,
      skipped_events: 0,
      errors: [],
    });
    expect(verifyEventStore(db).ok).toBe(true);
  });

  it("rebuilds orphan raw events whose compatibility log insert failed", () => {
    const db = createTestDb();
    expect(() =>
      ingestLog(db, {
        id: "orphan-1",
        project_id: "missing-project",
        level: "error",
        message: "orphan raw",
      }),
    ).toThrow();

    const before = verifyEventStore(db);
    expect(before.ok).toBe(false);
    expect(before.unindexed_raw_events).toBe(1);

    const rebuilt = rebuildEventStoreIndex(db);
    expect(rebuilt).toEqual({
      indexed_events: 1,
      indexed_segments: 1,
      skipped_events: 0,
      errors: [],
    });
    const record = getEventRecord(db, "orphan-1");
    expect(record?.project_id).toBeNull();
    expect(record?.log_id).toBe("orphan-1");
    const log = db
      .prepare("SELECT project_id, message FROM logs WHERE id = ?")
      .get("orphan-1") as { project_id: string | null; message: string } | null;
    expect(log).toEqual({ project_id: null, message: "orphan raw" });
    expect(verifyEventStore(db).ok).toBe(true);
  });

  it("does not rebuild indexes while the event store lock is held", () => {
    const db = createTestDb();
    ingestLog(db, { id: "locked-rebuild", level: "info", message: "locked" });

    const lockDir = join(getEventStoreDataDir(db), ".locks", "segments.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner.json"),
      `${JSON.stringify({ pid: 999999, created_at: new Date().toISOString() })}\n`,
      "utf8",
    );

    const previousTimeout = process.env.HASNA_LOGS_LOCK_TIMEOUT_MS;
    process.env.HASNA_LOGS_LOCK_TIMEOUT_MS = "80";
    try {
      expect(() => rebuildEventStoreIndex(db)).toThrow(
        /Timed out waiting for event store lock/,
      );
    } finally {
      if (previousTimeout === undefined) {
        process.env.HASNA_LOGS_LOCK_TIMEOUT_MS = undefined;
      } else {
        process.env.HASNA_LOGS_LOCK_TIMEOUT_MS = previousTimeout;
      }
      rmSync(lockDir, { recursive: true, force: true });
    }

    const rebuilt = rebuildEventStoreIndex(db);
    expect(rebuilt.indexed_events).toBe(1);
    expect(verifyEventStore(db).ok).toBe(true);
  });

  it("rebuild reports partial lines without losing complete indexed events", () => {
    const db = createTestDb();
    const row = ingestLog(db, {
      id: "partial-1",
      level: "info",
      message: "complete before partial",
    });
    const record = getEventRecord(db, row.id);
    if (!record) throw new Error("expected event record");
    const path = join(getEventStoreDataDir(db), record.segment_path);
    writeFileSync(path, `${readFileSync(path, "utf8")}{"event_id":"partial-2"`);

    const rebuilt = rebuildEventStoreIndex(db);
    expect(rebuilt.indexed_events).toBe(1);
    expect(rebuilt.indexed_segments).toBe(1);
    expect(rebuilt.skipped_events).toBe(0);
    expect(
      rebuilt.errors.some((error) => error.includes("Partial raw event line")),
    ).toBe(true);
    expect(getEventRecord(db, "partial-1")).toBeTruthy();

    const after = verifyEventStore(db);
    expect(after.ok).toBe(false);
    expect(
      after.errors.some((error) => error.includes("Partial raw event line")),
    ).toBe(true);
  });

  it("repairs malformed lines and partial tails by quarantining exact bytes", () => {
    const db = createTestDb();
    ingestLog(db, {
      id: "repair-1",
      level: "info",
      message: "repair one",
    });
    ingestLog(db, {
      id: "repair-2",
      level: "info",
      message: "repair two",
    });
    const record = getEventRecord(db, "repair-1");
    if (!record) throw new Error("expected event record");
    const segmentPath = join(getEventStoreDataDir(db), record.segment_path);
    writeFileSync(
      segmentPath,
      `${readFileSync(segmentPath, "utf8")}not-json\n{"event_id":"repair-partial"`,
    );

    const before = verifyEventStore(db);
    expect(before.ok).toBe(false);
    expect(
      before.errors.some((error) => error.includes("Malformed raw event line")),
    ).toBe(true);
    expect(
      before.errors.some((error) => error.includes("Partial raw event line")),
    ).toBe(true);

    const dryRun = repairEventStoreSegments(db);
    expect(dryRun.applied).toBe(false);
    expect(dryRun.scanned_segments).toBe(1);
    expect(dryRun.repaired_segments).toBe(1);
    expect(dryRun.repairs[0]?.removed_lines.map((line) => line.reason)).toEqual(
      ["malformed", "partial"],
    );
    expect(verifyEventStore(db).ok).toBe(false);

    const repaired = repairEventStoreSegments(db, { apply: true });
    expect(repaired.applied).toBe(true);
    expect(repaired.repaired_segments).toBe(1);
    expect(repaired.errors).toEqual([]);
    expect(repaired.rebuild).toEqual({
      indexed_events: 2,
      indexed_segments: 1,
      skipped_events: 0,
      errors: [],
    });
    expect(repaired.verification?.ok).toBe(true);

    const repair = repaired.repairs[0];
    if (!repair) throw new Error("expected repair plan");
    const quarantinePath = join(
      getEventStoreDataDir(db),
      repair.quarantine_path,
    );
    const quarantineManifestPath = join(
      getEventStoreDataDir(db),
      repair.quarantine_manifest_path,
    );
    expect(existsSync(quarantinePath)).toBe(true);
    expect(existsSync(quarantineManifestPath)).toBe(true);
    const quarantine = readFileSync(quarantinePath, "utf8");
    expect(quarantine).toBe('not-json\n{"event_id":"repair-partial"');
    expect(replayRawEvents(db).map((item) => item.event.event_id)).toEqual([
      "repair-1",
      "repair-2",
    ]);
    expect(verifyEventStore(db).ok).toBe(true);

    const repeated = repairEventStoreSegments(db, { apply: true });
    expect(repeated.repaired_segments).toBe(0);
    expect(repeated.rebuild).toEqual({
      indexed_events: 2,
      indexed_segments: 1,
      skipped_events: 0,
      errors: [],
    });
    expect(repeated.verification?.ok).toBe(true);
  });

  it("allows a late producer index after repair rebuilds an appended raw event", () => {
    const db = createTestDb();
    const event = {
      schema_version: 1,
      event_id: "late-index-1",
      source_event_id: "producer-late-index-1",
      event_time: "2026-06-16T08:00:00.000Z",
      ingest_time: "2026-06-16T08:00:00.000Z",
      type: "metric",
      source: "test",
      severity: "info",
      privacy: "internal",
      message: "late index metric",
      body: { value: 1 },
      attributes: { environment: "test" },
    };
    const write = appendRawEvent(db, event);

    const repaired = repairEventStoreSegments(db, { apply: true });
    expect(repaired.repaired_segments).toBe(0);
    expect(repaired.rebuild).toEqual({
      indexed_events: 1,
      indexed_segments: 1,
      skipped_events: 0,
      errors: [],
    });

    expect(() =>
      indexRawEvent(
        db,
        {
          event_id: event.event_id,
          schema_version: event.schema_version,
          source_event_id: event.source_event_id,
          event_type: event.type,
          event_time: event.event_time,
          ingest_time: event.ingest_time,
          severity: event.severity,
          source: event.source,
          environment: "test",
          privacy_tier: event.privacy,
          message: event.message,
          metadata: event.attributes,
        },
        write,
      ),
    ).not.toThrow();

    const count = db
      .prepare("SELECT COUNT(*) AS count FROM event_records WHERE event_id = ?")
      .get(event.event_id) as { count: number };
    expect(count).toEqual({ count: 1 });
    expect(verifyEventStore(db).ok).toBe(true);
  });

  it("rebuilds SQLite event indexes from raw segments", () => {
    const db = createTestDb();
    ingestLog(db, {
      id: "rebuild-1",
      level: "info",
      message: "rebuild one",
      trace_id: "trace-a",
    });
    ingestLog(db, {
      id: "rebuild-2",
      source_event_id: "source-rebuild-2",
      level: "info",
      message: "rebuild two",
      privacy: "internal",
      machine_id: "machine-a",
      environment: "development",
    });

    db.run("DELETE FROM event_records");
    db.run("DELETE FROM event_segments");

    const rebuilt = rebuildEventStoreIndex(db);
    expect(rebuilt).toEqual({
      indexed_events: 2,
      indexed_segments: 1,
      skipped_events: 0,
      errors: [],
    });
    expect(getEventRecord(db, "rebuild-1")?.trace_id).toBe("trace-a");
    expect(getEventRecord(db, "rebuild-2")?.machine_id).toBe("machine-a");
    expect(getEventRecord(db, "rebuild-2")?.source_event_id).toBe(
      "source-rebuild-2",
    );
    expect(getEventRecord(db, "rebuild-2")?.environment).toBe("development");
    expect(getEventRecord(db, "rebuild-2")?.privacy_tier).toBe("internal");
    expect(verifyEventStore(db).ok).toBe(true);
  });

  it("rebuilds SQLite compatibility projections from raw segments", () => {
    const db = createTestDb();
    const project = db
      .prepare(
        "INSERT INTO projects (name) VALUES ('projection-rebuild') RETURNING id",
      )
      .get() as { id: string };

    ingestLog(db, {
      id: "projection-log-1",
      timestamp: "2026-06-16T08:00:00.000Z",
      project_id: project.id,
      level: "error",
      source: "node",
      service: "api",
      message: "Checkout route failed",
      trace_id: "trace-rebuild",
      session_id: "session-rebuild",
      stack_trace: "Error: checkout\n at route",
      metadata: {
        machine_id: "machine-rebuild",
        repo_id: "repo-rebuild",
        app_id: "app-rebuild",
        process_id: "proc-legacy",
        run_id: "run-legacy",
        environment: "test",
      },
    });
    ingestUniversalEvent(db, {
      type: "span",
      event_id: "projection-span-event",
      event_time: "2026-06-16T08:00:01.000Z",
      source: "otel",
      severity: "info",
      project_id: project.id,
      app_id: "app-rebuild",
      process_id: "proc-rebuild",
      trace_id: "trace-rebuild",
      span_id: "span-rebuild",
      parent_span_id: "span-parent",
      message: "GET /checkout",
      attributes: {
        name: "GET /checkout",
        operation: "http.server",
        status: "ok",
        duration_ms: 27.5,
        ended_at: "2026-06-16T08:00:01.027Z",
      },
    });
    ingestUniversalEvent(db, {
      type: "span",
      event_id: "projection-span-process-event",
      event_time: "2026-06-16T08:00:01.500Z",
      source: "otel",
      severity: "info",
      machine_id: "machine-span-only",
      repo_id: "repo-span-only",
      app_id: "app-span-only",
      process_id: "proc-span-only",
      run_id: "run-span-only",
      trace_id: "trace-span-only",
      span_id: "span-process-only",
      message: "span-only process context",
      attributes: {
        name: "span-only process context",
        operation: "worker.job",
        pid: 456,
        command: "node worker.js",
        cwd: "/workspace/span-only",
        run_type: "worker",
        status: "ok",
        ended_at: "2026-06-16T08:00:01.600Z",
        exit_code: 0,
      },
    });
    ingestLog(db, {
      id: "projection-trace-placeholder-log",
      timestamp: "2026-06-16T08:00:10.000Z",
      project_id: project.id,
      level: "info",
      source: "node",
      service: "api",
      message: "log seeds trace placeholder",
      trace_id: "trace-detail-rebuild",
    });
    ingestUniversalEvent(db, {
      type: "span",
      event_id: "projection-trace-detail-span",
      event_time: "2026-06-16T08:00:11.000Z",
      source: "otel",
      project_id: project.id,
      app_id: "app-rebuild",
      trace_id: "trace-detail-rebuild",
      span_id: "span-trace-detail",
      attributes: {
        name: "trace detail span",
        operation: "worker.trace",
        started_at: "2026-06-16T08:00:00.000Z",
        ended_at: "2026-06-16T08:00:12.000Z",
        status: "ok",
      },
    });
    ingestUniversalEvent(db, {
      type: "session",
      event_id: "projection-session-event",
      event_time: "2026-06-16T08:00:02.000Z",
      source: "browser",
      project_id: project.id,
      app_id: "app-rebuild",
      session_id: "session-rebuild",
      attributes: {
        user_hash: "user-hash-rebuild",
        status: "crashed",
        ended_at: "2026-06-16T08:00:03.000Z",
      },
    });
    ingestLog(db, {
      id: "projection-session-placeholder-log",
      timestamp: "2026-06-16T08:00:10.000Z",
      project_id: project.id,
      level: "info",
      source: "browser",
      service: "web",
      message: "log seeds session placeholder",
      session_id: "session-detail-rebuild",
    });
    ingestUniversalEvent(db, {
      type: "session",
      event_id: "projection-session-detail-event",
      event_time: "2026-06-16T08:00:11.000Z",
      source: "browser",
      project_id: project.id,
      app_id: "app-rebuild",
      session_id: "session-detail-rebuild",
      attributes: {
        user_hash: "user-detail-rebuild",
        started_at: "2026-06-16T08:00:00.000Z",
        ended_at: "2026-06-16T08:00:12.000Z",
        status: "healthy",
      },
    });
    ingestUniversalEvent(db, {
      type: "artifact",
      event_id: "projection-artifact-event",
      event_time: "2026-06-16T08:00:04.000Z",
      source: "ci",
      release_id: "release-rebuild",
      artifact_id: "artifact-rebuild",
      attributes: {
        artifact_type: "bundle",
        path: "dist/app.js",
        content_hash: "sha256:abc",
        size_bytes: 12345,
      },
    });
    ingestUniversalEvent(db, {
      type: "release",
      event_id: "projection-release-event",
      event_time: "2026-06-16T08:00:05.000Z",
      source: "ci",
      project_id: project.id,
      app_id: "app-rebuild",
      release_id: "release-rebuild",
      attributes: {
        version: "1.2.3",
        commit_sha: "abcdef123456",
        build_id: "build-rebuild",
      },
    });
    ingestUniversalEvent(db, {
      type: "process",
      event_id: "projection-process-event",
      event_time: "2026-06-16T08:00:06.000Z",
      source: "cli",
      machine_id: "machine-rebuild",
      repo_id: "repo-rebuild",
      app_id: "app-rebuild",
      process_id: "proc-rebuild",
      run_id: "run-rebuild",
      attributes: {
        pid: 123,
        ppid: 1,
        command: "bun test",
        cwd: "/workspace/open-logs",
        started_at: "2026-06-16T08:00:06.000Z",
        ended_at: "2026-06-16T08:00:07.000Z",
        exit_code: 0,
        run_type: "test",
        name: "unit tests",
        status: "passed",
      },
    });
    ingestUniversalEvent(db, {
      type: "exception",
      event_id: "projection-exception-event",
      event_time: "2026-06-16T08:00:08.000Z",
      source: "node",
      severity: "error",
      project_id: project.id,
      message: "Projection rebuild exception",
      attributes: {
        service: "worker",
        stack_trace: "Error: projection\n at worker",
      },
    });

    for (const table of [
      "event_records",
      "event_segments",
      "issues",
      "logs",
      "spans",
      "traces",
      "sessions",
      "artifacts",
      "releases",
      "processes",
      "runs",
    ]) {
      db.run(`DELETE FROM ${table}`);
    }

    const rebuilt = rebuildEventStoreIndex(db);
    expect(rebuilt).toEqual({
      indexed_events: 12,
      indexed_segments: 1,
      skipped_events: 0,
      errors: [],
    });
    expect(verifyEventStore(db).ok).toBe(true);

    const log = db
      .prepare(
        "SELECT project_id, level, service, message, trace_id, session_id FROM logs WHERE id = ?",
      )
      .get("projection-log-1") as {
      project_id: string | null;
      level: string;
      service: string | null;
      message: string;
      trace_id: string | null;
      session_id: string | null;
    } | null;
    expect(log).toEqual({
      project_id: project.id,
      level: "error",
      service: "api",
      message: "Checkout route failed",
      trace_id: "trace-rebuild",
      session_id: "session-rebuild",
    });

    const issues = db
      .prepare(
        "SELECT service, level, count FROM issues WHERE project_id = ? ORDER BY service",
      )
      .all(project.id) as Array<{
      service: string | null;
      level: string;
      count: number;
    }>;
    expect(issues).toEqual([
      { service: "api", level: "error", count: 1 },
      { service: "worker", level: "error", count: 1 },
    ]);

    const trace = db
      .prepare(
        "SELECT project_id, app_id, root_span_id FROM traces WHERE id = ?",
      )
      .get("trace-rebuild") as {
      project_id: string | null;
      app_id: string | null;
      root_span_id: string | null;
    } | null;
    expect(trace).toEqual({
      project_id: project.id,
      app_id: "app-rebuild",
      root_span_id: "span-rebuild",
    });

    const detailedTrace = db
      .prepare(
        "SELECT project_id, app_id, root_span_id, started_at, ended_at, status FROM traces WHERE id = ?",
      )
      .get("trace-detail-rebuild") as {
      project_id: string | null;
      app_id: string | null;
      root_span_id: string | null;
      started_at: string | null;
      ended_at: string | null;
      status: string | null;
    } | null;
    expect(detailedTrace).toEqual({
      project_id: project.id,
      app_id: "app-rebuild",
      root_span_id: "span-trace-detail",
      started_at: "2026-06-16T08:00:00.000Z",
      ended_at: "2026-06-16T08:00:12.000Z",
      status: "ok",
    });

    const span = db
      .prepare(
        "SELECT trace_id, parent_span_id, app_id, process_id, name, operation, status, duration_ms FROM spans WHERE id = ?",
      )
      .get("span-rebuild") as {
      trace_id: string | null;
      parent_span_id: string | null;
      app_id: string | null;
      process_id: string | null;
      name: string | null;
      operation: string | null;
      status: string | null;
      duration_ms: number | null;
    } | null;
    expect(span).toEqual({
      trace_id: "trace-rebuild",
      parent_span_id: "span-parent",
      app_id: "app-rebuild",
      process_id: "proc-rebuild",
      name: "GET /checkout",
      operation: "http.server",
      status: "ok",
      duration_ms: 27.5,
    });

    const session = db
      .prepare(
        "SELECT project_id, app_id, user_hash, status, ended_at FROM sessions WHERE id = ?",
      )
      .get("session-rebuild") as {
      project_id: string | null;
      app_id: string | null;
      user_hash: string | null;
      status: string | null;
      ended_at: string | null;
    } | null;
    expect(session).toEqual({
      project_id: project.id,
      app_id: "app-rebuild",
      user_hash: "user-hash-rebuild",
      status: "crashed",
      ended_at: "2026-06-16T08:00:03.000Z",
    });

    const detailedSession = db
      .prepare(
        "SELECT project_id, app_id, user_hash, started_at, status, ended_at FROM sessions WHERE id = ?",
      )
      .get("session-detail-rebuild") as {
      project_id: string | null;
      app_id: string | null;
      user_hash: string | null;
      started_at: string | null;
      status: string | null;
      ended_at: string | null;
    } | null;
    expect(detailedSession).toEqual({
      project_id: project.id,
      app_id: "app-rebuild",
      user_hash: "user-detail-rebuild",
      started_at: "2026-06-16T08:00:00.000Z",
      status: "healthy",
      ended_at: "2026-06-16T08:00:12.000Z",
    });

    const release = db
      .prepare(
        "SELECT project_id, app_id, version, commit_sha, build_id FROM releases WHERE id = ?",
      )
      .get("release-rebuild") as {
      project_id: string | null;
      app_id: string | null;
      version: string | null;
      commit_sha: string | null;
      build_id: string | null;
    } | null;
    expect(release).toEqual({
      project_id: project.id,
      app_id: "app-rebuild",
      version: "1.2.3",
      commit_sha: "abcdef123456",
      build_id: "build-rebuild",
    });

    const artifact = db
      .prepare(
        "SELECT release_id, artifact_type, path, content_hash, size_bytes FROM artifacts WHERE id = ?",
      )
      .get("artifact-rebuild") as {
      release_id: string | null;
      artifact_type: string | null;
      path: string | null;
      content_hash: string | null;
      size_bytes: number | null;
    } | null;
    expect(artifact).toEqual({
      release_id: "release-rebuild",
      artifact_type: "bundle",
      path: "dist/app.js",
      content_hash: "sha256:abc",
      size_bytes: 12345,
    });

    const process = db
      .prepare(
        "SELECT machine_id, repo_id, app_id, pid, ppid, command, cwd, ended_at, exit_code FROM processes WHERE id = ?",
      )
      .get("proc-rebuild") as {
      machine_id: string | null;
      repo_id: string | null;
      app_id: string | null;
      pid: number | null;
      ppid: number | null;
      command: string | null;
      cwd: string | null;
      ended_at: string | null;
      exit_code: number | null;
    } | null;
    expect(process).toEqual({
      machine_id: "machine-rebuild",
      repo_id: "repo-rebuild",
      app_id: "app-rebuild",
      pid: 123,
      ppid: 1,
      command: "bun test",
      cwd: "/workspace/open-logs",
      ended_at: "2026-06-16T08:00:07.000Z",
      exit_code: 0,
    });

    const run = db
      .prepare(
        "SELECT process_id, run_type, name, status, ended_at, exit_code FROM runs WHERE id = ?",
      )
      .get("run-rebuild") as {
      process_id: string | null;
      run_type: string | null;
      name: string | null;
      status: string | null;
      ended_at: string | null;
      exit_code: number | null;
    } | null;
    expect(run).toEqual({
      process_id: "proc-rebuild",
      run_type: "test",
      name: "unit tests",
      status: "passed",
      ended_at: "2026-06-16T08:00:07.000Z",
      exit_code: 0,
    });

    const spanOnlyProcess = db
      .prepare(
        "SELECT machine_id, repo_id, app_id, pid, command, cwd, ended_at, exit_code FROM processes WHERE id = ?",
      )
      .get("proc-span-only") as {
      machine_id: string | null;
      repo_id: string | null;
      app_id: string | null;
      pid: number | null;
      command: string | null;
      cwd: string | null;
      ended_at: string | null;
      exit_code: number | null;
    } | null;
    expect(spanOnlyProcess).toEqual({
      machine_id: "machine-span-only",
      repo_id: "repo-span-only",
      app_id: "app-span-only",
      pid: 456,
      command: "node worker.js",
      cwd: "/workspace/span-only",
      ended_at: "2026-06-16T08:00:01.600Z",
      exit_code: 0,
    });

    const spanOnlyRun = db
      .prepare(
        "SELECT process_id, run_type, name, status, ended_at, exit_code FROM runs WHERE id = ?",
      )
      .get("run-span-only") as {
      process_id: string | null;
      run_type: string | null;
      name: string | null;
      status: string | null;
      ended_at: string | null;
      exit_code: number | null;
    } | null;
    expect(spanOnlyRun).toEqual({
      process_id: "proc-span-only",
      run_type: "worker",
      name: "span-only process context",
      status: "ok",
      ended_at: "2026-06-16T08:00:01.600Z",
      exit_code: 0,
    });
  });

  it("rotates and seals segments when they exceed the configured byte limit", () => {
    const previous = process.env.HASNA_LOGS_SEGMENT_MAX_BYTES;
    process.env.HASNA_LOGS_SEGMENT_MAX_BYTES = "256";
    try {
      const db = createTestDb();
      ingestLog(db, {
        id: "rotate-1",
        level: "info",
        message: "x".repeat(300),
      });
      ingestLog(db, {
        id: "rotate-2",
        level: "info",
        message: "y".repeat(300),
      });

      const segments = db
        .prepare(
          "SELECT relative_path, sealed_at FROM event_segments ORDER BY relative_path",
        )
        .all() as Array<{ relative_path: string; sealed_at: string | null }>;
      expect(segments).toHaveLength(2);
      expect(segments[0]?.sealed_at).toBeTruthy();
      expect(segments[1]?.sealed_at).toBeNull();
    } finally {
      if (previous === undefined) {
        process.env.HASNA_LOGS_SEGMENT_MAX_BYTES = undefined;
      } else {
        process.env.HASNA_LOGS_SEGMENT_MAX_BYTES = previous;
      }
    }
  });
});
