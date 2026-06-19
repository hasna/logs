#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TYPES = [
  "log",
  "metric",
  "span",
  "exception",
  "build",
  "process",
  "agent",
  "network",
] as const;

interface StressOptions {
  producerMode: boolean;
  producerId: number;
  producers: number;
  eventsPerProducer: number;
  stressId: string;
  dataDir?: string;
  output?: string;
  keep: boolean;
  segmentMaxBytes: number;
  lockTimeoutMs: number;
  producerTimeoutMs: number;
  minEventsPerSecond: number;
  fsync: boolean;
  rebuild: boolean;
  rawCheckLimit: number | "all";
  types: string[];
}

interface CommandResult {
  label: string;
  command: string[];
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

interface ProducerResult {
  producer_id: number;
  events: number;
  first_event_id: string;
  last_event_id: string;
  duration_ms: number;
  events_per_second: number;
  type_counts: Record<string, number>;
}

interface EventPointer {
  event_id: string;
  event_type: string;
  segment_path: string;
  byte_offset: number;
  byte_length: number;
  record_hash: string;
}

interface VerificationResult {
  event_count: number;
  distinct_event_ids: number;
  segment_count: number;
  segment_file_count: number;
  duplicate_event_ids: number;
  type_counts: Record<string, number>;
  missing_event_ids: string[];
  extra_event_ids: string[];
  raw_checked_events: number;
  raw_verification_mode: "all" | "limited";
  raw_check_limit: number | "all";
  sqlite_integrity: string;
  foreign_key_violations: number;
  pointer_errors: string[];
}

interface StressReport {
  ok: boolean;
  stress_id: string;
  started_at: string;
  ended_at: string;
  data_dir: string;
  data_dir_retained: boolean;
  config: {
    producers: number;
    events_per_producer: number;
    expected_events: number;
    types: string[];
    segment_max_bytes: number;
    lock_timeout_ms: number;
    producer_timeout_ms: number;
    min_events_per_second: number;
    fsync: boolean;
    segment_hash_on_append: boolean;
    rebuild: boolean;
    raw_check_limit: number | "all";
  };
  producers: ProducerResult[];
  commands: CommandResult[];
  expected_type_counts: Record<string, number>;
  before_rebuild: VerificationResult;
  after_rebuild: VerificationResult | null;
  doctor: Record<string, unknown>;
  rebuild: Record<string, unknown> | null;
  performance: {
    duration_ms: number;
    events_per_second: number;
    producer_min_events_per_second: number;
    producer_max_events_per_second: number;
  };
  report_file: string | null;
  assertions: string[];
}

const options = parseArgs(process.argv.slice(2));

if (options.producerMode) {
  await runProducer(options);
} else {
  await runCoordinator(options);
}

async function runCoordinator(options: StressOptions): Promise<void> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const dataDir = options.dataDir
    ? resolve(options.dataDir)
    : mkdtempSync(join(tmpdir(), "open-logs-high-volume-stress-"));
  const dbPath = join(dataDir, "logs.db");
  const expectedEvents = options.producers * options.eventsPerProducer;
  const commands: CommandResult[] = [];
  const assertions: string[] = [];
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const env = stressEnv(options, dataDir, dbPath);

