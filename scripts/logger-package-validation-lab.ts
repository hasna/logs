#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import winston from "winston";
import {
  createPinoOpenLogsTransport,
  createWinstonOpenLogsTransport,
} from "../sdk/src/index.ts";
import { readRawEvent, setEventStoreDataDir } from "../src/lib/event-store.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

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

interface LoggerPackageValidationReport {
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
  package_versions: {
    pino: string;
    winston: string;
  };
  commands: CommandResult[];
  streamed_messages: string[];
  transport_messages: string[];
  spool: {
    directory: string;
    file: string;
    redacted: boolean;
    replayed_message: string;
  };
  doctor: Record<string, unknown>;
  counts: {
    logs: number;
    event_records: number;
    event_segments: number;
    sources: Record<string, number>;
    raw_events_checked: number;
    spooled_context_rows: number;
  };
  report_file: string;
  assertions: string[];
}

const options = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();
const validationId = `logger-package-lab-${Date.now()}`;
const dataDir = options.dataDir
  ? resolve(options.dataDir)
  : mkdtempSync(join(tmpdir(), "open-logs-logger-package-lab-"));
const dbPath = join(dataDir, "logs.db");
const token = `logger-package-token-${Date.now()}`;
const commands: CommandResult[] = [];
const assertions: string[] = [];
const secret = "OPENLOGS_SECRET_CANARY_logger_package_lab_12345";

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
  const packageVersions = {
    pino: packageVersion("pino"),
    winston: packageVersion("winston"),
  };

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

  const transportMessages = await writeRealLoggerPackageLogs({
    baseUrl,
    token,
    projectId,
    validationId,
    secret,
    packageVersions,
  });

  await sleep(1_500);
  watcher.kill("SIGTERM");
  const watchResult = await waitForProcess(
    "logs watch --server logger packages",
    [process.execPath, "src/cli/index.ts", ...watchArgs],
    watcher,
    6_000,
    [0, 143],
  );
  commands.push(watchResult);
  const streamedMessages = parseWatchMessages(watchResult.stdout);
  for (const message of [
    "logger package lab real pino",
    "logger package lab real winston",
  ]) {
    assert(
      streamedMessages.some((seen) => seen.includes(message)),
      `remote stream observed ${message}`,
    );
  }
  assertions.push(
    "remote server watch observed real Pino and Winston package logs",
  );

  server.kill("SIGTERM");
  await server.exited.catch(() => undefined);
  const spooled = await writeSpooledPinoLogWhileServerDown({
    baseUrl,
    token,
    projectId,
    validationId,
    secret,
    dataDir,
    packageVersions,
  });
  assertions.push(
    "real Pino package log persisted to redacted SDK file spool while collector was down",
  );

  server = Bun.spawn([process.execPath, "src/server/index.ts"], {
    cwd: repoRoot,
    env: { ...env, LOGS_PORT: String(port) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForHealth(baseUrl, server);
  await replaySpooledPinoLog({
    baseUrl,
    token,
    projectId,
    validationId,
    dataDir,
  });
  assertions.push("restarted server ingested the SDK file-spooled Pino log");

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
  assert(
    counts.sources.pino >= 2,
    "real and spooled Pino source rows were indexed",
  );
  assert(counts.sources.winston >= 1, "real Winston source row was indexed");
  assert(counts.raw_events_checked >= 3, "raw events were reconstructed");
  assert(
    counts.spooled_context_rows >= 1,
    "spooled replay preserved original transport metadata context",
  );
  assertions.push(
    "SQLite metadata and raw event reconstruction validated for real logger packages",
  );
  assertions.push(
    "spooled replay preserved transport metadata from file spool",
  );

  const reportFile = resolve(
    options.output ?? join(dataDir, "logger-package-validation-report.json"),
  );
  const report: LoggerPackageValidationReport = {
    ok: true,
    validation_id: validationId,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    data_dir: dataDir,
    data_dir_retained:
      options.keep || Boolean(options.dataDir) || Boolean(options.output),
    server: { base_url: baseUrl, port },
    package_versions: packageVersions,
    commands,
    streamed_messages: streamedMessages,
    transport_messages: transportMessages,
    spool: spooled,
    doctor,
    counts,
    report_file: reportFile,
    assertions,
  };

  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    [
      "Logger package validation passed.",
      `Report: ${reportFile}`,
      `Data dir: ${dataDir}${report.data_dir_retained ? " (retained)" : " (temporary)"}`,
      `Packages: pino=${packageVersions.pino}, winston=${packageVersions.winston}`,
      `Sources: ${JSON.stringify(counts.sources)}`,
    ].join("\n"),
  );
} catch (error) {
  process.stderr.write(
    `Logger package validation failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
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
          "Usage: bun scripts/logger-package-validation-lab.ts [options]",
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

function packageVersion(name: string): string {
  const packageJsonPath = require.resolve(`${name}/package.json`);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    version?: string;
  };
  if (!packageJson.version) throw new Error(`Unable to read ${name} version`);
  return packageJson.version;
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

async function writeRealLoggerPackageLogs(input: {
  baseUrl: string;
  token: string;
  projectId: string;
  validationId: string;
  secret: string;
  packageVersions: { pino: string; winston: string };
}): Promise<string[]> {
  const pinoMessage = `logger package lab real pino token=${input.secret}`;
  const pinoTransport = createPinoOpenLogsTransport({
    url: input.baseUrl,
    apiKey: input.token,
    projectId: input.projectId,
    service: "restarted-without-spooled-context",
    environment: "wrong-restart-env",
    maxBatchSize: 10,
    flushIntervalMs: 60_000,
    sourceEventPrefix: `${input.validationId}:real-pino`,
    metadata: {
      validation_id: input.validationId,
      producer: "real-pino-package",
      package_version: input.packageVersions.pino,
    },
  });
  const pinoLogger = pino(
    {
      name: "logger-package-lab-api",
      base: { pid: process.pid, validation_id: input.validationId },
    },
    pinoTransport,
  );
  pinoLogger.info(
    {
      traceId: `${input.validationId}-trace-real-pino`,
      package_version: input.packageVersions.pino,
      token: input.secret,
    },
    pinoMessage,
  );
  await pinoTransport.flush();
  pinoTransport.stop();

  const winstonMessage = `logger package lab real winston token=${input.secret}`;
  const winstonTransport = createWinstonOpenLogsTransport({
    url: input.baseUrl,
    apiKey: input.token,
    projectId: input.projectId,
    service: "logger-package-lab-worker",
    environment: "test",
    maxBatchSize: 10,
    flushIntervalMs: 60_000,
    sourceEventPrefix: `${input.validationId}:real-winston`,
    metadata: {
      validation_id: input.validationId,
      producer: "real-winston-package",
      package_version: input.packageVersions.winston,
    },
  });
  const winstonLogger = winston.createLogger({
    level: "info",
    defaultMeta: {
      service: "logger-package-lab-worker",
      validation_id: input.validationId,
      package_version: input.packageVersions.winston,
    },
    transports: [winstonTransport],
  });
  winstonLogger.error({
    message: winstonMessage,
    trace_id: `${input.validationId}-trace-real-winston`,
    secret: input.secret,
  });
  await sleep(100);
  await winstonTransport.flush();
  winstonTransport.close();

  return [
    pinoMessage.replace(input.secret, "[REDACTED]"),
    winstonMessage.replace(input.secret, "[REDACTED]"),
  ];
}

async function writeSpooledPinoLogWhileServerDown(input: {
  baseUrl: string;
  token: string;
  projectId: string;
  validationId: string;
  secret: string;
  dataDir: string;
  packageVersions: { pino: string; winston: string };
}): Promise<LoggerPackageValidationReport["spool"]> {
  const spoolDirectory = join(input.dataDir, "sdk-spool");
  const pinoMessage = `logger package lab spooled pino token=${input.secret}`;
  const pinoTransport = createPinoOpenLogsTransport({
    url: input.baseUrl,
    apiKey: input.token,
    projectId: input.projectId,
    service: "logger-package-lab-api",
    environment: "test",
    maxBatchSize: 10,
    maxRetries: 0,
    retryBaseDelayMs: 0,
    flushIntervalMs: 60_000,
    sourceEventPrefix: `${input.validationId}:spooled-pino`,
    spoolDirectory,
    metadata: {
      validation_id: input.validationId,
      producer: "real-pino-package-spool",
      package_version: input.packageVersions.pino,
    },
  });
  const pinoLogger = pino(
    {
      name: "logger-package-lab-api",
      base: { pid: process.pid, validation_id: input.validationId },
    },
    pinoTransport,
  );
  pinoLogger.info(
    {
      traceId: `${input.validationId}-trace-spooled-pino`,
      package_version: input.packageVersions.pino,
      token: input.secret,
    },
    pinoMessage,
  );
  let failed = false;
  try {
    await pinoTransport.flush();
  } catch {
    failed = true;
  }
  assert(failed, "spooled Pino flush failed while collector was down");
  pinoTransport.stop();
  await sleep(250);

  const spoolFileName = readdirSync(spoolDirectory).find((file) =>
    file.endsWith("structured-spool.jsonl"),
  );
  assert(spoolFileName, "SDK file spool was written");
  const spoolFile = join(spoolDirectory, spoolFileName);
  const spooledContents = readFileSync(spoolFile, "utf8");
  assert(
    spooledContents.includes("[REDACTED]"),
    "SDK file spool contains redaction marker",
  );
  assert(
    !spooledContents.includes(input.secret),
    "SDK file spool does not contain canary secret",
  );

  return {
    directory: spoolDirectory,
    file: spoolFile,
    redacted: true,
    replayed_message: pinoMessage.replace(input.secret, "[REDACTED]"),
  };
}

async function replaySpooledPinoLog(input: {
  baseUrl: string;
  token: string;
  projectId: string;
  validationId: string;
  dataDir: string;
}): Promise<void> {
  const pinoTransport = createPinoOpenLogsTransport({
    url: input.baseUrl,
    apiKey: input.token,
    projectId: input.projectId,
    service: "logger-package-lab-api",
    environment: "test",
    maxBatchSize: 10,
    maxRetries: 0,
    retryBaseDelayMs: 0,
    flushIntervalMs: 60_000,
    sourceEventPrefix: `${input.validationId}:spooled-pino`,
    spoolDirectory: join(input.dataDir, "sdk-spool"),
  });
  assert(
    pinoTransport.stats().spool_loaded === 1,
    "restarted Pino transport loaded one spooled record",
  );
  await pinoTransport.flush();
  pinoTransport.stop();
  assert(
    pinoTransport.stats().sent === 1,
    "restarted Pino transport sent one spooled record",
  );
  assert(
    !readdirSync(join(input.dataDir, "sdk-spool")).some((file) =>
      file.endsWith("structured-spool.jsonl"),
    ),
    "SDK spool file was cleared after replay",
  );
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

function readCounts(
  dbFile: string,
  eventStoreDir: string,
  canary: string,
): LoggerPackageValidationReport["counts"] {
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
        "SELECT event_id FROM event_records WHERE event_type = 'log' AND message LIKE 'logger package lab%' ORDER BY event_time",
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
    const spooledContext = db
      .prepare(
        "SELECT COUNT(*) AS count FROM logs WHERE message LIKE ? AND metadata LIKE ? AND metadata LIKE ?",
      )
      .get(
        "%logger package lab spooled pino%",
        "%real-pino-package-spool%",
        "%package_version%",
      ) as { count: number };
    return {
      logs: countRows(db, "logs"),
      event_records: countRows(db, "event_records"),
      event_segments: countRows(db, "event_segments"),
      sources: Object.fromEntries(
        sources.map((row) => [row.source, row.count]),
      ),
      raw_events_checked: records.length,
      spooled_context_rows: spooledContext.count,
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
