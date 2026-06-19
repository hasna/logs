#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, type Page, chromium } from "playwright";

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

interface DashboardStreamRequest {
  url: string;
  authorization: string | null;
  last_event_id: string | null;
}

interface DashboardEventRow {
  event_id: string;
  event_type: string;
  source: string;
  severity: string | null;
  message: string | null;
  trace_id: string | null;
  segment_path: string;
  byte_offset: number;
  byte_length: number;
}

interface PackagedRuntime {
  tarball: string;
  extracted_root: string;
  cwd: string;
  command: string[];
  files: string[];
}

interface DashboardServerScenarioReport {
  server_kind: "packaged";
  command: string[];
  cwd: string;
  package: PackagedRuntime;
  server: {
    base_url: string;
    port: number;
    dashboard_url: string;
  };
  browser: {
    user_agent: string;
  };
  stream_requests: DashboardStreamRequest[];
  events: {
    first_event_id: string;
    paused_event_id: string;
    live_event_id: string;
    cursor_resume_request_seen: boolean;
  };
  rows: DashboardEventRow[];
  raw_events: unknown[];
  assertions: string[];
}

interface DashboardStreamValidationReport {
  ok: boolean;
  validation_id: string;
  started_at: string;
  ended_at: string;
  data_dir: string;
  data_dir_retained: boolean;
  server: {
    base_url: string;
    port: number;
    dashboard_url: string;
  };
  browser: {
    user_agent: string;
  };
  stream_requests: DashboardStreamRequest[];
  events: {
    first_event_id: string;
    paused_event_id: string;
    live_event_id: string;
    cursor_resume_request_seen: boolean;
  };
  rows: DashboardEventRow[];
  raw_events: unknown[];
  packaged_server: DashboardServerScenarioReport;
  doctor: Record<string, unknown>;
  counts: {
    event_records: number;
    dashboard_events: number;
    event_segments: number;
  };
  commands: CommandResult[];
  report_file: string | null;
  assertions: string[];
}

const options = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();
const validationId = `dashboard-stream-lab-${Date.now()}`;
const dataDir = options.dataDir
  ? resolve(options.dataDir)
  : mkdtempSync(join(tmpdir(), "open-logs-dashboard-stream-lab-"));
const dbPath = join(dataDir, "logs.db");
const apiToken = `dashboard-stream-token-${Date.now()}`;
const traceId = `${validationId}-trace`;
const firstEventId = `${validationId}-first`;
const pausedEventId = `${validationId}-paused`;
const liveEventId = `${validationId}-live`;
const packagedTraceId = `${validationId}-packaged-trace`;
const packagedFirstEventId = `${validationId}-packaged-first`;
const packagedPausedEventId = `${validationId}-packaged-paused`;
const packagedLiveEventId = `${validationId}-packaged-live`;
const commands: CommandResult[] = [];
const assertions: string[] = [];

if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

const env = {
  ...process.env,
  HASNA_LOGS_DATA_DIR: dataDir,
  HASNA_LOGS_DB_PATH: dbPath,
  HASNA_LOGS_FSYNC: "0",
  HASNA_LOGS_API_TOKEN: apiToken,
  LOGS_DATA_DIR: "",
  LOGS_DB_PATH: "",
};

let server: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> | undefined;
let browser: Browser | undefined;

