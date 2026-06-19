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
  appPort?: number;
}

interface CommandResult {
  label: string;
  command: string[];
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

interface BrowserProxyRequest {
  path: string;
  body_text: string;
  body_json: unknown;
  request_had_browser_token: boolean;
  upstream_status: number | null;
  upstream_body: unknown;
}

interface BrowserEventRow {
  event_id: string;
  project_id: string | null;
  source: string;
  event_type: string;
  message: string | null;
  segment_path: string;
  byte_offset: number;
  byte_length: number;
}

interface BrowserSpoolValidationReport {
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
  browser_app: {
    base_url: string;
    port: number;
  };
  project: {
    id: string;
    name: string;
  };
  browser_token: {
    token_prefix: string;
    allowed_origins: string[];
  };
  origin_security: {
    wrong_origin: string;
    wrong_origin_status: number;
    wrong_origin_body: unknown;
  };
  browser: {
    user_agent: string;
  };
  spool: {
    key: string;
    first_proxy_body_contains_secret: boolean;
    stored_payload_contains_redaction: boolean;
    stored_payload_contains_secret: boolean;
    replay_proxy_body_contains_secret: boolean;
    replay_proxy_body_contains_redaction: boolean;
    storage_cleared_after_replay: boolean;
  };
  proxy_requests: BrowserProxyRequest[];
  browser_event: BrowserEventRow;
  raw_event: unknown;
  doctor: Record<string, unknown>;
  counts: {
    event_records: number;
    browser_events: number;
    event_segments: number;
    logs: number;
  };
  commands: CommandResult[];
  report_file: string | null;
  assertions: string[];
}

const options = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();
const validationId = `browser-spool-lab-${Date.now()}`;
const dataDir = options.dataDir
  ? resolve(options.dataDir)
  : mkdtempSync(join(tmpdir(), "open-logs-browser-spool-lab-"));
const dbPath = join(dataDir, "logs.db");
const apiToken = `browser-spool-token-${Date.now()}`;
const secret = `OPENLOGS_SECRET_CANARY_browser_spool_lab_${Date.now()}`;
const sessionId = `${validationId}-session`;
const spoolKey = `open-logs-browser-spool-lab:${validationId}`;
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
let appServer: ReturnType<typeof startBrowserAppServer> | undefined;
let browser: Browser | undefined;

try {
  const port = options.port ?? (await getFreePort());
  const appPort = options.appPort ?? (await getFreePort());
  const baseUrl = `http://127.0.0.1:${port}`;
  const appBaseUrl = `http://127.0.0.1:${appPort}`;
  const appDir = join(dataDir, "browser-app");
  mkdirSync(appDir, { recursive: true });
  await buildBrowserApp(appDir);

  server = Bun.spawn([process.execPath, "src/server/index.ts"], {
    cwd: repoRoot,
    env: { ...env, LOGS_PORT: String(port) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForHealth(baseUrl, server);

  const project = await createProject(
    baseUrl,
    apiToken,
    validationId,
    appBaseUrl,
  );
  const browserToken = await createBrowserToken(
    baseUrl,
    apiToken,
    project.id,
    appBaseUrl,
  );
  const wrongOrigin = await assertWrongOriginRejected(
    baseUrl,
    browserToken.token,
  );

  appServer = startBrowserAppServer({
    appBaseUrl,
    appDir,
    appPort,
    browserToken: browserToken.token,
    collectorBaseUrl: baseUrl,
    projectId: project.id,
    secret,
    sessionId,
    spoolKey,
    validationId,
  });

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  appServer.collectorUp = false;
  await page.goto(`${appBaseUrl}/?emit=1&token=${encodeURIComponent(secret)}`, {
    waitUntil: "domcontentloaded",
  });
  await waitForBrowserDone(page);
  await waitForProxyRequestCount(appServer.requests, 1);

  const firstRequest = appServer.requests[0];
  assert(
    firstRequest?.upstream_status === 503,
    "first browser flush hit the forced collector failure",
  );
  assert(
    firstRequest.request_had_browser_token,
    "first browser flush carried the scoped browser token",
  );
  const firstBody = firstRequest.body_text;
  assert(
    firstBody.includes(secret),
    "same-page failed browser send used the original in-memory event",
  );
  const spooledPayload = await readLocalStorage(page, spoolKey);
  assert(
    Boolean(spooledPayload),
    "browser localStorage spool exists after collector failure",
  );
  assert(
    spooledPayload?.includes("[REDACTED]"),
    "browser localStorage spool contains redaction marker",
  );
  assert(
    !spooledPayload?.includes(secret),
    "browser localStorage spool does not contain the canary secret",
  );
  assert(
    !spooledPayload?.includes(`token=${secret}`),
    "browser localStorage spool redacts URL query canary",
  );
  assert(
    countBrowserEvents(dbPath) === 0,
    "collector-down browser event was not inserted before replay",
  );

  appServer.collectorUp = true;
  await page.goto(`${appBaseUrl}/?emit=0&token=${encodeURIComponent(secret)}`, {
    waitUntil: "domcontentloaded",
  });
  await waitForBrowserDone(page);
  await waitForProxyRequestCount(appServer.requests, 2);

  const replayRequest = appServer.requests.find(
    (request, index) => index > 0 && request.upstream_status === 201,
  );
  assert(
    replayRequest,
    `reload replay reached the real collector; statuses=${appServer.requests.map((request) => request.upstream_status).join(",")}`,
  );
  assert(
    replayRequest.request_had_browser_token,
    "reload replay carried the scoped browser token",
  );
  assert(
    !replayRequest.body_text.includes(secret),
    "reload replay request did not contain the canary secret",
  );
  assert(
    replayRequest.body_text.includes("[REDACTED]"),
    "reload replay request used the redacted spooled event",
  );
  const clearedPayload = await readLocalStorage(page, spoolKey);
  assert(
    clearedPayload === null,
    "browser localStorage spool key was cleared after replay",
  );

  const userAgent = await page.evaluate(() => navigator.userAgent);
  await browser.close();
  browser = undefined;

  const browserEvent = readBrowserEvent(dbPath);
  assert(
    browserEvent.project_id === project.id,
    "browser replay event is indexed under the token-owned project",
  );
  assert(
    browserEvent.source === "browser",
    "browser replay event keeps source=browser",
  );
  assert(
    browserEvent.message === "browser lab token=[REDACTED]",
    "browser replay event message is redacted in SQLite",
  );
  const rawEvent = readRawEventFromRow(dataDir, browserEvent);
  const rawJson = JSON.stringify(rawEvent);
  assert(
    !rawJson.includes(secret),
    "raw browser replay event does not contain the canary secret",
  );
  assert(
    rawJson.includes("[REDACTED]"),
    "raw browser replay event contains redacted values",
  );

  const doctor = await runCli("logs doctor segments", [
    "doctor",
    "segments",
    "--json",
  ]);
  commands.push(doctor);
  const doctorResult = JSON.parse(doctor.stdout) as Record<string, unknown>;
  assert(
    doctorResult.ok === true,
    "doctor segments verified raw browser spool replay",
  );
  assert(
    readNumber(doctorResult, "unindexed_raw_events") === 0,
    "doctor found no unindexed raw browser events",
  );

  const counts = readCounts(dbPath);
  const reportFile =
    options.output ??
    (options.keep || options.dataDir
      ? join(dataDir, "browser-spool-validation-report.json")
      : null);
  const report: BrowserSpoolValidationReport = {
    ok: true,
    validation_id: validationId,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    data_dir: dataDir,
    data_dir_retained: Boolean(options.keep || options.dataDir),
    server: { base_url: baseUrl, port },
    browser_app: { base_url: appBaseUrl, port: appPort },
    project,
    browser_token: {
      token_prefix: browserToken.token_prefix,
      allowed_origins: browserToken.allowed_origins,
    },
    origin_security: {
      wrong_origin: wrongOrigin.origin,
      wrong_origin_status: wrongOrigin.status,
      wrong_origin_body: wrongOrigin.body,
    },
    browser: { user_agent: userAgent },
    spool: {
      key: spoolKey,
      first_proxy_body_contains_secret: firstBody.includes(secret),
      stored_payload_contains_redaction: Boolean(
        spooledPayload?.includes("[REDACTED]"),
      ),
      stored_payload_contains_secret: Boolean(spooledPayload?.includes(secret)),
      replay_proxy_body_contains_secret:
        replayRequest.body_text.includes(secret),
      replay_proxy_body_contains_redaction:
        replayRequest.body_text.includes("[REDACTED]"),
      storage_cleared_after_replay: clearedPayload === null,
    },
    proxy_requests: appServer.requests,
    browser_event: browserEvent,
    raw_event: rawEvent,
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
    `Browser spool validation failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  appServer?.server.stop(true);
  if (server) await stopServer(server);
  if (!options.keep && !options.dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function buildBrowserApp(appDir: string): Promise<void> {
  const entryPath = join(appDir, "browser-spool-app.ts");
  writeFileSync(
    entryPath,
    [
      `import { initUniversalLogs } from ${JSON.stringify(join(repoRoot, "sdk/src/index.ts"))};`,
      "const config = window.__OPEN_LOGS_BROWSER_SPOOL_LAB__;",
      "const controller = initUniversalLogs({",
      "  url: config.collectorUrl,",
      "  projectId: config.projectId,",
      "  browserToken: config.browserToken,",
      "  sessionId: config.sessionId,",
      "  browserSpool: true,",
      "  browserSpoolKey: config.spoolKey,",
      "  maxBatchSize: 10,",
      "  maxQueueSize: 10,",
      "  flushIntervalMs: 60000,",
      "});",
      "window.__OPEN_LOGS_BROWSER_SPOOL_LAB_CONTROLLER__ = controller;",
      "async function run() {",
      "  if (config.emit) console.warn(config.message);",
      "  await controller?.flush();",
      "  controller?.stop();",
      "  window.__OPEN_LOGS_BROWSER_SPOOL_LAB_DONE__ = true;",
      "}",
      "run().catch((error) => {",
      "  window.__OPEN_LOGS_BROWSER_SPOOL_LAB_ERROR__ = error?.stack ?? String(error);",
      "  window.__OPEN_LOGS_BROWSER_SPOOL_LAB_DONE__ = true;",
      "});",
      "",
      "export {};",
    ].join("\n"),
    "utf8",
  );
  const result = await Bun.build({
    entrypoints: [entryPath],
    outdir: appDir,
    target: "browser",
    format: "esm",
    naming: "app.js",
  });
  if (!result.success) {
    throw new Error(
      `Browser app bundle failed:\n${result.logs.map(String).join("\n")}`,
    );
  }
}

function startBrowserAppServer(input: {
  appBaseUrl: string;
  appDir: string;
  appPort: number;
  browserToken: string;
  collectorBaseUrl: string;
  projectId: string;
  secret: string;
  sessionId: string;
  spoolKey: string;
  validationId: string;
}): {
  server: ReturnType<typeof Bun.serve>;
  requests: BrowserProxyRequest[];
  collectorUp: boolean;
} {
  const state = {
    collectorUp: false,
    requests: [] as BrowserProxyRequest[],
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: input.appPort,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/app.js") {
        return new Response(readFileSync(join(input.appDir, "app.js")), {
          headers: { "Content-Type": "application/javascript" },
        });
      }
      if (
        url.pathname === "/collector/api/events" &&
        request.method === "POST"
      ) {
        return await handleCollectorProxy(request, input, state);
      }
      if (url.pathname === "/") {
        const emit = url.searchParams.get("emit") === "1";
        return new Response(browserHtml(input, emit), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    server,
    requests: state.requests,
    get collectorUp() {
      return state.collectorUp;
    },
    set collectorUp(value: boolean) {
      state.collectorUp = value;
    },
  };
}

async function handleCollectorProxy(
  request: Request,
  input: {
    appBaseUrl: string;
    collectorBaseUrl: string;
  },
  state: {
    collectorUp: boolean;
    requests: BrowserProxyRequest[];
  },
): Promise<Response> {
  const bodyText = await request.text();
  const record: BrowserProxyRequest = {
    path: new URL(request.url).pathname,
    body_text: bodyText,
    body_json: parseJson(bodyText),
    request_had_browser_token: Boolean(
      request.headers.get("x-logs-browser-token"),
    ),
    upstream_status: null,
    upstream_body: null,
  };
  state.requests.push(record);
  if (!state.collectorUp) {
    record.upstream_status = 503;
    record.upstream_body = {
      error: "collector down by browser spool validation lab",
    };
    return Response.json(record.upstream_body, { status: 503 });
  }

  const headers = new Headers();
  headers.set(
    "Content-Type",
    request.headers.get("content-type") ?? "application/json",
  );
  headers.set("Origin", input.appBaseUrl);
  const browserToken = request.headers.get("x-logs-browser-token");
  if (browserToken) headers.set("X-Logs-Browser-Token", browserToken);
  const response = await fetch(`${input.collectorBaseUrl}/api/events`, {
    method: "POST",
    headers,
    body: bodyText,
  });
  const responseText = await response.text();
  record.upstream_status = response.status;
  record.upstream_body = parseJson(responseText);
  return new Response(responseText, {
    status: response.status,
    headers: {
      "Content-Type":
        response.headers.get("content-type") ?? "application/json",
    },
  });
}

function browserHtml(
  input: {
    appBaseUrl: string;
    browserToken: string;
    projectId: string;
    secret: string;
    sessionId: string;
    spoolKey: string;
    validationId: string;
  },
  emit: boolean,
): string {
  const config = {
    browserToken: input.browserToken,
    collectorUrl: `${input.appBaseUrl}/collector`,
    emit,
    message: `browser lab token=${input.secret}`,
    projectId: input.projectId,
    sessionId: input.sessionId,
    spoolKey: input.spoolKey,
    validationId: input.validationId,
  };
  return [
    "<!doctype html>",
    "<html>",
    '<head><meta charset="utf-8"><title>Open Logs Browser Spool Lab</title></head>',
    "<body>",
    "<main>Open Logs Browser Spool Lab</main>",
    `<script>window.__OPEN_LOGS_BROWSER_SPOOL_LAB__ = ${JSON.stringify(config)};</script>`,
    '<script type="module" src="/app.js"></script>',
    "</body>",
    "</html>",
  ].join("\n");
}

async function createProject(
  baseUrl: string,
  token: string,
  name: string,
  appBaseUrl: string,
): Promise<{ id: string; name: string }> {
  const response = await fetch(`${baseUrl}/api/projects`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name, base_url: appBaseUrl }),
  });
  if (!response.ok) {
    throw new Error(
      `Project create failed ${response.status}: ${await response.text()}`,
    );
  }
  const project = (await response.json()) as { id: string; name: string };
  assert(Boolean(project.id), "project was created through the real API");
  return project;
}

async function createBrowserToken(
  baseUrl: string,
  token: string,
  projectId: string,
  appBaseUrl: string,
): Promise<{
  token: string;
  token_prefix: string;
  allowed_origins: string[];
}> {
  const response = await fetch(
    `${baseUrl}/api/projects/${projectId}/browser-tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "browser spool validation",
        allowed_origins: [appBaseUrl],
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `Browser token create failed ${response.status}: ${await response.text()}`,
    );
  }
  const created = (await response.json()) as {
    token: string;
    token_prefix: string;
    allowed_origins: string | null;
  };
  assert(
    created.token.startsWith("olb_"),
    "browser token was created through the real API",
  );
  const allowedOrigins = parseAllowedOrigins(created.allowed_origins);
  assert(
    allowedOrigins.length === 1 && allowedOrigins[0] === appBaseUrl,
    "browser token records the normalized allowed browser origin",
  );
  return {
    token: created.token,
    token_prefix: created.token_prefix,
    allowed_origins: allowedOrigins,
  };
}

async function assertWrongOriginRejected(
  baseUrl: string,
  browserToken: string,
): Promise<{ origin: string; status: number; body: unknown }> {
  const origin = "https://evil.example";
  const response = await fetch(`${baseUrl}/api/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "X-Logs-Browser-Token": browserToken,
    },
    body: JSON.stringify({
      type: "log",
      source: "browser",
      severity: "warn",
      message: "wrong origin browser event",
    }),
  });
  const responseText = await response.text();
  const body = parseJson(responseText);
  assert(
    response.status === 401,
    "browser token is rejected when the Origin is outside allowed_origins",
  );
  return { origin, status: response.status, body };
}

function readBrowserEvent(dbFile: string): BrowserEventRow {
  const db = new Database(dbFile, { readonly: true });
  try {
    const row = db
      .prepare(`
        SELECT event_id, project_id, source, event_type, message, segment_path, byte_offset, byte_length
        FROM event_records
        WHERE source = 'browser' AND event_type = 'log' AND message = ?
        ORDER BY event_time DESC
        LIMIT 1
      `)
      .get("browser lab token=[REDACTED]") as BrowserEventRow | null;
    if (!row)
      throw new Error("Browser replay event was not indexed in event_records");
    return row;
  } finally {
    db.close();
  }
}

function readRawEventFromRow(dataDir: string, row: BrowserEventRow): unknown {
  const bytes = readFileSync(join(dataDir, row.segment_path));
  const rawLine = bytes
    .subarray(row.byte_offset, row.byte_offset + row.byte_length)
    .toString("utf8");
  return JSON.parse(rawLine) as unknown;
}

function readCounts(dbFile: string): BrowserSpoolValidationReport["counts"] {
  const db = new Database(dbFile, { readonly: true });
  try {
    return {
      event_records: countRows(db, "event_records"),
      browser_events: Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM event_records WHERE source = 'browser'",
            )
            .get() as { count: number }
        ).count,
      ),
      event_segments: countRows(db, "event_segments"),
      logs: countRows(db, "logs"),
    };
  } finally {
    db.close();
  }
}

function countBrowserEvents(dbFile: string): number {
  const db = new Database(dbFile, { readonly: true });
  try {
    return Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM event_records WHERE source = 'browser'",
          )
          .get() as { count: number }
      ).count,
    );
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

async function runCli(label: string, args: string[]): Promise<CommandResult> {
  const child = Bun.spawn([process.execPath, "src/cli/index.ts", ...args], {
    cwd: repoRoot,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return await waitForProcess(
    label,
    [process.execPath, "src/cli/index.ts", ...args],
    child,
    20_000,
  );
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

async function waitForBrowserDone(page: Page): Promise<void> {
  await page.waitForFunction(
    () => Boolean(window.__OPEN_LOGS_BROWSER_SPOOL_LAB_DONE__),
    null,
    { timeout: 10_000 },
  );
  const error = await page.evaluate(
    () => window.__OPEN_LOGS_BROWSER_SPOOL_LAB_ERROR__ ?? null,
  );
  if (error) throw new Error(`Browser app failed: ${error}`);
}

async function readLocalStorage(
  page: Page,
  key: string,
): Promise<string | null> {
  return await page.evaluate(
    (storageKey) => localStorage.getItem(storageKey),
    key,
  );
}

async function waitForProxyRequestCount(
  requests: BrowserProxyRequest[],
  count: number,
): Promise<void> {
  const started = performance.now();
  while (performance.now() - started < 10_000) {
    if (requests.length >= count) return;
    await sleep(50);
  }
  throw new Error(
    `Timed out waiting for ${count} browser proxy request(s); saw ${requests.length}`,
  );
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
    if (arg === "--app-port") {
      index += 1;
      result.appPort = Number(requireValue(args, index, arg));
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: bun scripts/browser-spool-validation-lab.ts [--keep] [--data-dir <dir>] [--output <file>] [--port <n>] [--app-port <n>]",
          "",
          "Runs a real browser telemetry validation lab for SDK localStorage spooling, browser-token writes, raw segments, and SQLite indexing.",
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

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseAllowedOrigins(value: string | null): string[] {
  if (!value) return [];
  const parsed = parseJson(value);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function readNumber(source: Record<string, unknown>, field: string): number {
  const value = source[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected numeric field: ${field}`);
  }
  return value;
}

async function stopServer(
  child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>,
): Promise<void> {
  child.kill("SIGTERM");
  const result = await Promise.race([
    child.exited.then(() => "exited" as const),
    sleep(2_000).then(() => "timeout" as const),
  ]);
  if (result === "timeout") {
    child.kill("SIGKILL");
    await child.exited.catch(() => undefined);
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  assertions.push(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

declare global {
  interface Window {
    __OPEN_LOGS_BROWSER_SPOOL_LAB__?: {
      browserToken: string;
      collectorUrl: string;
      emit: boolean;
      message: string;
      projectId: string;
      sessionId: string;
      spoolKey: string;
      validationId: string;
    };
    __OPEN_LOGS_BROWSER_SPOOL_LAB_CONTROLLER__?: unknown;
    __OPEN_LOGS_BROWSER_SPOOL_LAB_DONE__?: boolean;
    __OPEN_LOGS_BROWSER_SPOOL_LAB_ERROR__?: string;
  }
}
