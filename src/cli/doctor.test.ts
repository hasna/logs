import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function testEnv(
  dataDir: string,
  extra?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HASNA_LOGS_DATA_DIR: dataDir,
    HASNA_LOGS_DB_PATH: join(dataDir, "logs.db"),
    HASNA_LOGS_FSYNC: "0",
    ...extra,
  };
}

function runCli(args: string[], dataDir: string, extraEnv?: NodeJS.ProcessEnv) {
  return spawnSync("bun", ["src/cli/index.ts", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: testEnv(dataDir, extraEnv),
  });
}

async function runCliAsync(
  args: string[],
  dataDir: string,
  extraEnv?: NodeJS.ProcessEnv,
) {
  const proc = Bun.spawn(["bun", "src/cli/index.ts", ...args], {
    cwd: repoRoot,
    env: testEnv(dataDir, extraEnv),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [status, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { status, stdout, stderr };
}

async function runIngestWorker(
  dataDir: string,
  workerId: number,
  eventsPerWorker: number,
  extraEnv?: NodeJS.ProcessEnv,
) {
  const script = `
    import { getDb, closeDb } from "./src/db/index.ts";
    import { ingestLog } from "./src/lib/ingest.ts";

    const db = getDb();
    try {
      for (let i = 0; i < ${eventsPerWorker}; i += 1) {
        ingestLog(db, {
          id: \`stress-worker-${workerId}-event-\${i}\`,
          level: i % 7 === 0 ? "warn" : "info",
          source: "sdk",
          service: "stress-worker",
          message: \`worker ${workerId} event \${i} \${"x".repeat(420)}\`,
          machine_id: "machine-stress",
          repo_id: "repo-stress",
          app_id: "app-stress",
          process_id: \`process-worker-${workerId}\`,
          run_id: "run-stress",
          trace_id: \`trace-worker-${workerId}\`,
          span_id: \`span-worker-${workerId}-\${i}\`,
          metadata: {
            worker_id: ${workerId},
            event_index: i,
            burst: true,
            payload: "y".repeat(200),
          },
        });
      }
    } finally {
      closeDb();
    }
  `;

  const proc = Bun.spawn(["bun", "-e", script], {
    cwd: repoRoot,
    env: testEnv(dataDir, extraEnv),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [status, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { status, stdout, stderr };
}

async function runRawAppendCrashWorker(dataDir: string) {
  const script = `
    import { getDb } from "./src/db/index.ts";
    import { appendRawEvent } from "./src/lib/event-store.ts";

    const db = getDb();
    const now = "2026-06-16T14:30:00.000Z";
    appendRawEvent(db, {
      schema_version: 1,
      event_id: "crash-raw-before-index",
      source_event_id: "producer-crash-1",
      event_time: now,
      ingest_time: now,
      type: "log",
      source: "sdk",
      severity: "error",
      privacy: "internal",
      message: "producer died after raw append",
      body: {
        log: {
          id: "crash-raw-before-index",
          timestamp: now,
          level: "error",
          source: "sdk",
          service: "crash-drill",
          message: "producer died after raw append",
          metadata: { crash_drill: true },
        },
      },
      attributes: {
        service: "crash-drill",
        privacy_tier: "internal",
      },
    });
    process.exit(42);
  `;

  const proc = Bun.spawn(["bun", "-e", script], {
    cwd: repoRoot,
    env: testEnv(dataDir),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [status, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { status, stdout, stderr };
}

async function runPartialTailCrashWriter(dataDir: string, segmentFile: string) {
  const script = `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(segmentFile)}, '{"event_id":"partial-crash"', { flag: "a" });
    process.exit(137);
  `;

  const proc = Bun.spawn(["bun", "-e", script], {
    cwd: repoRoot,
    env: testEnv(dataDir),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [status, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { status, stdout, stderr };
}

interface EventPointer {
  event_id: string;
  segment_path: string;
  byte_offset: number;
  byte_length: number;
  record_hash: string;
}

function readEventPointers(dataDir: string): EventPointer[] {
  const db = new Database(join(dataDir, "logs.db"));
  try {
    return db
      .prepare(
        "SELECT event_id, segment_path, byte_offset, byte_length, record_hash FROM event_records ORDER BY segment_path, byte_offset",
      )
      .all() as EventPointer[];
  } finally {
    db.close();
  }
}

function readCount(dataDir: string, table: string): number {
  const db = new Database(join(dataDir, "logs.db"));
  try {
    const row = db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as {
      count: number;
    };
    return row.count;
  } finally {
    db.close();
  }
}

function readLogMessage(dataDir: string, id: string): string | null {
  const db = new Database(join(dataDir, "logs.db"));
  try {
    const row = db.prepare("SELECT message FROM logs WHERE id = ?").get(id) as
      | { message: string }
      | undefined;
    return row?.message ?? null;
  } finally {
    db.close();
  }
}

function expectPointersReconstructRawEvents(
  dataDir: string,
  pointers: EventPointer[],
) {
  const seenIds = new Set<string>();
  const rangesBySegment = new Map<
    string,
    Array<{ start: number; end: number; eventId: string }>
  >();

  for (const pointer of pointers) {
    expect(seenIds.has(pointer.event_id)).toBe(false);
    seenIds.add(pointer.event_id);

    const segment = readFileSync(join(dataDir, pointer.segment_path));
    const start = pointer.byte_offset;
    const end = pointer.byte_offset + pointer.byte_length;
    const raw = segment.subarray(start, end);
    expect(end).toBeLessThanOrEqual(segment.byteLength);
    expect(raw.at(-1)).toBe(10);
    expect(createHash("sha256").update(raw).digest("hex")).toBe(
      pointer.record_hash,
    );

    const parsed = JSON.parse(raw.toString("utf8")) as { event_id?: string };
    expect(parsed.event_id).toBe(pointer.event_id);

    const ranges = rangesBySegment.get(pointer.segment_path) ?? [];
    const previous = ranges.at(-1);
    if (previous) {
      expect(start).toBeGreaterThanOrEqual(previous.end);
    } else {
      expect(start).toBe(0);
    }
    ranges.push({ start, end, eventId: pointer.event_id });
    rangesBySegment.set(pointer.segment_path, ranges);
  }
}

function findSegmentFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findSegmentFiles(path));
    } else if (entry.isFile() && path.endsWith(".jsonl")) {
      files.push(path);
    }
  }
  return files.sort();
}

describe("logs doctor CLI", () => {
  test("verifies and rebuilds raw segment indexes", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "open-logs-doctor-cli-"));
    try {
      const push = runCli(
        ["push", "doctor event", "--level", "info", "--service", "cli-test"],
        dataDir,
      );
      expect(push.status).toBe(0);
      expect(push.stdout).toContain("Logged:");

      const verify = runCli(["doctor", "segments", "--json"], dataDir);
      expect(verify.status).toBe(0);
      const verifyJson = JSON.parse(verify.stdout) as {
        ok: boolean;
        checked_records: number;
        checked_segments: number;
      };
      expect(verifyJson.ok).toBe(true);
      expect(verifyJson.checked_records).toBe(1);
      expect(verifyJson.checked_segments).toBe(1);

      const rebuild = runCli(["doctor", "rebuild-index", "--json"], dataDir);
      expect(rebuild.status).toBe(0);
      const rebuildJson = JSON.parse(rebuild.stdout) as {
        rebuild: {
          indexed_events: number;
          indexed_segments: number;
          skipped_events: number;
          errors: string[];
        };
        verification: {
          ok: boolean;
          checked_records: number;
          checked_segments: number;
        };
      };
      expect(rebuildJson.rebuild).toEqual({
        indexed_events: 1,
        indexed_segments: 1,
        skipped_events: 0,
        errors: [],
      });
      expect(rebuildJson.verification.ok).toBe(true);
      expect(rebuildJson.verification.checked_records).toBe(1);
      expect(rebuildJson.verification.checked_segments).toBe(1);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("repairs malformed and partial raw segment lines", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "open-logs-doctor-repair-cli-"));
    try {
      const push = runCli(
        [
          "push",
          "repairable event",
          "--id",
          "doctor-repair-1",
          "--level",
          "info",
        ],
        dataDir,
      );
      expect(push.status).toBe(0);
      const [segmentFile] = findSegmentFiles(join(dataDir, "segments"));
      if (!segmentFile) throw new Error("expected segment file");
      writeFileSync(
        segmentFile,
        `${readFileSync(segmentFile, "utf8")}bad-json\n{"event_id":"partial"`,
      );

      const verifyBefore = runCli(["doctor", "segments", "--json"], dataDir);
      expect(verifyBefore.status).toBe(1);
      const before = JSON.parse(verifyBefore.stdout) as {
        ok: boolean;
        errors: string[];
      };
      expect(before.ok).toBe(false);
      expect(
        before.errors.some((error) =>
          error.includes("Malformed raw event line"),
        ),
      ).toBe(true);
      expect(
        before.errors.some((error) => error.includes("Partial raw event line")),
      ).toBe(true);

      const dryRun = runCli(["doctor", "repair-segments", "--json"], dataDir);
      expect(dryRun.status).toBe(0);
      const dryRunJson = JSON.parse(dryRun.stdout) as {
        applied: boolean;
        repaired_segments: number;
        repairs: Array<{
          quarantine_path: string;
          removed_lines: Array<{ reason: string }>;
        }>;
      };
      expect(dryRunJson.applied).toBe(false);
      expect(dryRunJson.repaired_segments).toBe(1);
      expect(
        dryRunJson.repairs[0]?.removed_lines.map((line) => line.reason),
      ).toEqual(["malformed", "partial"]);
      expect(
        existsSync(join(dataDir, dryRunJson.repairs[0]?.quarantine_path ?? "")),
      ).toBe(false);

      const apply = runCli(
        ["doctor", "repair-segments", "--apply", "--json"],
        dataDir,
      );
      expect(apply.status).toBe(0);
      const applyJson = JSON.parse(apply.stdout) as {
        applied: boolean;
        repaired_segments: number;
        repairs: Array<{
          quarantine_path: string;
          quarantine_manifest_path: string;
        }>;
        rebuild?: {
          indexed_events: number;
          indexed_segments: number;
          skipped_events: number;
          errors: string[];
        };
        verification?: {
          ok: boolean;
          checked_records: number;
          checked_raw_events: number;
        };
      };
      expect(applyJson.applied).toBe(true);
      expect(applyJson.repaired_segments).toBe(1);
      expect(applyJson.rebuild).toEqual({
        indexed_events: 1,
        indexed_segments: 1,
        skipped_events: 0,
        errors: [],
      });
      expect(applyJson.verification?.ok).toBe(true);
      expect(applyJson.verification?.checked_records).toBe(1);
      expect(applyJson.verification?.checked_raw_events).toBe(1);
      expect(
        existsSync(join(dataDir, applyJson.repairs[0]?.quarantine_path ?? "")),
      ).toBe(true);
      expect(
        existsSync(
          join(dataDir, applyJson.repairs[0]?.quarantine_manifest_path ?? ""),
        ),
      ).toBe(true);

      const verifyAfter = runCli(["doctor", "segments", "--json"], dataDir);
      expect(verifyAfter.status).toBe(0);
      const after = JSON.parse(verifyAfter.stdout) as { ok: boolean };
      expect(after.ok).toBe(true);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("recovers from producer crashes before index and during partial raw writes", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "open-logs-crash-drill-cli-"));
    try {
      const crash = await runRawAppendCrashWorker(dataDir);
      expect(crash.status).toBe(42);
      expect(crash.stderr).toBe("");

      const verifyBefore = runCli(["doctor", "segments", "--json"], dataDir);
      expect(verifyBefore.status).toBe(1);
      const before = JSON.parse(verifyBefore.stdout) as {
        ok: boolean;
        checked_raw_events: number;
        unindexed_raw_events: number;
        errors: string[];
      };
      expect(before.ok).toBe(false);
      expect(before.checked_raw_events).toBe(1);
      expect(before.unindexed_raw_events).toBe(1);
      expect(
        before.errors.some((error) =>
          error.includes("Raw event is not indexed in SQLite"),
        ),
      ).toBe(true);

      const rebuild = runCli(["doctor", "rebuild-index", "--json"], dataDir);
      expect(rebuild.status).toBe(0);
      const rebuildJson = JSON.parse(rebuild.stdout) as {
        rebuild: {
          indexed_events: number;
          indexed_segments: number;
          skipped_events: number;
          errors: string[];
        };
        verification: {
          ok: boolean;
          checked_records: number;
          checked_raw_events: number;
          unindexed_raw_events: number;
        };
      };
      expect(rebuildJson.rebuild).toEqual({
        indexed_events: 1,
        indexed_segments: 1,
        skipped_events: 0,
        errors: [],
      });
      expect(rebuildJson.verification.ok).toBe(true);
      expect(rebuildJson.verification.checked_records).toBe(1);
      expect(rebuildJson.verification.checked_raw_events).toBe(1);
      expect(rebuildJson.verification.unindexed_raw_events).toBe(0);
      expect(readLogMessage(dataDir, "crash-raw-before-index")).toBe(
        "producer died after raw append",
      );

      const [segmentFile] = findSegmentFiles(join(dataDir, "segments"));
      if (!segmentFile) throw new Error("expected segment file");
      const partial = await runPartialTailCrashWriter(dataDir, segmentFile);
      expect(partial.status).toBe(137);
      expect(partial.stderr).toBe("");

      const verifyPartial = runCli(["doctor", "segments", "--json"], dataDir);
      expect(verifyPartial.status).toBe(1);
      const partialJson = JSON.parse(verifyPartial.stdout) as {
        ok: boolean;
        errors: string[];
      };
      expect(partialJson.ok).toBe(false);
      expect(
        partialJson.errors.some((error) =>
          error.includes("Partial raw event line"),
        ),
      ).toBe(true);

      const repair = runCli(
        ["doctor", "repair-segments", "--apply", "--json"],
        dataDir,
      );
      expect(repair.status).toBe(0);
      const repairJson = JSON.parse(repair.stdout) as {
        applied: boolean;
        repaired_segments: number;
        repairs: Array<{ removed_lines: Array<{ reason: string }> }>;
        rebuild?: {
          indexed_events: number;
          indexed_segments: number;
          skipped_events: number;
          errors: string[];
        };
        verification?: {
          ok: boolean;
          checked_records: number;
          checked_raw_events: number;
          unindexed_raw_events: number;
        };
      };
      expect(repairJson.applied).toBe(true);
      expect(repairJson.repaired_segments).toBe(1);
      expect(repairJson.repairs[0]?.removed_lines).toEqual([
        expect.objectContaining({ reason: "partial" }),
      ]);
      expect(repairJson.rebuild).toEqual({
        indexed_events: 1,
        indexed_segments: 1,
        skipped_events: 0,
        errors: [],
      });
      expect(repairJson.verification?.ok).toBe(true);
      expect(repairJson.verification?.checked_records).toBe(1);
      expect(repairJson.verification?.checked_raw_events).toBe(1);
      expect(repairJson.verification?.unindexed_raw_events).toBe(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("reports segment write errors before inserting log or event records", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "open-logs-write-error-cli-"));
    try {
      writeFileSync(join(dataDir, "segments"), "not a directory");

      const run = runCli(
        ["push", "write failure", "--id", "write-error-1"],
        dataDir,
      );
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain("ENOTDIR");
      expect(readCount(dataDir, "logs")).toBe(0);
      expect(readCount(dataDir, "event_records")).toBe(0);
      expect(readCount(dataDir, "event_segments")).toBe(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("verifies concurrent CLI producers against one data directory", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "open-logs-concurrent-cli-"));
    try {
      const runs = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          runCliAsync(
            [
              "push",
              `concurrent event ${i}`,
              "--level",
              "info",
              "--service",
              "parallel",
            ],
            dataDir,
          ),
        ),
      );

      for (const run of runs) {
        expect(run.status).toBe(0);
        expect(run.stdout).toContain("Logged:");
      }

      const verify = runCli(["doctor", "segments", "--json"], dataDir);
      expect(verify.status).toBe(0);
      const result = JSON.parse(verify.stdout) as {
        ok: boolean;
        checked_records: number;
        checked_segments: number;
        checked_raw_events: number;
        unindexed_raw_events: number;
      };
      expect(result.ok).toBe(true);
      expect(result.checked_records).toBe(12);
      expect(result.checked_raw_events).toBe(12);
      expect(result.unindexed_raw_events).toBe(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("deduplicates concurrent CLI producers with the same producer id", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "open-logs-concurrent-id-cli-"));
    try {
      const runs = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          runCliAsync(
            [
              "push",
              `duplicate event attempt ${i}`,
              "--id",
              "duplicate-cli-event",
              "--level",
              "info",
              "--service",
              "parallel",
            ],
            dataDir,
          ),
        ),
      );

      for (const run of runs) {
        expect(run.status).toBe(0);
        expect(run.stdout).toContain("Logged: duplicate-cli-event");
      }

      const verify = runCli(["doctor", "segments", "--json"], dataDir);
      expect(verify.status).toBe(0);
      const result = JSON.parse(verify.stdout) as {
        ok: boolean;
        checked_records: number;
        checked_raw_events: number;
        unindexed_raw_events: number;
      };
      expect(result.ok).toBe(true);
      expect(result.checked_records).toBe(1);
      expect(result.checked_raw_events).toBe(1);
      expect(result.unindexed_raw_events).toBe(0);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("keeps segment pointers exact under concurrent batch producers and rotation", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "open-logs-stress-cli-"));
    const workerCount = 10;
    const eventsPerWorker = 12;
    const expectedEvents = workerCount * eventsPerWorker;
    const stressEnv = {
      HASNA_LOGS_SEGMENT_MAX_BYTES: "2048",
      HASNA_LOGS_LOCK_TIMEOUT_MS: "30000",
    };

    try {
      const runs = await Promise.all(
        Array.from({ length: workerCount }, (_, i) =>
          runIngestWorker(dataDir, i, eventsPerWorker, stressEnv),
        ),
      );

      for (const run of runs) {
        expect(run.status).toBe(0);
        expect(run.stderr).toBe("");
      }

      const verify = runCli(["doctor", "segments", "--json"], dataDir);
      expect(verify.status).toBe(0);
      const result = JSON.parse(verify.stdout) as {
        ok: boolean;
        checked_records: number;
        checked_segments: number;
        checked_raw_events: number;
        unindexed_raw_events: number;
      };
      expect(result.ok).toBe(true);
      expect(result.checked_records).toBe(expectedEvents);
      expect(result.checked_raw_events).toBe(expectedEvents);
      expect(result.unindexed_raw_events).toBe(0);
      expect(result.checked_segments).toBeGreaterThan(1);

      const pointers = readEventPointers(dataDir);
      expect(pointers).toHaveLength(expectedEvents);
      expectPointersReconstructRawEvents(dataDir, pointers);

      const segmentFiles = findSegmentFiles(join(dataDir, "segments"));
      expect(segmentFiles.length).toBeGreaterThan(1);

      const rebuild = runCli(["doctor", "rebuild-index", "--json"], dataDir);
      expect(rebuild.status).toBe(0);
      const rebuildJson = JSON.parse(rebuild.stdout) as {
        rebuild: {
          indexed_events: number;
          indexed_segments: number;
          skipped_events: number;
          errors: string[];
        };
        verification: {
          ok: boolean;
          checked_records: number;
          checked_segments: number;
          checked_raw_events: number;
          unindexed_raw_events: number;
        };
      };
      expect(rebuildJson.rebuild.indexed_events).toBe(expectedEvents);
      expect(rebuildJson.rebuild.indexed_segments).toBe(segmentFiles.length);
      expect(rebuildJson.rebuild.skipped_events).toBe(0);
      expect(rebuildJson.rebuild.errors).toEqual([]);
      expect(rebuildJson.verification.ok).toBe(true);
      expect(rebuildJson.verification.checked_records).toBe(expectedEvents);
      expect(rebuildJson.verification.checked_raw_events).toBe(expectedEvents);
      expect(rebuildJson.verification.unindexed_raw_events).toBe(0);

      const rebuiltPointers = readEventPointers(dataDir);
      expect(rebuiltPointers).toHaveLength(expectedEvents);
      expectPointersReconstructRawEvents(dataDir, rebuiltPointers);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
