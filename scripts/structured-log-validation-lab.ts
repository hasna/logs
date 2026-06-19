#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPinoOpenLogsTransport,
  createWinstonOpenLogsTransport,
} from "../sdk/src/index.ts";
import { readRawEvent, setEventStoreDataDir } from "../src/lib/event-store.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface LabOptions {
  dataDir?: string;
  output?: string;
  keep: boolean;
  port?: number;
}

interface CommandResult {
  label: string;
  command: string[];
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

interface StructuredLogValidationReport {
  ok: boolean;
  validation_id: string;
  started_at: string;
  ended_at: string;
  data_dir: string;
  data_dir_retained: boolean;
  server: {
    base_url: string;
    port: number;
  };
  jsonl_file: string;
  commands: CommandResult[];
  import_summary: Record<string, unknown>;
  streamed_messages: string[];
  http_events: Array<Record<string, unknown>>;
  sdk_transport_messages: string[];
  doctor: Record<string, unknown>;
  counts: {
    logs: number;
    event_records: number;
    event_segments: number;
    sources: Record<string, number>;
    raw_events_checked: number;
  };
  report_file: string;
  assertions: string[];
}

const options = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();
const validationId = `structured-log-lab-${Date.now()}`;
const dataDir = options.dataDir
  ? resolve(options.dataDir)
  : mkdtempSync(join(tmpdir(), "open-logs-structured-log-lab-"));
const dbPath = join(dataDir, "logs.db");
const token = `structured-log-token-${Date.now()}`;
const jsonlFile = join(dataDir, "app.jsonl");
const commands: CommandResult[] = [];
const assertions: string[] = [];
const secret = "OPENLOGS_SECRET_CANARY_structured_lab_12345";

if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

const env = {
  ...process.env,
  HASNA_LOGS_DATA_DIR: dataDir,
  HASNA_LOGS_DB_PATH: dbPath,
  HASNA_LOGS_FSYNC: "0",
  HASNA_LOGS_API_TOKEN: token,
  LOGS_DATA_DIR: "",
  LOGS_DB_PATH: "",
};

let server: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> | undefined;

try {
  const port = options.port ?? (await getFreePort());
  const baseUrl = `http://127.0.0.1:${port}`;
  server = Bun.spawn([process.execPath, "src/server/index.ts"], {
    cwd: repoRoot,
    env: { ...env, LOGS_PORT: String(port) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForHealth(baseUrl, server);

  const project = await runCli("project create", [
    "project",
    "create",
    "--name",
    validationId,
    "--url",
    baseUrl,
  ]);
  commands.push(project);
  const projectId = parseCreatedProjectId(project.stdout);

  const watchArgs = [
    "watch",
    "--server",
    baseUrl,
    "--token",
    token,
    "--type",
    "log",
    "--format",
    "json",
  ];
  const watcher = spawnCli(watchArgs);
  await sleep(400);

  writeFileSync(jsonlFile, "");
  const followerArgs = [
    "import-jsonl",
    jsonlFile,
    "--follow",
    "--format",
    "auto",
    "--project",
    validationId,
    "--environment",
    "test",
    "--poll",
    "50",
    "--idle-timeout",
    "900",
    "--json",
  ];
  const follower = spawnCli(followerArgs);
  await sleep(150);

  appendFileSync(
    jsonlFile,
    `${JSON.stringify({
      level: 30,
      time: 1781596800000,
      msg: `structured lab followed pino token=${secret}`,
      name: "structured-lab-api",
      traceId: `${validationId}-trace-follow-pino`,
      token: secret,
    })}\n`,
  );
  appendFileSync(
    jsonlFile,
    `${JSON.stringify({
      level: "warn",
      timestamp: "2026-06-16T08:00:01.000Z",
      message: `structured lab followed winston token=${secret}`,
      service: "structured-lab-worker",
      trace_id: `${validationId}-trace-follow-winston`,
      password: secret,
    })}\n`,
  );

  const importResult = await waitForProcess(
    "logs import-jsonl --follow",
    [process.execPath, "src/cli/index.ts", ...followerArgs],
    follower,
    6_000,
  );
  commands.push(importResult);
  const importSummary = parseJsonObject(importResult.stdout);
  assert(
    importSummary.inserted === 2,
    "follow importer inserted two JSONL logs",
  );
  assertions.push("follow importer inserted two appended JSONL logs");

  const httpPino = await postStructured(baseUrl, token, projectId, {
    level: 50,
    time: 1781596802000,
    msg: `structured lab HTTP pino token=${secret}`,
    name: "structured-lab-api",
    traceId: `${validationId}-trace-http-pino`,
    api_key: secret,
  });
  const httpWinston = await postStructured(baseUrl, token, projectId, {
    format: "winston",
    service: "structured-lab-worker",
    logs: [
      {
        level: "error",
        timestamp: "2026-06-16T08:00:03.000Z",
        message: `structured lab HTTP winston token=${secret}`,
        trace_id: `${validationId}-trace-http-winston`,
        secret,
      },
    ],
  });
  const sdkTransportMessages = await writeSdkTransportLogs(
    baseUrl,
    token,
    projectId,
    validationId,
    secret,
  );

  await sleep(1_500);
  watcher.kill("SIGTERM");
  const watchResult = await waitForProcess(
    "logs watch --server structured logs",
    [process.execPath, "src/cli/index.ts", ...watchArgs],
    watcher,
    6_000,
    [0, 143],
  );
  commands.push(watchResult);
  const streamedMessages = parseWatchMessages(watchResult.stdout);
  for (const message of [
    "structured lab followed pino",
    "structured lab followed winston",
    "structured lab HTTP pino",
    "structured lab HTTP winston",
    "structured lab SDK pino",
    "structured lab SDK winston",
  ]) {
    assert(
      streamedMessages.some((seen) => seen.includes(message)),
      `remote stream observed ${message}`,
    );
  }
  assertions.push(
    "remote server watch observed JSONL, HTTP, and SDK transport structured logs",
  );

  const doctorResult = await runCli("logs doctor segments", [
    "doctor",
    "segments",
    "--json",
  ]);
  commands.push(doctorResult);
  const doctor = parseJsonObject(doctorResult.stdout);
  assert(
    Number(doctor.unindexed_raw_events ?? 0) === 0,
    "doctor segments reports zero unindexed raw events",
  );
  assertions.push("doctor segments reported zero unindexed raw events");

  const counts = readCounts(dbPath, dataDir, secret);
  assert(counts.sources.pino >= 3, "pino source rows were indexed");
  assert(counts.sources.winston >= 3, "winston source rows were indexed");
  assert(counts.raw_events_checked >= 6, "raw events were reconstructed");
  assertions.push("SQLite metadata and raw event reconstruction validated");

  const reportFile = resolve(
    options.output ?? join(dataDir, "structured-log-validation-report.json"),
  );
  const report: StructuredLogValidationReport = {
    ok: true,
    validation_id: validationId,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    data_dir: dataDir,
    data_dir_retained:
      options.keep || Boolean(options.dataDir) || Boolean(options.output),
    server: { base_url: baseUrl, port },
    jsonl_file: jsonlFile,
    commands,
    import_summary: importSummary,
    streamed_messages: streamedMessages,
    http_events: [...eventSummaries(httpPino), ...eventSummaries(httpWinston)],
    sdk_transport_messages: sdkTransportMessages,
    doctor,
    counts,
    report_file: reportFile,
    assertions,
  };

  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    [
      "Structured log validation passed.",
      `Report: ${reportFile}`,
      `Data dir: ${dataDir}${report.data_dir_retained ? " (retained)" : " (temporary)"}`,
      `Sources: ${JSON.stringify(counts.sources)}`,
    ].join("\n"),
  );
} catch (error) {
  process.stderr.write(
    `Structured log validation failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  server?.kill("SIGTERM");
  await server?.exited.catch(() => undefined);
  if (!options.keep && !options.dataDir && !options.output) {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function parseArgs(args: string[]): LabOptions {
  const parsed: LabOptions = { keep: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--keep") parsed.keep = true;
    else if (arg === "--data-dir")
      parsed.dataDir = requireValue(args, ++index, arg);
    else if (arg === "--output")
      parsed.output = requireValue(args, ++index, arg);
    else if (arg === "--port")
      parsed.port = Number(requireValue(args, ++index, arg));
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: bun scripts/structured-log-validation-lab.ts [options]",
          "",
          "Options:",
          "  --keep              Retain the temporary data directory",
          "  --data-dir <path>   Use an explicit data directory",
          "  --output <path>     Write the JSON report to this path",
          "  --port <port>       Use an explicit server port",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate port"));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForHealth(
  baseUrl: string,
  child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>,
): Promise<void> {
  const started = performance.now();
  while (performance.now() - started < 8_000) {
    const exited = await Promise.race([
      child.exited.then((code) => ({ code })),
      sleep(50).then(() => null),
    ]);
    if (exited)
      throw new Error(`Server exited before health check: ${exited.code}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Retry until timeout.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${baseUrl}/health`);
}

async function runCli(label: string, args: string[]): Promise<CommandResult> {
  const child = spawnCli(args);
  return await waitForProcess(
    label,
    [process.execPath, "src/cli/index.ts", ...args],
    child,
    20_000,
  );
}

function spawnCli(
  args: string[],
): ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> {
  return Bun.spawn([process.execPath, "src/cli/index.ts", ...args], {
    cwd: repoRoot,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function waitForProcess(
  label: string,
  command: string[],
  child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>,
  timeoutMs: number,
  allowedExitCodes = [0],
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
  if (!allowedExitCodes.includes(exitCode)) {
    throw new Error(
      `${label} failed with exit ${exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
    );
  }
  return result;
}

function parseCreatedProjectId(stdout: string): string {
  const match = /Created project:\s+([^\s]+)/.exec(stdout);
  if (!match?.[1])
    throw new Error(`Unable to parse project id from: ${stdout}`);
  return match[1];
}

async function postStructured(
  baseUrl: string,
  token: string,
  projectId: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `${baseUrl}/api/logs/structured?project_id=${encodeURIComponent(projectId)}&environment=test`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `POST /api/logs/structured failed ${response.status}: ${text}`,
    );
  }
  return JSON.parse(text) as Record<string, unknown>;
}

async function writeSdkTransportLogs(
  baseUrl: string,
  token: string,
  projectId: string,
  validationId: string,
  secret: string,
): Promise<string[]> {
  const pinoMessage = `structured lab SDK pino token=${secret}`;
  const pinoTransport = createPinoOpenLogsTransport({
    url: baseUrl,
    apiKey: token,
    projectId,
    service: "structured-lab-api",
    environment: "test",
    maxBatchSize: 10,
    flushIntervalMs: 60_000,
    sourceEventPrefix: `${validationId}:sdk-pino`,
  });
  pinoTransport.write(
    `${JSON.stringify({
      level: 30,
      time: 1781596804000,
      msg: pinoMessage,
      name: "structured-lab-api",
      traceId: `${validationId}-trace-sdk-pino`,
      token: secret,
    })}\n`,
  );
  await pinoTransport.flush();
  pinoTransport.stop();

  const winstonMessage = `structured lab SDK winston token=${secret}`;
  const winstonTransport = createWinstonOpenLogsTransport({
    url: baseUrl,
    apiKey: token,
    projectId,
    service: "structured-lab-worker",
    environment: "test",
    maxBatchSize: 10,
    flushIntervalMs: 60_000,
    sourceEventPrefix: `${validationId}:sdk-winston`,
    metadata: { validation_id: validationId, producer: "sdk-winston" },
  });
  winstonTransport.log({
    level: "error",
    timestamp: "2026-06-16T08:00:05.000Z",
    message: winstonMessage,
    trace_id: `${validationId}-trace-sdk-winston`,
    secret,
  });
  await Promise.resolve();
  await winstonTransport.flush();
  winstonTransport.close();

  return [
    pinoMessage.replace(secret, "[REDACTED]"),
    winstonMessage.replace(secret, "[REDACTED]"),
  ];
}

function parseJsonObject(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object, got: ${text}`);
  }
  return parsed as Record<string, unknown>;
}

function parseWatchMessages(stdout: string): string[] {
  return stdout
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map((event) => String(event.message ?? ""));
}

function eventSummaries(
  response: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const events = response.events;
  return Array.isArray(events)
    ? events.filter((event): event is Record<string, unknown> =>
        Boolean(event && typeof event === "object" && !Array.isArray(event)),
      )
    : [];
}

function readCounts(
  dbFile: string,
  eventStoreDir: string,
  canary: string,
): StructuredLogValidationReport["counts"] {
  const db = new Database(dbFile, { readonly: true });
  setEventStoreDataDir(db, eventStoreDir);
  try {
    const sources = db
      .prepare(
        "SELECT source, COUNT(*) AS count FROM event_records WHERE event_type = 'log' GROUP BY source ORDER BY source",
      )
      .all() as Array<{ source: string; count: number }>;
    const records = db
      .prepare(
        "SELECT event_id FROM event_records WHERE event_type = 'log' AND message LIKE 'structured lab%' ORDER BY event_time",
      )
      .all() as Array<{ event_id: string }>;
    for (const record of records) {
      const raw = readRawEvent(db, record.event_id);
      assert(Boolean(raw), `raw event reconstructs for ${record.event_id}`);
      const serialized = JSON.stringify(raw);
      assert(
        !serialized.includes(canary),
        `raw event redacts canary for ${record.event_id}`,
      );
      assert(
        serialized.includes("[REDACTED]"),
        `raw event records redaction marker for ${record.event_id}`,
      );
    }
    const sqliteLeak = db
      .prepare(
        "SELECT COUNT(*) AS count FROM logs WHERE message LIKE ? OR stack_trace LIKE ? OR metadata LIKE ?",
      )
      .get(`%${canary}%`, `%${canary}%`, `%${canary}%`) as { count: number };
    assert(sqliteLeak.count === 0, "SQLite log rows do not contain canary");
    return {
      logs: countRows(db, "logs"),
      event_records: countRows(db, "event_records"),
      event_segments: countRows(db, "event_segments"),
      sources: Object.fromEntries(
        sources.map((row) => [row.source, row.count]),
      ),
      raw_events_checked: records.length,
    };
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

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