try {
  const port = options.port ?? (await getFreePort());
  const baseUrl = `http://127.0.0.1:${port}`;
  const dashboardUrl = `${baseUrl}/dashboard/`;

  const dashboardBuild = await runCommand(
    "bun run build:dashboard",
    ["bun", "run", "build:dashboard"],
    60_000,
  );
  commands.push(dashboardBuild);

  const packageBuild = await runCommand(
    "bun run build",
    ["bun", "run", "build"],
    90_000,
  );
  commands.push(packageBuild);
  const packagedRuntime = await preparePackagedRuntime();

  server = Bun.spawn([process.execPath, "src/server/index.ts"], {
    cwd: repoRoot,
    env: { ...env, LOGS_PORT: String(port) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForHealth(baseUrl, server);

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  const streamRequests = captureStreamRequests(page);

  await page.goto(dashboardUrl, { waitUntil: "domcontentloaded" });
  await expectText(page, "blocked", 10_000);
  await expectText(page, "stream 401", 10_000);
  assert(
    streamRequests.some((request) => !request.authorization),
    "dashboard first attempted stream without an Authorization header",
  );
  assertions.push("dashboard stream is blocked before an API token is entered");

  await page.getByLabel("API token").fill(apiToken);
  await expectText(page, "live", 10_000);
  await waitFor(
    () =>
      streamRequests.some(
        (request) => request.authorization === `Bearer ${apiToken}`,
      ),
    "dashboard sent Authorization header on fetch-backed SSE",
    10_000,
  );
  assertions.push("dashboard stream uses Authorization after token entry");

  await postMetricEvent(baseUrl, firstEventId, "dashboard first live event", 1);
  await expectText(page, "dashboard first live event", 10_000);
  await expectText(page, firstEventId, 10_000);
  assertions.push("dashboard rendered the first live event from API SSE");

  await page.getByRole("button", { name: "Pause" }).click();
  await expectText(page, "paused", 10_000);
  await postMetricEvent(
    baseUrl,
    pausedEventId,
    "dashboard paused catchup event",
    2,
  );
  await sleep(500);
  assert(
    !(await page.getByText("dashboard paused catchup event").isVisible()),
    "paused dashboard did not render the catch-up event before resume",
  );

  await page.getByRole("button", { name: "Resume" }).click();
  await expectText(page, "dashboard paused catchup event", 10_000);
  await waitFor(
    () =>
      streamRequests.some(
        (request) =>
          request.authorization === `Bearer ${apiToken}` &&
          request.last_event_id === firstEventId,
      ),
    "dashboard reconnected with the last seen event cursor",
    10_000,
  );
  assertions.push(
    "dashboard pause/resume reconnected with last_event_id and caught up the paused event",
  );

  await postMetricEvent(
    baseUrl,
    liveEventId,
    "dashboard post-resume live event",
    3,
  );
  await expectText(page, "dashboard post-resume live event", 10_000);
  assertions.push("dashboard kept receiving live events after reconnect");

  const persistedToken = await page.evaluate(() =>
    window.sessionStorage.getItem("open_logs_dashboard_api_token"),
  );
  assert(
    persistedToken === apiToken,
    "dashboard token is persisted in browser session storage",
  );
  const userAgent = await page.evaluate(() => navigator.userAgent);

  await browser.close();
  browser = undefined;

  const rows = readDashboardRows(dbPath);
  const rowIds = new Set(rows.map((row) => row.event_id));
  for (const eventId of [firstEventId, pausedEventId, liveEventId]) {
    assert(rowIds.has(eventId), `SQLite event_records includes ${eventId}`);
  }
  const rawEvents = rows.map((row) => readRawEventFromRow(dataDir, row));

  await stopServer(server);
  server = undefined;
  const packagedServer =
    await validatePackagedServerDashboardStream(packagedRuntime);
  assertions.push(
    "packaged server served the built dashboard and preserved dashboard stream auth/reconnect behavior",
  );

  const doctor = await runCommand(
    "logs doctor segments",
    [process.execPath, "src/cli/index.ts", "doctor", "segments", "--json"],
    30_000,
  );
  commands.push(doctor);
  const doctorResult = parseJsonObject(doctor.stdout);
  assert(doctorResult.ok === true, "doctor segments returned ok=true");
  assert(
    readNumber(doctorResult, "unindexed_raw_events") === 0,
    "doctor segments found zero unindexed raw events",
  );

  const counts = readCounts(dbPath);
  const reportFile =
    options.output ??
    (options.keep || options.dataDir
      ? join(dataDir, "dashboard-stream-validation-report.json")
      : null);
  const report: DashboardStreamValidationReport = {
    ok: true,
    validation_id: validationId,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    data_dir: dataDir,
    data_dir_retained: Boolean(options.keep || options.dataDir),
    server: { base_url: baseUrl, port, dashboard_url: dashboardUrl },
    browser: { user_agent: userAgent },
    stream_requests: streamRequests,
    events: {
      first_event_id: firstEventId,
      paused_event_id: pausedEventId,
      live_event_id: liveEventId,
      cursor_resume_request_seen: streamRequests.some(
        (request) => request.last_event_id === firstEventId,
      ),
    },
    rows,
    raw_events: rawEvents,
    packaged_server: packagedServer,
    doctor: doctorResult,
    counts,
    commands,
    report_file: reportFile,
    assertions,
  };

  if (reportFile) {
    mkdirSync(dirname(reportFile), { recursive: true });
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  process.stderr.write(
    `Dashboard stream validation failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  if (server) await stopServer(server);
  if (!options.keep && !options.dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function preparePackagedRuntime(): Promise<PackagedRuntime> {
  const packDir = join(dataDir, "npm-pack");
  const extractDir = join(dataDir, "npm-package-extracted");
  const runtimeCwd = join(dataDir, "packaged-runtime-cwd");
  mkdirSync(packDir, { recursive: true });
  mkdirSync(extractDir, { recursive: true });
  mkdirSync(runtimeCwd, { recursive: true });

  const pack = await runCommand(
    "npm pack",
    ["npm", "pack", "--json", "--pack-destination", packDir],
    60_000,
  );
  commands.push(pack);
  const packOutput = JSON.parse(pack.stdout) as Array<{
    filename?: string;
    files?: Array<{ path?: string }>;
  }>;
  const packed = packOutput[0];
  const filename = packed?.filename;
  assert(filename, "npm pack returned a package filename");
  const files =
    packed.files
      ?.map((file) => file.path)
      .filter((path): path is string => Boolean(path)) ?? [];
  assert(
    files.some((file) => file.startsWith("dashboard/dist/")),
    "npm package includes built dashboard assets",
  );
  assert(
    files.some((file) => file === "dist/server/index.js"),
    "npm package includes packaged server entrypoint",
  );

  const tarball = join(packDir, filename);
  const extract = await runCommand(
    "extract npm package",
    ["tar", "-xzf", tarball, "-C", extractDir],
    30_000,
  );
  commands.push(extract);
  const extractedRoot = join(extractDir, "package");
  assert(
    existsSync(join(extractedRoot, "dashboard/dist/index.html")),
    "extracted package contains dashboard/dist/index.html",
  );
  assert(
    existsSync(join(extractedRoot, "dist/server/index.js")),
    "extracted package contains dist/server/index.js",
  );

  return {
    tarball,
    extracted_root: extractedRoot,
    cwd: runtimeCwd,
    command: [process.execPath, join(extractedRoot, "dist/server/index.js")],
    files,
  };
}

async function validatePackagedServerDashboardStream(
  runtime: PackagedRuntime,
): Promise<DashboardServerScenarioReport> {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dashboardUrl = `${baseUrl}/dashboard/`;
  const packagedAssertions: string[] = [];
  const runtimeCwd = resolve(runtime.cwd);
  const extractedRoot = resolve(runtime.extracted_root);
  const serverEntrypoint = runtime.command[1]
    ? resolve(runtime.command[1])
    : "";
  assert(
    serverEntrypoint.startsWith(`${extractedRoot}/`),
    "packaged server entrypoint is loaded from the extracted npm package",
  );
  assert(
    runtimeCwd !== repoRoot && !runtimeCwd.startsWith(`${repoRoot}/`),
    "packaged server cwd is outside the repository root",
  );
  assert(
    runtimeCwd !== extractedRoot && !runtimeCwd.startsWith(`${extractedRoot}/`),
    "packaged server cwd is outside the extracted package root",
  );
  packagedAssertions.push(
    "packaged server entrypoint came from the extracted npm package",
    "packaged server ran from a cwd outside the repository and extracted package roots",
  );
  let child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> | undefined;
  let packagedBrowser: Browser | undefined;

  try {
    child = Bun.spawn(runtime.command, {
      cwd: runtime.cwd,
      env: { ...env, LOGS_PORT: String(port) },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitForHealth(baseUrl, child);

    packagedBrowser = await chromium.launch({ headless: true });
    const context = await packagedBrowser.newContext();
    const page = await context.newPage();
    const streamRequests = captureStreamRequests(page);

    await page.goto(dashboardUrl, { waitUntil: "domcontentloaded" });
    await expectText(page, "blocked", 10_000);
    await expectText(page, "stream 401", 10_000);
    assert(
      streamRequests.some((request) => !request.authorization),
      "packaged dashboard first attempted stream without Authorization",
    );
    packagedAssertions.push(
      "packaged dashboard stream is blocked before an API token is entered",
    );

    await page.getByLabel("API token").fill(apiToken);
    await expectText(page, "live", 10_000);
    await waitFor(
      () =>
        streamRequests.some(
          (request) => request.authorization === `Bearer ${apiToken}`,
        ),
      "packaged dashboard sent Authorization header on fetch-backed SSE",
      10_000,
    );
    packagedAssertions.push(
      "packaged dashboard stream uses Authorization after token entry",
    );

    await postMetricEvent(
      baseUrl,
      packagedFirstEventId,
      "packaged dashboard first live event",
      10,
      packagedTraceId,
    );
    await expectText(page, "packaged dashboard first live event", 10_000);
    await expectText(page, packagedFirstEventId, 10_000);
    packagedAssertions.push(
      "packaged dashboard rendered the first live event from API SSE",
    );

    await page.getByRole("button", { name: "Pause" }).click();
    await expectText(page, "paused", 10_000);
    await postMetricEvent(
      baseUrl,
      packagedPausedEventId,
      "packaged dashboard paused catchup event",
      20,
      packagedTraceId,
    );
    await sleep(500);
    assert(
      !(await page
        .getByText("packaged dashboard paused catchup event")
        .isVisible()),
      "packaged paused dashboard did not render the catch-up event before resume",
    );

    await page.getByRole("button", { name: "Resume" }).click();
    await expectText(page, "packaged dashboard paused catchup event", 10_000);
    await waitFor(
      () =>
        streamRequests.some(
          (request) =>
            request.authorization === `Bearer ${apiToken}` &&
            request.last_event_id === packagedFirstEventId,
        ),
      "packaged dashboard reconnected with the last seen event cursor",
      10_000,
    );
    packagedAssertions.push(
      "packaged dashboard pause/resume reconnected with last_event_id and caught up the paused event",
    );

    await postMetricEvent(
      baseUrl,
      packagedLiveEventId,
      "packaged dashboard post-resume live event",
      30,
      packagedTraceId,
    );
    await expectText(page, "packaged dashboard post-resume live event", 10_000);
    packagedAssertions.push(
      "packaged dashboard kept receiving live events after reconnect",
    );

    const userAgent = await page.evaluate(() => navigator.userAgent);
    await packagedBrowser.close();
    packagedBrowser = undefined;

    const rows = readDashboardRows(dbPath, packagedTraceId);
    const rowIds = new Set(rows.map((row) => row.event_id));
    for (const eventId of [
      packagedFirstEventId,
      packagedPausedEventId,
      packagedLiveEventId,
    ]) {
      assert(
        rowIds.has(eventId),
        `SQLite event_records includes packaged event ${eventId}`,
      );
    }
    const rawEvents = rows.map((row) => readRawEventFromRow(dataDir, row));

    return {
      server_kind: "packaged",
      command: runtime.command,
      cwd: runtime.cwd,
      package: runtime,
      server: { base_url: baseUrl, port, dashboard_url: dashboardUrl },
      browser: { user_agent: userAgent },
      stream_requests: streamRequests,
      events: {
        first_event_id: packagedFirstEventId,
        paused_event_id: packagedPausedEventId,
        live_event_id: packagedLiveEventId,
        cursor_resume_request_seen: streamRequests.some(
          (request) => request.last_event_id === packagedFirstEventId,
        ),
      },
      rows,
      raw_events: rawEvents,
      assertions: packagedAssertions,
    };
  } finally {
    if (packagedBrowser) await packagedBrowser.close().catch(() => undefined);
    if (child) await stopServer(child);
  }
}

function captureStreamRequests(page: Page): DashboardStreamRequest[] {
  const requests: DashboardStreamRequest[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname !== "/api/events/stream") return;
    const headers = request.headers();
    requests.push({
      url: request.url(),
      authorization: headers.authorization ?? null,
      last_event_id: url.searchParams.get("last_event_id"),
    });
  });
  return requests;
}

async function postMetricEvent(
  baseUrl: string,
  eventId: string,
  message: string,
  value: number,
  eventTraceId = traceId,
): Promise<void> {
  const response = await fetch(`${baseUrl}/api/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      type: "metric",
      event_id: eventId,
      source: "sdk",
      severity: "info",
      trace_id: eventTraceId,
      message,
      body: { value },
      attributes: { validation_id: validationId },
    }),
  });
  if (!response.ok) {
    throw new Error(
      `POST /api/events failed ${response.status}: ${await response.text()}`,
    );
  }
}

function readDashboardRows(
  dbFile: string,
  eventTraceId = traceId,
): DashboardEventRow[] {
  const db = new Database(dbFile, { readonly: true });
  try {
    return db
      .prepare(`
        SELECT event_id, event_type, source, severity, message, trace_id, segment_path, byte_offset, byte_length
        FROM event_records
        WHERE trace_id = ?
        ORDER BY event_time ASC, rowid ASC
      `)
      .all(eventTraceId) as DashboardEventRow[];
  } finally {
    db.close();
  }
}

function readRawEventFromRow(dataDir: string, row: DashboardEventRow): unknown {
  const bytes = readFileSync(join(dataDir, row.segment_path));
  const rawLine = bytes
    .subarray(row.byte_offset, row.byte_offset + row.byte_length)
    .toString("utf8");
  return JSON.parse(rawLine) as unknown;
}

function readCounts(dbFile: string): DashboardStreamValidationReport["counts"] {
  const db = new Database(dbFile, { readonly: true });
  try {
    return {
      event_records: countRows(db, "event_records"),
      dashboard_events: Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM event_records WHERE trace_id LIKE ?",
            )
            .get(`${validationId}-%`) as { count: number }
        ).count,
      ),
      event_segments: countRows(db, "event_segments"),
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

async function runCommand(
  label: string,
  command: string[],
  timeoutMs: number,
): Promise<CommandResult> {
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

async function stopServer(
  child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>,
): Promise<void> {
  child.kill("SIGTERM");
  await child.exited.catch(() => undefined);
}

async function expectText(
  page: Page,
  text: string,
  timeoutMs: number,
): Promise<void> {
  await page.getByText(text).first().waitFor({ timeout: timeoutMs });
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs: number,
): Promise<void> {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (predicate()) return;
    await sleep(50);
  }
  throw new Error(message);
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to allocate free port"));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

function parseArgs(args: string[]): LabOptions {
  const result: LabOptions = { keep: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--keep") {
      result.keep = true;
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
    if (arg === "--port") {
      index += 1;
      result.port = Number(requireValue(args, index, arg));
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: bun scripts/dashboard-stream-validation-lab.ts [--keep] [--data-dir <dir>] [--output <file>] [--port <n>]",
          "",
          "Builds the dashboard and package, extracts npm pack output, then validates source and packaged dashboard live-tail auth plus pause/resume cursor reconnect in Chromium.",
        ].join("\n"),
      );
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return result;
}

function requireValue(args: string[], index: number, label: string): string {
  const value = args[index];
  if (!value) throw new Error(`${label} requires a value`);
  return value;
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object: ${value}`);
  }
  return parsed as Record<string, unknown>;
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" ? value : Number(value ?? 0);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