  try {
    const producerRuns = await Promise.all(
      Array.from({ length: options.producers }, (_, producerId) =>
        runProducerProcess(options, producerId, env),
      ),
    );
    commands.push(...producerRuns.map((run) => run.command));
    const producers = producerRuns.map((run) => run.result);
    const producerEvents = sum(producers.map((producer) => producer.events));
    assert(
      producerEvents === expectedEvents,
      `producers reported ${expectedEvents} written events`,
      assertions,
    );
    for (const producer of producers) {
      assert(
        producer.events === options.eventsPerProducer,
        `producer ${producer.producer_id} wrote ${options.eventsPerProducer} events`,
        assertions,
      );
    }

    const beforeRebuild = verifyDatabase(dbPath, dataDir, options, assertions);
    assert(
      beforeRebuild.event_count === expectedEvents,
      "SQLite event_records count matches expected events before rebuild",
      assertions,
    );
    assert(
      beforeRebuild.distinct_event_ids === expectedEvents,
      "SQLite has no duplicate stress event IDs before rebuild",
      assertions,
    );
    if (shouldRequireSegmentRotation(options)) {
      assert(
        beforeRebuild.segment_count > 1,
        "stress run forced multiple raw segment rows",
        assertions,
      );
      assert(
        beforeRebuild.segment_file_count > 1,
        "stress run forced multiple raw segment files",
        assertions,
      );
    }

    const doctor = await runCli(
      "logs doctor segments",
      ["doctor", "segments", "--json"],
      env,
      120_000,
    );
    commands.push(doctor);
    const doctorResult = JSON.parse(doctor.stdout) as Record<string, unknown>;
    assert(
      doctorResult.ok === true,
      "doctor segments verified raw store",
      assertions,
    );
    assertNumberEquals(
      doctorResult,
      "checked_records",
      expectedEvents,
      assertions,
    );
    assertNumberEquals(
      doctorResult,
      "checked_raw_events",
      expectedEvents,
      assertions,
    );
    assertNumberEquals(doctorResult, "unindexed_raw_events", 0, assertions);

    let rebuildResult: Record<string, unknown> | null = null;
    let afterRebuild: VerificationResult | null = null;
    if (options.rebuild) {
      const rebuild = await runCli(
        "logs doctor rebuild-index",
        ["doctor", "rebuild-index", "--json"],
        env,
        180_000,
      );
      commands.push(rebuild);
      rebuildResult = JSON.parse(rebuild.stdout) as Record<string, unknown>;
      const rebuildStats = readRecord(rebuildResult, "rebuild");
      const verificationStats = readRecord(rebuildResult, "verification");
      assertNumberEquals(
        rebuildStats,
        "indexed_events",
        expectedEvents,
        assertions,
      );
      assertNumberEquals(rebuildStats, "skipped_events", 0, assertions);
      assert(
        verificationStats.ok === true,
        "rebuild verification is ok",
        assertions,
      );
      assertNumberEquals(
        verificationStats,
        "checked_records",
        expectedEvents,
        assertions,
      );
      assertNumberEquals(
        verificationStats,
        "checked_raw_events",
        expectedEvents,
        assertions,
      );
      assertNumberEquals(
        verificationStats,
        "unindexed_raw_events",
        0,
        assertions,
      );
      afterRebuild = verifyDatabase(dbPath, dataDir, options, assertions);
      assert(
        afterRebuild.event_count === expectedEvents,
        "SQLite event_records count matches expected events after rebuild",
        assertions,
      );
      assert(
        afterRebuild.distinct_event_ids === expectedEvents,
        "SQLite has no duplicate stress event IDs after rebuild",
        assertions,
      );
    }

    const durationMs = Math.max(1, Math.round(performance.now() - started));
    const eventsPerSecond = expectedEvents / (durationMs / 1000);
    const producerRates = producers.map(
      (producer) => producer.events_per_second,
    );
    if (shouldEnforceRateFloor(options)) {
      assert(
        eventsPerSecond >= options.minEventsPerSecond,
        `aggregate writer rate met ${options.minEventsPerSecond} events/sec floor`,
        assertions,
      );
    }

    const reportFile =
      options.output ??
      (options.keep || options.dataDir
        ? join(dataDir, "high-volume-ingest-stress-report.json")
        : null);
    const report: StressReport = {
      ok: true,
      stress_id: options.stressId,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      data_dir: dataDir,
      data_dir_retained: Boolean(options.keep || options.dataDir),
      config: {
        producers: options.producers,
        events_per_producer: options.eventsPerProducer,
        expected_events: expectedEvents,
        types: options.types,
        segment_max_bytes: options.segmentMaxBytes,
        lock_timeout_ms: options.lockTimeoutMs,
        producer_timeout_ms: options.producerTimeoutMs,
        min_events_per_second: options.minEventsPerSecond,
        fsync: options.fsync,
        segment_hash_on_append: false,
        rebuild: options.rebuild,
        raw_check_limit: options.rawCheckLimit,
      },
      producers,
      commands,
      expected_type_counts: expectedTypeCounts(options),
      before_rebuild: beforeRebuild,
      after_rebuild: afterRebuild,
      doctor: doctorResult,
      rebuild: rebuildResult,
      performance: {
        duration_ms: durationMs,
        events_per_second: roundRate(eventsPerSecond),
        producer_min_events_per_second: roundRate(Math.min(...producerRates)),
        producer_max_events_per_second: roundRate(Math.max(...producerRates)),
      },
      report_file: reportFile,
      assertions,
    };

    if (reportFile) {
      mkdirSync(dirname(reportFile), { recursive: true });
      writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    if (!options.keep && !options.dataDir) {
      rmSync(dataDir, { recursive: true, force: true });
    }
  }
}

async function runProducer(options: StressOptions): Promise<void> {
  const { getDb, closeDb } = await import("../src/db/index.ts");
  const { ingestLog } = await import("../src/lib/ingest.ts");
  const { ingestUniversalEvent } = await import(
    "../src/lib/universal-ingest.ts"
  );
  const db = getDb();
  const started = performance.now();
  const typeCounts: Record<string, number> = {};
  for (let index = 0; index < options.eventsPerProducer; index += 1) {
    const eventType = eventTypeFor(options, options.producerId, index);
    typeCounts[eventType] = (typeCounts[eventType] ?? 0) + 1;
    const eventId = eventIdFor(options.stressId, options.producerId, index);
    if (eventType === "log") {
      ingestLog(db, {
        id: eventId,
        level: logLevelFor(index),
        source: "sdk",
        service: `stress-producer-${options.producerId}`,
        message: `stress log ${options.producerId}/${index}`,
        trace_id: traceIdFor(options, index),
        session_id: sessionIdFor(options, index),
        machine_id: machineIdFor(options, options.producerId),
        repo_id: repoIdFor(options),
        app_id: appIdFor(options),
        process_id: processIdFor(options, options.producerId),
        run_id: runIdFor(options),
        environment: "stress",
        metadata: {
          stress_id: options.stressId,
          producer_id: options.producerId,
          sequence: index,
          event_type: eventType,
        },
      });
    } else {
      ingestUniversalEvent(db, {
        type: eventType as never,
        event_id: eventId,
        source: sourceFor(eventType),
        severity: severityFor(eventType, index),
        privacy: "internal",
        message: `stress ${eventType} ${options.producerId}/${index}`,
        trace_id: traceIdFor(options, index),
        span_id: eventType === "span" ? `${eventId}-span` : undefined,
        parent_span_id:
          eventType === "span" && index > 0
            ? `${eventIdFor(options.stressId, options.producerId, index - 1)}-span`
            : undefined,
        session_id: sessionIdFor(options, index),
        machine_id: machineIdFor(options, options.producerId),
        repo_id: repoIdFor(options),
        app_id: appIdFor(options),
        process_id: processIdFor(options, options.producerId),
        run_id: runIdFor(options),
        release_id: `${options.stressId}-release`,
        environment: "stress",
        body: bodyFor(eventType, options, index),
        attributes: {
          stress_id: options.stressId,
          producer_id: options.producerId,
          sequence: index,
          name: `stress.${eventType}`,
          operation: `stress.${eventType}`,
          duration_ms: (index % 200) + 1,
          value: index,
          status: eventType === "exception" ? "error" : "ok",
          service: `stress-producer-${options.producerId}`,
        },
      });
    }
  }
  closeDb();
  const durationMs = Math.max(1, Math.round(performance.now() - started));
  const result: ProducerResult = {
    producer_id: options.producerId,
    events: options.eventsPerProducer,
    first_event_id: eventIdFor(options.stressId, options.producerId, 0),
    last_event_id: eventIdFor(
      options.stressId,
      options.producerId,
      options.eventsPerProducer - 1,
    ),
    duration_ms: durationMs,
    events_per_second: roundRate(
      options.eventsPerProducer / (durationMs / 1000),
    ),
    type_counts: typeCounts,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function runProducerProcess(
  options: StressOptions,
  producerId: number,
  env: Record<string, string>,
): Promise<{ command: CommandResult; result: ProducerResult }> {
  const args = [
    "scripts/high-volume-ingest-stress.ts",
    "--producer",
    String(producerId),
    "--stress-id",
    options.stressId,
    "--producers",
    String(options.producers),
    "--events",
    String(options.eventsPerProducer),
    "--types",
    options.types.join(","),
  ];
  const command = [process.execPath, ...args];
  const child = Bun.spawn(command, {
    cwd: repoRoot,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const result = await waitForProcess(
    `producer ${producerId}`,
    command,
    child,
    options.producerTimeoutMs,
  );
  const parsed = JSON.parse(result.stdout.trim()) as ProducerResult;
  return { command: result, result: parsed };
}

function verifyDatabase(
  dbPath: string,
  dataDir: string,
  options: StressOptions,
  assertions: string[],
): VerificationResult {
  const expectedEvents = options.producers * options.eventsPerProducer;
  const expectedIds = expectedEventIds(options);
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        "SELECT event_id, event_type, segment_path, byte_offset, byte_length, record_hash FROM event_records WHERE event_id LIKE ? ORDER BY segment_path, byte_offset",
      )
      .all(`${options.stressId}-%`) as EventPointer[];
    const actualIds = new Set(rows.map((row) => row.event_id));
    const missingEventIds = expectedIds.filter(
      (eventId) => !actualIds.has(eventId),
    );
    const expectedSet = new Set(expectedIds);
    const extraEventIds = rows
      .map((row) => row.event_id)
      .filter((eventId) => !expectedSet.has(eventId));
    const typeCounts = countBy(rows.map((row) => row.event_type));
    const expectedTypes = expectedTypeCounts(options);
    assert(
      JSON.stringify(typeCounts) === JSON.stringify(expectedTypes),
      "event type distribution matches expected mixed telemetry distribution",
      assertions,
    );
    assert(
      missingEventIds.length === 0,
      "no expected event IDs are missing",
      assertions,
    );
    assert(
      extraEventIds.length === 0,
      "no extra stress event IDs were indexed",
      assertions,
    );

    const pointerErrors: string[] = [];
    const rawCheckedEvents = verifyRawPointers(
      dataDir,
      rows,
      options,
      pointerErrors,
    );
    assert(
      pointerErrors.length === 0,
      "raw segment pointers reconstruct events",
      assertions,
    );

    const integrity = db.prepare("PRAGMA integrity_check").all() as Array<{
      integrity_check: string;
    }>;
    const sqliteIntegrity = integrity
      .map((row) => row.integrity_check)
      .join("\n");
    const foreignKeys = db
      .prepare("PRAGMA foreign_key_check")
      .all() as unknown[];
    assert(
      sqliteIntegrity === "ok",
      "SQLite integrity_check is ok",
      assertions,
    );
    assert(
      foreignKeys.length === 0,
      "SQLite foreign_key_check has no violations",
      assertions,
    );

    return {
      event_count: rows.length,
      distinct_event_ids: actualIds.size,
      segment_count: countRows(db, "event_segments"),
      segment_file_count: segmentFileCount(dataDir),
      duplicate_event_ids: rows.length - actualIds.size,
      type_counts: typeCounts,
      missing_event_ids: missingEventIds.slice(0, 20),
      extra_event_ids: extraEventIds.slice(0, 20),
      raw_checked_events: rawCheckedEvents,
      raw_verification_mode:
        options.rawCheckLimit === "all" ||
        options.rawCheckLimit >= expectedEvents
          ? "all"
          : "limited",
      raw_check_limit: options.rawCheckLimit,
      sqlite_integrity: sqliteIntegrity,
      foreign_key_violations: foreignKeys.length,
      pointer_errors: pointerErrors.slice(0, 20),
    };
  } finally {
    db.close();
  }
}

function verifyRawPointers(
  dataDir: string,
  rows: EventPointer[],
  options: StressOptions,
  errors: string[],
): number {
  const limit =
    options.rawCheckLimit === "all"
      ? rows.length
      : Math.min(options.rawCheckLimit, rows.length);
  const selected = rows.slice(0, limit);
  let checked = 0;
  const bySegment = new Map<string, EventPointer[]>();
  for (const row of selected) {
    const list = bySegment.get(row.segment_path) ?? [];
    list.push(row);
    bySegment.set(row.segment_path, list);
  }
  for (const [segmentPath, pointers] of bySegment) {
    const absolutePath = resolve(dataDir, ...segmentPath.split("/"));
    let bytes: Buffer;
    try {
      bytes = readFileSync(absolutePath);
    } catch (error) {
      errors.push(`Unable to read ${segmentPath}: ${errorMessage(error)}`);
      continue;
    }
    let lastEnd = 0;
    for (const pointer of pointers) {
      if (pointer.byte_offset < lastEnd) {
        errors.push(
          `Overlapping pointer for ${pointer.event_id} in ${segmentPath}`,
        );
      }
      if (pointer.byte_offset + pointer.byte_length > bytes.byteLength) {
        errors.push(`Pointer beyond segment length for ${pointer.event_id}`);
        continue;
      }
      const line = bytes.subarray(
        pointer.byte_offset,
        pointer.byte_offset + pointer.byte_length,
      );
      if (sha256(line) !== pointer.record_hash) {
        errors.push(`Hash mismatch for ${pointer.event_id}`);
        continue;
      }
      try {
        const event = JSON.parse(line.toString("utf8")) as {
          event_id?: unknown;
        };
        if (event.event_id !== pointer.event_id) {
          errors.push(`Raw event ID mismatch for ${pointer.event_id}`);
        }
      } catch (error) {
        errors.push(
          `Raw JSON parse failed for ${pointer.event_id}: ${errorMessage(error)}`,
        );
      }
      checked += 1;
      lastEnd = pointer.byte_offset + pointer.byte_length;
    }
  }
  return checked;
}

async function runCli(
  label: string,
  args: string[],
  env: Record<string, string>,
  timeoutMs: number,
): Promise<CommandResult> {
  const command = [process.execPath, "src/cli/index.ts", ...args];
  const child = Bun.spawn(command, {
    cwd: repoRoot,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return await waitForProcess(label, command, child, timeoutMs);
}

async function waitForProcess(
  label: string,
  command: string[],
  child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>,
  timeoutMs: number,
): Promise<CommandResult> {
  const started = performance.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  const exitCode = await child.exited;
  clearTimeout(timer);
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const result = {
    label,
    command,
    exit_code: exitCode,
    stdout,
    stderr,
    duration_ms: Math.max(0, Math.round(performance.now() - started)),
  };
  if (timedOut) throw new Error(`${label} timed out after ${timeoutMs}ms`);
  if (exitCode !== 0) {
    throw new Error(
      `${label} failed with exit ${exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
    );
  }
  return result;
}

function parseArgs(args: string[]): StressOptions {
  const result: StressOptions = {
    producerMode: false,
    producerId: 0,
    producers: 10,
    eventsPerProducer: 500,
    stressId: `stress-${randomBytes(6).toString("hex")}`,
    keep: false,
    segmentMaxBytes: 64 * 1024,
    lockTimeoutMs: 120_000,
    producerTimeoutMs: 180_000,
    minEventsPerSecond: 25,
    fsync: false,
    rebuild: true,
    rawCheckLimit: "all",
    types: [...DEFAULT_TYPES],
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--producer") {
      result.producerMode = true;
      index += 1;
      result.producerId = Number(requireValue(args, index, arg));
      continue;
    }
    if (arg === "--producers") {
      index += 1;
      result.producers = positiveInt(requireValue(args, index, arg), arg);
      continue;
    }
    if (arg === "--events" || arg === "--events-per-producer") {
      index += 1;
      result.eventsPerProducer = positiveInt(
        requireValue(args, index, arg),
        arg,
      );
      continue;
    }
    if (arg === "--stress-id") {
      index += 1;
      result.stressId = requireValue(args, index, arg);
      continue;
    }
    if (arg === "--data-dir") {
      index += 1;
      result.dataDir = requireValue(args, index, arg);
      continue;
    }
    if (arg === "--output") {
      index += 1;
      result.output = requireValue(args, index, arg);
      continue;
    }
    if (arg === "--keep") {
      result.keep = true;
      continue;
    }
    if (arg === "--segment-max-bytes") {
      index += 1;
      result.segmentMaxBytes = positiveInt(requireValue(args, index, arg), arg);
      continue;
    }
    if (arg === "--lock-timeout-ms") {
      index += 1;
      result.lockTimeoutMs = positiveInt(requireValue(args, index, arg), arg);
      continue;
    }
    if (arg === "--producer-timeout-ms") {
      index += 1;
      result.producerTimeoutMs = positiveInt(
        requireValue(args, index, arg),
        arg,
      );
      continue;
    }
    if (arg === "--min-events-per-second") {
      index += 1;
      result.minEventsPerSecond = positiveNumber(
        requireValue(args, index, arg),
        arg,
      );
      continue;
    }
    if (arg === "--fsync") {
      result.fsync = true;
      continue;
    }
    if (arg === "--skip-rebuild") {
      result.rebuild = false;
      continue;
    }
    if (arg === "--raw-check-limit") {
      index += 1;
      const value = requireValue(args, index, arg);
      result.rawCheckLimit = value === "all" ? "all" : positiveInt(value, arg);
      continue;
    }
    if (arg === "--types") {
      index += 1;
      result.types = requireValue(args, index, arg)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: bun scripts/high-volume-ingest-stress.ts [options]",
          "",
          "Options:",
          "  --producers <n>              concurrent producer count (default: 10)",
          "  --events <n>                 events per producer (default: 500)",
          "  --types <csv>                mixed event types (default: log,metric,span,exception,build,process,agent,network)",
          "  --data-dir <dir>             use and retain an explicit data directory",
          "  --keep                       retain the temporary data directory and report",
          "  --output <file>              write the JSON report to a specific file",
          "  --segment-max-bytes <n>      force rotation threshold (default: 65536)",
          "  --min-events-per-second <n>  aggregate writer-rate floor (default: 25)",
          "  --raw-check-limit <n|all>    raw pointer reconstruction limit (default: all)",
          "  --skip-rebuild               skip doctor rebuild-index verification",
          "  --fsync                      enable per-append fsync during stress",
        ].join("\n"),
      );
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  if (result.types.length === 0) throw new Error("--types cannot be empty");
  if (result.producerId < 0 || result.producerId >= result.producers) {
    throw new Error("--producer must be in the range [0, producers)");
  }
  if (!/^[a-zA-Z0-9.-]+$/.test(result.stressId)) {
    throw new Error(
      "--stress-id may contain only letters, numbers, dots, and hyphens",
    );
  }
  return result;
}

function stressEnv(
  options: StressOptions,
  dataDir: string,
  dbPath: string,
): Record<string, string> {
  return {
    ...process.env,
    HASNA_LOGS_DATA_DIR: dataDir,
    HASNA_LOGS_DB_PATH: dbPath,
    HASNA_LOGS_SEGMENT_MAX_BYTES: String(options.segmentMaxBytes),
    HASNA_LOGS_LOCK_TIMEOUT_MS: String(options.lockTimeoutMs),
    HASNA_LOGS_FSYNC: options.fsync ? "1" : "0",
    HASNA_LOGS_SEGMENT_HASH_ON_APPEND: "0",
    LOGS_DATA_DIR: "",
    LOGS_DB_PATH: "",
  };
}

function eventTypeFor(
  options: Pick<StressOptions, "types">,
  producerId: number,
  sequence: number,
): string {
  return options.types[(producerId + sequence) % options.types.length] ?? "log";
}

function expectedTypeCounts(options: StressOptions): Record<string, number> {
  const counts: Record<string, number> = {};
  for (let producerId = 0; producerId < options.producers; producerId += 1) {
    for (
      let sequence = 0;
      sequence < options.eventsPerProducer;
      sequence += 1
    ) {
      const type = eventTypeFor(options, producerId, sequence);
      counts[type] = (counts[type] ?? 0) + 1;
    }
  }
  return sortRecord(counts);
}

function expectedEventIds(options: StressOptions): string[] {
  const ids: string[] = [];
  for (let producerId = 0; producerId < options.producers; producerId += 1) {
    for (
      let sequence = 0;
      sequence < options.eventsPerProducer;
      sequence += 1
    ) {
      ids.push(eventIdFor(options.stressId, producerId, sequence));
    }
  }
  return ids;
}

function shouldRequireSegmentRotation(options: StressOptions): boolean {
  return options.producers * options.eventsPerProducer >= 100;
}

function shouldEnforceRateFloor(options: StressOptions): boolean {
  return options.producers * options.eventsPerProducer >= 100;
}

function eventIdFor(
  stressId: string,
  producerId: number,
  sequence: number,
): string {
  return `${stressId}-p${producerId}-e${sequence}`;
}

function traceIdFor(options: StressOptions, sequence: number): string {
  return `${options.stressId}-trace-${sequence % 100}`;
}

function sessionIdFor(options: StressOptions, sequence: number): string {
  return `${options.stressId}-session-${sequence % 25}`;
}

function runIdFor(options: StressOptions): string {
  return `${options.stressId}-run`;
}

function machineIdFor(options: StressOptions, producerId: number): string {
  return `${options.stressId}-machine-${producerId % 4}`;
}

function repoIdFor(options: StressOptions): string {
  return `${options.stressId}-repo`;
}

function appIdFor(options: StressOptions): string {
  return `${options.stressId}-app`;
}

function processIdFor(options: StressOptions, producerId: number): string {
  return `${options.stressId}-proc-${producerId}`;
}

function sourceFor(type: string): string {
  if (type === "agent") return "agent";
  if (type === "process" || type === "build") return "cli";
  if (type === "network") return "node";
  return "sdk";
}

function severityFor(type: string, sequence: number): string {
  if (type === "exception") return "error";
  if (type === "build" && sequence % 17 === 0) return "warn";
  return "info";
}

function logLevelFor(sequence: number): "debug" | "info" | "warn" | "error" {
  if (sequence % 29 === 0) return "error";
  if (sequence % 11 === 0) return "warn";
  if (sequence % 7 === 0) return "debug";
  return "info";
}

function bodyFor(
  eventType: string,
  options: StressOptions,
  sequence: number,
): Record<string, unknown> {
  if (eventType === "metric") {
    return { name: "stress.metric", value: sequence, unit: "count" };
  }
  if (eventType === "exception") {
    return { stack_trace: `Error: stress ${sequence}\n    at producer` };
  }
  if (eventType === "network") {
    return {
      method: "GET",
      status_code: 200 + (sequence % 5),
      path: "/stress",
    };
  }
  return { stress_id: options.stressId, sequence };
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return sortRecord(counts);
}

function sortRecord(input: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(input).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function segmentFileCount(dataDir: string): number {
  const db = new Database(join(dataDir, "logs.db"), { readonly: true });
  try {
    const rows = db
      .prepare(
        "SELECT relative_path FROM event_segments ORDER BY relative_path",
      )
      .all() as Array<{ relative_path: string }>;
    return rows.filter((row) => existsSync(join(dataDir, row.relative_path)))
      .length;
  } finally {
    db.close();
  }
}

function countRows(db: Database, table: string): number {
  return Number(
    (
      db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number;
      }
    ).count,
  );
}

function readRecord(
  source: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  const value = source[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected object field: ${field}`);
  }
  return value as Record<string, unknown>;
}

function assertNumberEquals(
  source: Record<string, unknown>,
  field: string,
  expected: number,
  assertions: string[],
): void {
  const value = source[field];
  assert(
    typeof value === "number" && value === expected,
    `${field} equals ${expected}`,
    assertions,
  );
}

function assert(
  condition: unknown,
  message: string,
  assertions: string[],
): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  assertions.push(message);
}

function requireValue(args: string[], index: number, label: string): string {
  const value = args[index];
  if (!value) throw new Error(`${label} requires a value`);
  return value;
}

function positiveInt(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function positiveNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return parsed;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function roundRate(value: number): number {
  return Math.round(value * 100) / 100;
}

function sha256(input: Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
