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
import { captureHttpRequest } from "../sdk/src/index.ts";

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

interface BrowserProxyRequestSummary {
  path: string;
  request_had_browser_token: boolean;
  event_count: number;
  event_types: string[];
  messages: string[];
  body_contains_secret: boolean;
  upstream_status: number | null;
  upstream_body: unknown;
}

interface BrowserRuntimeEventRow {
  event_id: string;
  project_id: string | null;
  source: string;
  event_type: string;
  severity: string | null;
  trace_id: string | null;
  span_id: string | null;
  parent_span_id: string | null;
  message: string | null;
  segment_path: string;
  byte_offset: number;
  byte_length: number;
}

interface BrowserServerTraceLink {
  trace_id: string;
  browser_span_id: string;
  server_span_id: string;
  server_source: string;
  server_route: string | null;
}

interface BrowserNoCorsRequestObservation {
  path: string;
  traceparent: string | null;
}

interface BrowserCrossOriginRequestObservation {
  path: string;
  target: "listed" | "unlisted";
  traceparent: string | null;
}

interface BrowserCrossOriginPreflightObservation {
  path: string;
  target: "listed" | "unlisted";
  request_headers: string | null;
}

interface BrowserRuntimeValidationReport {
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
  browser: {
    user_agent: string;
  };
  proxy_requests: BrowserProxyRequestSummary[];
  no_cors_requests: BrowserNoCorsRequestObservation[];
  cross_origin_requests: BrowserCrossOriginRequestObservation[];
  cross_origin_preflights: BrowserCrossOriginPreflightObservation[];
  event_summary: {
    total: number;
    by_type: Record<string, number>;
    console_methods: string[];
    fetch_status_codes: number[];
    network_error_types: string[];
    operations: string[];
    navigation_types: string[];
    resource_initiator_types: string[];
    resource_urls: string[];
    web_vitals: string[];
    web_vital_ratings: string[];
    raw_events_contain_secret: boolean;
    raw_events_contain_redaction: boolean;
  };
  browser_events: BrowserRuntimeEventRow[];
  server_events: BrowserRuntimeEventRow[];
  trace_links: BrowserServerTraceLink[];
  raw_events: unknown[];
  doctor: Record<string, unknown>;
  counts: {
    event_records: number;
    browser_events: number;
    server_events: number;
    event_segments: number;
    logs: number;
  };
  commands: CommandResult[];
  report_file: string | null;
  assertions: string[];
}

const options = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();
const validationId = `browser-runtime-lab-${Date.now()}`;
const dataDir = options.dataDir
  ? resolve(options.dataDir)
  : mkdtempSync(join(tmpdir(), "open-logs-browser-runtime-lab-"));
const dbPath = join(dataDir, "logs.db");
const apiToken = `browser-runtime-token-${Date.now()}`;
const secret = `OPENLOGS_SECRET_CANARY_browser_runtime_lab_${Date.now()}`;
const sessionId = `${validationId}-session`;
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
let crossOriginServer: ReturnType<typeof startCrossOriginServer> | undefined;
let unlistedCrossOriginServer:
  | ReturnType<typeof startCrossOriginServer>
  | undefined;
let browser: Browser | undefined;

try {
  const port = options.port ?? (await getFreePort());
  const appPort = options.appPort ?? (await getFreePort());
  const crossOriginPort = await getFreePort();
  const unlistedCrossOriginPort = await getFreePort();
  const closedPort = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const appBaseUrl = `http://127.0.0.1:${appPort}`;
  const crossOriginBaseUrl = `http://127.0.0.1:${crossOriginPort}`;
  const unlistedCrossOriginBaseUrl = `http://127.0.0.1:${unlistedCrossOriginPort}`;
  const closedBaseUrl = `http://127.0.0.1:${closedPort}`;
  const appDir = join(dataDir, "browser-runtime-app");
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

  appServer = startBrowserAppServer({
    apiToken,
    appBaseUrl,
    appDir,
    appPort,
    browserToken: browserToken.token,
    closedBaseUrl,
    collectorBaseUrl: baseUrl,
    projectId: project.id,
    secret,
    sessionId,
    validationId,
    crossOriginBaseUrl,
    unlistedCrossOriginBaseUrl,
  });

  crossOriginServer = startCrossOriginServer({
    apiToken,
    appBaseUrl,
    collectorBaseUrl: baseUrl,
    crossOriginPort,
    projectId: project.id,
    route: "/cross-origin",
    target: "listed",
    waitForTelemetry: true,
  });

  unlistedCrossOriginServer = startCrossOriginServer({
    apiToken,
    appBaseUrl,
    collectorBaseUrl: baseUrl,
    crossOriginPort: unlistedCrossOriginPort,
    projectId: project.id,
    route: "/cross-origin-unlisted",
    target: "unlisted",
    waitForTelemetry: false,
  });

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(`${appBaseUrl}/?token=${encodeURIComponent(secret)}`, {
    waitUntil: "domcontentloaded",
  });
  await waitForBrowserDone(page);
  await waitForProxyRequestCount(appServer.requests, 1);

  const proxyRequest = appServer.requests.find(
    (request) => request.upstream_status === 201,
  );
  assert(proxyRequest, "browser runtime telemetry reached the real collector");
  assert(
    proxyRequest.request_had_browser_token,
    "browser runtime telemetry carried the scoped browser token",
  );
  assert(
    proxyRequest.event_count >= 13,
    "browser runtime telemetry flushed console, exception, fetch, network, navigation, resource, and web vital events",
  );

  const userAgent = await page.evaluate(() => navigator.userAgent);
  await browser.close();
  browser = undefined;

  const browserEvents = readBrowserEvents(dbPath, project.id);
  const serverEvents = readRuntimeEvents(dbPath, project.id, "node");
  const rawEvents = browserEvents.map((row) =>
    readRawEventFromRow(dataDir, row),
  );
  const serverRawEvents = serverEvents.map((row) =>
    readRawEventFromRow(dataDir, row),
  );
  const projectRawEvents = [...rawEvents, ...serverRawEvents];
  const traceLinks = summarizeBrowserServerTraceLinks(projectRawEvents);
  const rawJson = JSON.stringify(projectRawEvents);
  assert(
    browserEvents.length >= 13,
    "SQLite indexed at least thirteen browser runtime events",
  );
  assert(
    browserEvents.every((row) => row.project_id === project.id),
    "all browser runtime events use the token-owned project",
  );
  assert(
    !rawJson.includes(secret),
    "raw browser and server runtime events do not contain the canary secret",
  );
  assert(
    rawJson.includes("[REDACTED]"),
    "raw browser and server runtime events contain redaction markers",
  );
  assert(
    serverEvents.length >= 2,
    "server runtime request spans were indexed for browser app requests",
  );
  assert(
    traceLinks.length >= 3,
    "browser fetch spans are trace-linked to server request spans",
  );
  assert(
    crossOriginServer.requests.length === 1 &&
      crossOriginServer.requests.every((request) =>
        request.traceparent?.match(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/),
      ),
    "browser explicit cross-origin trace target sent traceparent to the server",
  );
  assert(
    crossOriginServer.preflights.length >= 1 &&
      crossOriginServer.preflights.every((preflight) =>
        corsRequestHeaderTokens(preflight.request_headers).includes(
          "traceparent",
        ),
      ),
    "browser explicit cross-origin trace target preflight requested traceparent",
  );
  assert(
    traceLinks.some((link) => link.server_route === "/cross-origin"),
    "browser explicit cross-origin trace target linked to a server request span",
  );
  assert(
    unlistedCrossOriginServer.requests.length === 1 &&
      unlistedCrossOriginServer.requests.every(
        (request) => request.traceparent === null,
      ),
    "browser unlisted cross-origin target did not send traceparent",
  );
  assert(
    unlistedCrossOriginServer.preflights.length >= 1 &&
      unlistedCrossOriginServer.preflights.every((preflight) => {
        const headers = corsRequestHeaderTokens(preflight.request_headers);
        return (
          headers.includes("x-open-logs-lab") &&
          !headers.includes("traceparent")
        );
      }),
    "browser unlisted cross-origin target preflight omitted traceparent",
  );

  const unlistedCrossOriginSpans = rawEvents.filter((event) =>
    isBrowserHttpClientSpanFor(event, "/cross-origin-unlisted"),
  );
  const unlistedCrossOriginSpan = unlistedCrossOriginSpans[0];
  const unlistedCrossOriginAttributes =
    isRecord(unlistedCrossOriginSpan) &&
    isRecord(unlistedCrossOriginSpan.attributes)
      ? unlistedCrossOriginSpan.attributes
      : {};
  assert(
    unlistedCrossOriginSpans.length === 1 && isRecord(unlistedCrossOriginSpan),
    "browser runtime captured exactly one unlisted cross-origin fetch client span",
  );
  assert(
    isRecord(unlistedCrossOriginSpan) &&
      typeof unlistedCrossOriginSpan.trace_id !== "string",
    "browser unlisted cross-origin fetch span did not assign a false trace ID",
  );
  assert(
    isRecord(unlistedCrossOriginSpan) &&
      typeof unlistedCrossOriginSpan.span_id === "string" &&
      unlistedCrossOriginSpan.span_id.startsWith("span_"),
    "browser unlisted cross-origin fetch span used the fallback span ID shape",
  );
  assert(
    unlistedCrossOriginAttributes.traceparent_propagated === undefined &&
      unlistedCrossOriginAttributes.traceparent_existing === undefined &&
      unlistedCrossOriginAttributes.traceparent_suppressed === undefined,
    "browser unlisted cross-origin fetch span records no traceparent state",
  );

  const noCorsSpan = rawEvents.find((event) => {
    if (!isRecord(event) || event.source !== "browser" || event.type !== "span")
      return false;
    const attributes = isRecord(event.attributes) ? event.attributes : {};
    return (
      attributes.operation === "http.client" &&
      typeof attributes.url === "string" &&
      attributes.url.includes("/no-cors")
    );
  });
  const noCorsAttributes =
    isRecord(noCorsSpan) && isRecord(noCorsSpan.attributes)
      ? noCorsSpan.attributes
      : {};
  assert(
    appServer.noCorsRequests.length === 1 &&
      appServer.noCorsRequests.every((request) => request.traceparent === null),
    "browser no-cors fetch did not send traceparent to the server",
  );
  assert(
    isRecord(noCorsSpan),
    "browser runtime captured no-cors fetch client span",
  );
  assert(
    isRecord(noCorsSpan) && typeof noCorsSpan.trace_id !== "string",
    "browser no-cors fetch span did not assign a false trace ID",
  );
  assert(
    isRecord(noCorsSpan) &&
      typeof noCorsSpan.span_id === "string" &&
      noCorsSpan.span_id.startsWith("span_"),
    "browser no-cors fetch span used the fallback span ID shape",
  );
  assert(
    noCorsAttributes.traceparent_propagated === undefined &&
      noCorsAttributes.traceparent_suppressed === "no-cors",
    "browser no-cors fetch span records traceparent suppression instead of propagation",
  );
  const blobSpan = rawEvents.find((event) => {
    if (!isRecord(event) || event.source !== "browser" || event.type !== "span")
      return false;
    const attributes = isRecord(event.attributes) ? event.attributes : {};
    return (
      attributes.operation === "http.client" &&
      typeof attributes.url === "string" &&
      attributes.url.startsWith("blob:")
    );
  });
  const blobAttributes =
    isRecord(blobSpan) && isRecord(blobSpan.attributes)
      ? blobSpan.attributes
      : {};
  assert(isRecord(blobSpan), "browser runtime captured blob fetch client span");
  assert(
    isRecord(blobSpan) && typeof blobSpan.trace_id !== "string",
    "browser blob fetch span did not assign a false trace ID",
  );
  assert(
    isRecord(blobSpan) &&
      typeof blobSpan.span_id === "string" &&
      blobSpan.span_id.startsWith("span_"),
    "browser blob fetch span used the fallback span ID shape",
  );
  assert(
    blobAttributes.traceparent_propagated === undefined &&
      blobAttributes.traceparent_suppressed === "non-http",
    "browser blob fetch span records non-http traceparent suppression instead of propagation",
  );

  const summary = summarizeRawEvents(rawEvents);
  assert(
    summary.by_type.log >= 5,
    "browser runtime captured five console log levels",
  );
  assert(
    summary.by_type.exception >= 2,
    "browser runtime captured error and rejection exceptions",
  );
  assert(
    summary.by_type.span >= 2,
    "browser runtime captured successful and failed fetch spans",
  );
  assert(
    summary.operations.includes("browser.navigation"),
    "browser runtime captured navigation span operation metadata",
  );
  assert(
    summary.navigation_types.includes("page_load"),
    "browser runtime captured page-load navigation metadata",
  );
  assert(
    summary.navigation_types.includes("pushState"),
    "browser runtime captured History API navigation metadata",
  );
  assert(
    summary.operations.includes("browser.resource"),
    "browser runtime captured resource timing span operation metadata",
  );
  assert(
    summary.resource_initiator_types.length > 0,
    "browser runtime resource timing preserved initiator metadata",
  );
  assert(
    summary.resource_urls.length > 0 &&
      summary.resource_urls.every((url) => !url.includes("/collector")),
    "browser runtime resource timing excluded collector writes",
  );
  assert(
    summary.by_type.metric >= 1,
    "browser runtime captured at least one web vital metric",
  );
  assert(
    summary.operations.includes("browser.web_vital"),
    "browser runtime captured web vital operation metadata",
  );
  assert(
    summary.web_vitals.includes("fcp"),
    "browser runtime captured first contentful paint metadata",
  );
  assert(
    summary.by_type.network >= 1,
    "browser runtime captured a thrown fetch network event",
  );
  assert(
    ["debug", "log", "info", "warn", "error"].every((method) =>
      summary.console_methods.includes(method),
    ),
    "browser runtime console events preserve console_method metadata",
  );
  assert(
    summary.fetch_status_codes.includes(204),
    "browser runtime fetch span captured HTTP 204",
  );
  assert(
    summary.fetch_status_codes.includes(503),
    "browser runtime fetch span captured HTTP 503",
  );
  assert(
    summary.network_error_types.length > 0,
    "browser runtime network failure recorded an error type",
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
    "doctor segments verified raw browser runtime telemetry",
  );
  assert(
    readNumber(doctorResult, "unindexed_raw_events") === 0,
    "doctor found no unindexed raw browser runtime events",
  );

  const counts = readCounts(dbPath);
  const reportFile =
    options.output ??
    (options.keep || options.dataDir
      ? join(dataDir, "browser-runtime-validation-report.json")
      : null);
  const report: BrowserRuntimeValidationReport = {
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
    browser: { user_agent: userAgent },
    proxy_requests: appServer.requests,
    no_cors_requests: appServer.noCorsRequests,
    cross_origin_requests: [
      ...crossOriginServer.requests,
      ...unlistedCrossOriginServer.requests,
    ],
    cross_origin_preflights: [
      ...crossOriginServer.preflights,
      ...unlistedCrossOriginServer.preflights,
    ],
    event_summary: {
      ...summary,
      total: browserEvents.length,
      raw_events_contain_secret: rawJson.includes(secret),
      raw_events_contain_redaction: rawJson.includes("[REDACTED]"),
    },
    browser_events: browserEvents,
    server_events: serverEvents,
    trace_links: traceLinks,
    raw_events: rawEvents,
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
    `Browser runtime validation failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => undefined);
  appServer?.server.stop(true);
  crossOriginServer?.server.stop(true);
  unlistedCrossOriginServer?.server.stop(true);
  if (server) await stopServer(server);
  if (!options.keep && !options.dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function buildBrowserApp(appDir: string): Promise<void> {
  const entryPath = join(appDir, "browser-runtime-app.ts");
  writeFileSync(
    entryPath,
    [
      `import { initUniversalLogs } from ${JSON.stringify(join(repoRoot, "sdk/src/index.ts"))};`,
      "const config = window.__OPEN_LOGS_BROWSER_RUNTIME_LAB__;",
      "const controller = initUniversalLogs({",
      "  url: config.collectorUrl,",
      "  projectId: config.projectId,",
      "  browserToken: config.browserToken,",
      "  sessionId: config.sessionId,",
      "  maxBatchSize: 50,",
      "  maxQueueSize: 50,",
      "  flushIntervalMs: 60000,",
      "  captureNavigation: true,",
      "  captureResourceTiming: true,",
      "  maxResourceTimingEvents: 20,",
      "  captureWebVitals: true,",
      "  maxWebVitalEvents: 20,",
      "  propagateTrace: true,",
      "  tracePropagationTargets: [config.appBaseUrl, config.crossOriginBaseUrl],",
      "});",
      "window.__OPEN_LOGS_BROWSER_RUNTIME_LAB_CONTROLLER__ = controller;",
      "function dispatchSyntheticErrorEvents() {",
      "  const error = new Error(`browser runtime exception token=${config.secret}`);",
      "  window.dispatchEvent(new ErrorEvent('error', { message: error.message, error }));",
      "  const rejection = new Error(`browser runtime rejection token=${config.secret}`);",
      "  if (typeof PromiseRejectionEvent === 'function') {",
      "    window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { reason: rejection, promise: Promise.resolve() }));",
      "  } else {",
      "    const event = new Event('unhandledrejection');",
      "    Object.defineProperty(event, 'reason', { value: rejection });",
      "    window.dispatchEvent(event);",
      "  }",
      "}",
      "async function run() {",
      "  console.debug(`browser runtime debug token=${config.secret}`);",
      "  console.log(`browser runtime log token=${config.secret}`);",
      "  console.info(`browser runtime info token=${config.secret}`);",
      "  console.warn(`browser runtime warn token=${config.secret}`);",
      "  console.error(new Error(`browser runtime error token=${config.secret}`));",
      "  dispatchSyntheticErrorEvents();",
      "  history.pushState({}, '', `/route?token=${encodeURIComponent(config.secret)}`);",
      "  await fetch(`/ok?token=${encodeURIComponent(config.secret)}`);",
      "  await fetch(`/fail?token=${encodeURIComponent(config.secret)}`);",
      "  await fetch(`${config.crossOriginBaseUrl}/cross-origin?token=${encodeURIComponent(config.secret)}`);",
      "  await fetch(`${config.unlistedCrossOriginBaseUrl}/cross-origin-unlisted?token=${encodeURIComponent(config.secret)}`, { headers: { 'x-open-logs-lab': 'unlisted' } });",
      "  await fetch(`/no-cors?token=${encodeURIComponent(config.secret)}`, { mode: 'no-cors' });",
      "  const blobUrl = URL.createObjectURL(new Blob([`browser runtime blob token=${config.secret}`], { type: 'text/plain' }));",
      "  try {",
      "    await fetch(blobUrl);",
      "  } finally {",
      "    URL.revokeObjectURL(blobUrl);",
      "  }",
      "  try {",
      "    await fetch(`${config.closedBaseUrl}/network?token=${encodeURIComponent(config.secret)}`);",
      "  } catch {",
      "    // Expected: closed port validates thrown browser fetch capture.",
      "  }",
      "  await new Promise((resolve) => setTimeout(resolve, 500));",
      "  await controller?.flush();",
      "  controller?.stop();",
      "  window.__OPEN_LOGS_BROWSER_RUNTIME_LAB_DONE__ = true;",
      "}",
      "run().catch((error) => {",
      "  window.__OPEN_LOGS_BROWSER_RUNTIME_LAB_ERROR__ = error?.stack ?? String(error);",
      "  window.__OPEN_LOGS_BROWSER_RUNTIME_LAB_DONE__ = true;",
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
      `Browser runtime app bundle failed:\n${result.logs.map(String).join("\n")}`,
    );
  }
}

function startBrowserAppServer(input: {
  apiToken: string;
  appBaseUrl: string;
  appDir: string;
  appPort: number;
  browserToken: string;
  closedBaseUrl: string;
  collectorBaseUrl: string;
  projectId: string;
  secret: string;
  sessionId: string;
  validationId: string;
  crossOriginBaseUrl: string;
  unlistedCrossOriginBaseUrl: string;
}): {
  server: ReturnType<typeof Bun.serve>;
  requests: BrowserProxyRequestSummary[];
  noCorsRequests: BrowserNoCorsRequestObservation[];
} {
  const requests: BrowserProxyRequestSummary[] = [];
  const noCorsRequests: BrowserNoCorsRequestObservation[] = [];
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
      if (url.pathname === "/asset.css") {
        return new Response("body { color: #111; }", {
          headers: { "Content-Type": "text/css" },
        });
      }
      if (url.pathname === "/ok") {
        return await captureHttpRequest(
          request,
          () => new Response(null, { status: 204 }),
          {
            url: input.collectorBaseUrl,
            projectId: input.projectId,
            apiKey: input.apiToken,
            source: "node",
            framework: "browser-runtime-lab",
            route: "/ok",
            waitForTelemetry: true,
          },
        );
      }
      if (url.pathname === "/fail") {
        return await captureHttpRequest(
          request,
          () =>
            new Response("browser runtime failure fixture", { status: 503 }),
          {
            url: input.collectorBaseUrl,
            projectId: input.projectId,
            apiKey: input.apiToken,
            source: "node",
            framework: "browser-runtime-lab",
            route: "/fail",
            waitForTelemetry: true,
          },
        );
      }
      if (url.pathname === "/no-cors") {
        noCorsRequests.push({
          path: url.pathname,
          traceparent: request.headers.get("traceparent"),
        });
        return new Response(null, { status: 204 });
      }
      if (
        url.pathname === "/collector/api/events" &&
        request.method === "POST"
      ) {
        return await handleCollectorProxy(request, input, requests);
      }
      if (url.pathname === "/") {
        return new Response(browserHtml(input), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, requests, noCorsRequests };
}

function startCrossOriginServer(input: {
  apiToken: string;
  appBaseUrl: string;
  collectorBaseUrl: string;
  crossOriginPort: number;
  projectId: string;
  route: string;
  target: "listed" | "unlisted";
  waitForTelemetry: boolean;
}): {
  server: ReturnType<typeof Bun.serve>;
  requests: BrowserCrossOriginRequestObservation[];
  preflights: BrowserCrossOriginPreflightObservation[];
} {
  const requests: BrowserCrossOriginRequestObservation[] = [];
  const preflights: BrowserCrossOriginPreflightObservation[] = [];
  const corsHeaders = {
    "Access-Control-Allow-Headers": "traceparent, x-open-logs-lab",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Origin": input.appBaseUrl,
    Vary: "Origin",
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: input.crossOriginPort,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== input.route) {
        return new Response("not found", {
          status: 404,
          headers: corsHeaders,
        });
      }
      if (request.method === "OPTIONS") {
        preflights.push({
          path: url.pathname,
          target: input.target,
          request_headers: request.headers.get(
            "access-control-request-headers",
          ),
        });
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      requests.push({
        path: url.pathname,
        target: input.target,
        traceparent: request.headers.get("traceparent"),
      });
      if (!input.waitForTelemetry) {
        return new Response(null, { status: 204, headers: corsHeaders });
      }
      return await captureHttpRequest(
        request,
        () => new Response(null, { status: 204, headers: corsHeaders }),
        {
          url: input.collectorBaseUrl,
          projectId: input.projectId,
          apiKey: input.apiToken,
          source: "node",
          framework: "browser-runtime-lab",
          route: input.route,
          waitForTelemetry: true,
        },
      );
    },
  });
  return { server, requests, preflights };
}

async function handleCollectorProxy(
  request: Request,
  input: {
    appBaseUrl: string;
    collectorBaseUrl: string;
    secret: string;
  },
  requests: BrowserProxyRequestSummary[],
): Promise<Response> {
  const bodyText = await request.text();
  const body = parseJson(bodyText);
  const events = Array.isArray(body) ? body : [];
  const record: BrowserProxyRequestSummary = {
    path: new URL(request.url).pathname,
    request_had_browser_token: Boolean(
      request.headers.get("x-logs-browser-token"),
    ),
    event_count: events.length,
    event_types: events.map((event) => eventType(event)),
    messages: events
      .map((event) => eventMessage(event))
      .filter(Boolean)
      .map((message) => redactReportCanary(message, input.secret)),
    body_contains_secret: bodyText.includes(input.secret),
    upstream_status: null,
    upstream_body: null,
  };
  requests.push(record);

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

function browserHtml(input: {
  appBaseUrl: string;
  browserToken: string;
  closedBaseUrl: string;
  crossOriginBaseUrl: string;
  unlistedCrossOriginBaseUrl: string;
  projectId: string;
  secret: string;
  sessionId: string;
  validationId: string;
}): string {
  const config = {
    browserToken: input.browserToken,
    appBaseUrl: input.appBaseUrl,
    closedBaseUrl: input.closedBaseUrl,
    collectorUrl: "/collector",
    crossOriginBaseUrl: input.crossOriginBaseUrl,
    unlistedCrossOriginBaseUrl: input.unlistedCrossOriginBaseUrl,
    projectId: input.projectId,
    secret: input.secret,
    sessionId: input.sessionId,
    validationId: input.validationId,
  };
  return [
    "<!doctype html>",
    "<html>",
    `<head><meta charset="utf-8"><title>Open Logs Browser Runtime Lab</title><link rel="stylesheet" href="/asset.css?token=${encodeURIComponent(input.secret)}"></head>`,
    "<body>",
    "<main>Open Logs Browser Runtime Lab</main>",
    `<script>window.__OPEN_LOGS_BROWSER_RUNTIME_LAB__ = ${JSON.stringify(config)};</script>`,
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
        name: "browser runtime validation",
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

function readBrowserEvents(
  dbFile: string,
  projectId: string,
): BrowserRuntimeEventRow[] {
  return readRuntimeEvents(dbFile, projectId, "browser");
}

function readRuntimeEvents(
  dbFile: string,
  projectId: string,
  source: string,
): BrowserRuntimeEventRow[] {
  const db = new Database(dbFile, { readonly: true });
  try {
    const rows = db
      .prepare(`
        SELECT event_id, project_id, source, event_type, severity, trace_id, span_id, parent_span_id, message, segment_path, byte_offset, byte_length
        FROM event_records
        WHERE project_id = ? AND source = ?
        ORDER BY event_time ASC, rowid ASC
      `)
      .all(projectId, source) as BrowserRuntimeEventRow[];
    if (!rows.length)
      throw new Error(
        `${source} runtime events were not indexed in event_records`,
      );
    return rows;
  } finally {
    db.close();
  }
}

function readRawEventFromRow(
  dataDir: string,
  row: BrowserRuntimeEventRow,
): unknown {
  const bytes = readFileSync(join(dataDir, row.segment_path));
  const rawLine = bytes
    .subarray(row.byte_offset, row.byte_offset + row.byte_length)
    .toString("utf8");
  return JSON.parse(rawLine) as unknown;
}

function summarizeRawEvents(rawEvents: unknown[]): {
  by_type: Record<string, number>;
  console_methods: string[];
  fetch_status_codes: number[];
  network_error_types: string[];
  operations: string[];
  navigation_types: string[];
  resource_initiator_types: string[];
  resource_urls: string[];
  web_vitals: string[];
  web_vital_ratings: string[];
} {
  const byType: Record<string, number> = {};
  const consoleMethods = new Set<string>();
  const fetchStatusCodes = new Set<number>();
  const networkErrorTypes = new Set<string>();
  const operations = new Set<string>();
  const navigationTypes = new Set<string>();
  const resourceInitiatorTypes = new Set<string>();
  const resourceUrls = new Set<string>();
  const webVitals = new Set<string>();
  const webVitalRatings = new Set<string>();
  for (const event of rawEvents) {
    if (!isRecord(event)) continue;
    const type = typeof event.type === "string" ? event.type : "unknown";
    byType[type] = (byType[type] ?? 0) + 1;
    const attributes = isRecord(event.attributes) ? event.attributes : {};
    const body = isRecord(event.body) ? event.body : {};
    const operation =
      typeof attributes.operation === "string"
        ? attributes.operation
        : typeof body.operation === "string"
          ? body.operation
          : null;
    if (operation) operations.add(operation);
    if (typeof attributes.console_method === "string") {
      consoleMethods.add(attributes.console_method);
    }
    if (typeof attributes.status_code === "number") {
      fetchStatusCodes.add(attributes.status_code);
    }
    if (typeof attributes.error_type === "string") {
      networkErrorTypes.add(attributes.error_type);
    }
    if (typeof attributes.navigation_type === "string") {
      navigationTypes.add(attributes.navigation_type);
    }
    if (typeof attributes.initiator_type === "string") {
      resourceInitiatorTypes.add(attributes.initiator_type);
    }
    if (
      operation === "browser.resource" &&
      typeof attributes.url === "string"
    ) {
      resourceUrls.add(attributes.url);
    }
    if (operation === "browser.web_vital") {
      if (typeof attributes.web_vital === "string") {
        webVitals.add(attributes.web_vital);
      }
      if (typeof attributes.rating === "string") {
        webVitalRatings.add(attributes.rating);
      }
    }
  }
  return {
    by_type: byType,
    console_methods: [...consoleMethods].sort(),
    fetch_status_codes: [...fetchStatusCodes].sort((a, b) => a - b),
    network_error_types: [...networkErrorTypes].sort(),
    operations: [...operations].sort(),
    navigation_types: [...navigationTypes].sort(),
    resource_initiator_types: [...resourceInitiatorTypes].sort(),
    resource_urls: [...resourceUrls].sort(),
    web_vitals: [...webVitals].sort(),
    web_vital_ratings: [...webVitalRatings].sort(),
  };
}

function summarizeBrowserServerTraceLinks(
  rawEvents: unknown[],
): BrowserServerTraceLink[] {
  const browserSpans = new Map<string, Set<string>>();
  for (const event of rawEvents) {
    if (!isRecord(event)) continue;
    if (event.source !== "browser" || event.type !== "span") continue;
    const attributes = isRecord(event.attributes) ? event.attributes : {};
    if (attributes.operation !== "http.client") continue;
    if (typeof event.trace_id !== "string" || typeof event.span_id !== "string")
      continue;
    const spans = browserSpans.get(event.trace_id) ?? new Set<string>();
    spans.add(event.span_id);
    browserSpans.set(event.trace_id, spans);
  }

  const links: BrowserServerTraceLink[] = [];
  for (const event of rawEvents) {
    if (!isRecord(event)) continue;
    if (event.source === "browser" || event.type !== "span") continue;
    const attributes = isRecord(event.attributes) ? event.attributes : {};
    if (attributes.operation !== "http.server") continue;
    if (
      typeof event.trace_id !== "string" ||
      typeof event.span_id !== "string" ||
      typeof event.parent_span_id !== "string"
    ) {
      continue;
    }
    if (!browserSpans.get(event.trace_id)?.has(event.parent_span_id)) continue;
    links.push({
      trace_id: event.trace_id,
      browser_span_id: event.parent_span_id,
      server_span_id: event.span_id,
      server_source:
        typeof event.source === "string" ? event.source : "unknown",
      server_route:
        typeof attributes.route === "string" ? attributes.route : null,
    });
  }
  return links.sort((a, b) =>
    `${a.trace_id}:${a.server_route ?? ""}`.localeCompare(
      `${b.trace_id}:${b.server_route ?? ""}`,
    ),
  );
}

function readCounts(dbFile: string): BrowserRuntimeValidationReport["counts"] {
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
      server_events: Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM event_records WHERE source = 'node'",
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
    () => Boolean(window.__OPEN_LOGS_BROWSER_RUNTIME_LAB_DONE__),
    null,
    { timeout: 10_000 },
  );
  const error = await page.evaluate(
    () => window.__OPEN_LOGS_BROWSER_RUNTIME_LAB_ERROR__ ?? null,
  );
  if (error) throw new Error(`Browser runtime app failed: ${error}`);
}

async function waitForProxyRequestCount(
  requests: BrowserProxyRequestSummary[],
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
          "Usage: bun scripts/browser-runtime-validation-lab.ts [--keep] [--data-dir <dir>] [--output <file>] [--port <n>] [--app-port <n>]",
          "",
          "Runs a real browser telemetry validation lab for console, exception, fetch, network, raw segment, and SQLite indexing coverage.",
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

function eventType(value: unknown): string {
  return isRecord(value) && typeof value.type === "string"
    ? value.type
    : "unknown";
}

function eventMessage(value: unknown): string {
  return isRecord(value) && typeof value.message === "string"
    ? value.message
    : "";
}

function redactReportCanary(value: string, secret: string): string {
  return value.split(secret).join("[REDACTED]");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function corsRequestHeaderTokens(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function isBrowserHttpClientSpanFor(
  event: unknown,
  urlNeedle: string,
): boolean {
  if (!isRecord(event) || event.source !== "browser" || event.type !== "span")
    return false;
  const attributes = isRecord(event.attributes) ? event.attributes : {};
  return (
    attributes.operation === "http.client" &&
    typeof attributes.url === "string" &&
    attributes.url.includes(urlNeedle)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

declare global {
  interface Window {
    __OPEN_LOGS_BROWSER_RUNTIME_LAB__?: {
      browserToken: string;
      closedBaseUrl: string;
      collectorUrl: string;
      projectId: string;
      secret: string;
      sessionId: string;
      validationId: string;
    };
    __OPEN_LOGS_BROWSER_RUNTIME_LAB_CONTROLLER__?: unknown;
    __OPEN_LOGS_BROWSER_RUNTIME_LAB_DONE__?: boolean;
    __OPEN_LOGS_BROWSER_RUNTIME_LAB_ERROR__?: string;
  }
}
