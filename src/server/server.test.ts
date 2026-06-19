import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { LogsClient } from "../../sdk/src/index.ts";
import { createTestDb } from "../db/index.ts";
import { clearTelemetryEventBusesForTests } from "../lib/event-bus.ts";
import {
  type TelemetryEnvelope,
  appendRawEvent,
  indexRawEvent,
  readRawEvent,
  verifyEventStore,
} from "../lib/event-store.ts";
import { requireApiTokenOrBrowserIngest } from "./auth.ts";
import { resolveCorsOrigin } from "./cors.ts";
import { alertsRoutes } from "./routes/alerts.ts";
import { eventsRoutes } from "./routes/events.ts";
import { issuesRoutes } from "./routes/issues.ts";
import { jobsRoutes } from "./routes/jobs.ts";
import { logsRoutes } from "./routes/logs.ts";
import { otelRoutes } from "./routes/otel.ts";
import { perfRoutes } from "./routes/perf.ts";
import { projectsRoutes } from "./routes/projects.ts";
import { streamRoutes } from "./routes/stream.ts";
import { testReportsRoutes } from "./routes/test-reports.ts";

const TEST_ENV_KEYS = [
  "HASNA_LOGS_API_TOKEN",
  "LOGS_API_TOKEN",
  "HASNA_LOGS_MAX_PAYLOAD_BYTES",
  "HASNA_LOGS_MAX_BATCH_SIZE",
  "HASNA_LOGS_MAX_EVENT_BATCH_SIZE",
  "HASNA_LOGS_MAX_MESSAGE_CHARS",
  "HASNA_LOGS_CORS_ORIGINS",
  "LOGS_CORS_ORIGINS",
  "HASNA_LOGS_STREAM_TEST_HOOKS",
  "HASNA_LOGS_LOCAL_OPEN",
  "LOGS_LOCAL_OPEN",
  "HASNA_LOGS_SECRET_KEY",
  "LOGS_SECRET_KEY",
];
const ORIGINAL_ENV = new Map(
  TEST_ENV_KEYS.map((key) => [key, process.env[key]]),
);

beforeEach(() => {
  for (const key of TEST_ENV_KEYS) delete process.env[key];
  clearTelemetryEventBusesForTests();
});

afterAll(() => {
  for (const [key, value] of ORIGINAL_ENV) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function buildApp(options: { localOpen?: boolean } = {}) {
  if (
    options.localOpen !== false &&
    !process.env.HASNA_LOGS_API_TOKEN &&
    !process.env.LOGS_API_TOKEN
  ) {
    process.env.HASNA_LOGS_LOCAL_OPEN ??= "1";
  }
  const db = createTestDb();
  const app = new Hono();
  app.use("*", cors());
  app.use("/api/*", requireApiTokenOrBrowserIngest(db));
  app.route("/api/logs", logsRoutes(db));
  app.route("/api/logs/stream", streamRoutes(db));
  app.route("/api/events", eventsRoutes(db));
  app.route("/api/test-reports", testReportsRoutes(db));
  app.route("/api/otel", otelRoutes(db));
  app.route("/api/projects", projectsRoutes(db));
  app.route("/api/jobs", jobsRoutes(db));
  app.route("/api/alerts", alertsRoutes(db));
  app.route("/api/issues", issuesRoutes(db));
  app.route("/api/perf", perfRoutes(db));
  return { app, db };
}

async function readSseUntil(res: Response, needle: string): Promise<string> {
  if (!res.body) throw new Error("expected response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (!text.includes(needle)) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value?: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true }), 2_000),
        ),
      ]);
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  if (!text.includes(needle))
    throw new Error(
      `Timed out waiting for SSE payload containing ${needle}. Received: ${text}`,
    );
  return text;
}

describe("POST /api/logs", () => {
  it("ingests a single log", async () => {
    const { app } = buildApp();
    const res = await app.request("/api/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "error", message: "boom" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { level: string; message: string };
    expect(body.level).toBe("error");
    expect(body.message).toBe("boom");
  });

  it("ingests a batch", async () => {
    const { app } = buildApp();
    const res = await app.request("/api/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { level: "info", message: "a" },
        { level: "warn", message: "b" },
      ]),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { inserted: number };
    expect(body.inserted).toBe(2);
  });

  it("rejects non-json requests", async () => {
    const { app } = buildApp();
    const res = await app.request("/api/logs", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "level=info&message=x",
    });
    expect(res.status).toBe(415);
  });

  it("rejects invalid JSON bodies", async () => {
    const { app } = buildApp();
    const res = await app.request("/api/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects unsupported fields and invalid optional field types", async () => {
    const { app } = buildApp();
    const unknown = await app.request("/api/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        level: "info",
        message: "x",
        token: "should-not-be-a-field",
      }),
    });
    expect(unknown.status).toBe(422);

    const typed = await app.request("/api/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "info", message: "x", service: 42 }),
    });
    expect(typed.status).toBe(422);
    expect(await typed.json()).toEqual({
      error: "entry.service must be a string",
    });
  });

  it("rejects oversized payloads, batches, and messages before ingest", async () => {
    const { app, db } = buildApp();

    process.env.HASNA_LOGS_MAX_PAYLOAD_BYTES = "64";
    const oversizedPayload = await app.request("/api/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "info", message: "x".repeat(128) }),
    });
    expect(oversizedPayload.status).toBe(413);

    process.env.HASNA_LOGS_MAX_PAYLOAD_BYTES = "10000";
    process.env.HASNA_LOGS_MAX_BATCH_SIZE = "1";
    const oversizedBatch = await app.request("/api/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { level: "info", message: "a" },
        { level: "info", message: "b" },
      ]),
    });
    expect(oversizedBatch.status).toBe(413);

    process.env.HASNA_LOGS_MAX_BATCH_SIZE = "1000";
    process.env.HASNA_LOGS_MAX_MESSAGE_CHARS = "4";
    const oversizedMessage = await app.request("/api/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "info", message: "12345" }),
    });
    expect(oversizedMessage.status).toBe(413);

    const count = db.prepare("SELECT COUNT(*) AS count FROM logs").get() as {
      count: number;
    };
    expect(count.count).toBe(0);
  });

  it("requires a bearer or x-logs-token header when an API token is configured", async () => {
    process.env.HASNA_LOGS_API_TOKEN = "test-token";
    const { app } = buildApp();

    const unauthorized = await app.request("/api/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "info", message: "blocked" }),
    });
    expect(unauthorized.status).toBe(401);

    const bearer = await app.request("/api/logs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-token",
      },
      body: JSON.stringify({ level: "info", message: "accepted bearer" }),
    });
    expect(bearer.status).toBe(201);

    const header = await app.request("/api/logs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Logs-Token": "test-token",
      },
      body: JSON.stringify({ level: "info", message: "accepted header" }),
    });
    expect(header.status).toBe(201);
  });

  it("locks no-token API requests by default and only allows explicit local-open loopback requests", async () => {
    const { app } = buildApp({ localOpen: false });

    const lockedLocal = await app.request("http://127.0.0.1/api/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "info", message: "local blocked" }),
    });
    expect(lockedLocal.status).toBe(401);

    process.env.HASNA_LOGS_LOCAL_OPEN = "1";
    const explicitLocal = await app.request("http://127.0.0.1/api/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "info", message: "local accepted" }),
    });
    expect(explicitLocal.status).toBe(201);

    const remote = await app.request("https://telemetry.example/api/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "info", message: "remote blocked" }),
    });
    expect(remote.status).toBe(401);
  });

  it("requires the configured API token for telemetry reads, exports, streams, and admin routes", async () => {
    process.env.HASNA_LOGS_API_TOKEN = "read-token";
    const { app, db } = buildApp();
    const { ingestLog } = await import("../lib/ingest.ts");
    ingestLog(db, {
      level: "error",
      message: "private telemetry",
      trace_id: "trace-auth",
    });

    const protectedRequests = [
      ["/api/logs", { method: "GET" }],
      ["/api/logs/tail", { method: "GET" }],
      ["/api/logs/summary", { method: "GET" }],
      ["/api/logs/count", { method: "GET" }],
      ["/api/logs/recent-errors", { method: "GET" }],
      ["/api/logs/trace-auth/context", { method: "GET" }],
      ["/api/logs/export?format=json", { method: "GET" }],
      ["/api/logs/stream", { method: "GET" }],
      ["/api/events", { method: "GET" }],
      [
        "/api/events",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "span", message: "blocked" }),
        },
      ],
      ["/api/events/private-event", { method: "GET" }],
      ["/api/test-reports", { method: "GET" }],
      ["/api/test-reports/private-report", { method: "GET" }],
      [
        "/api/otel/v1/traces",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ resourceSpans: [] }),
        },
      ],
      ["/api/projects", { method: "GET" }],
      ["/api/jobs", { method: "GET" }],
      ["/api/perf?project_id=missing", { method: "GET" }],
      [
        "/api/projects",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "blocked" }),
        },
      ],
    ] as const;

    for (const [path, init] of protectedRequests) {
      const unauthorized = await app.request(path, init);
      expect(unauthorized.status).toBe(401);
    }

    const logs = await app.request("/api/logs", {
      headers: { Authorization: "Bearer read-token" },
    });
    expect(logs.status).toBe(200);

    const exported = await app.request("/api/logs/export?format=json", {
      headers: { "X-Logs-Token": "read-token" },
    });
    expect(exported.status).toBe(200);

    const projects = await app.request("/api/projects", {
      headers: { Authorization: "Bearer read-token" },
    });
    expect(projects.status).toBe(200);

    const controller = new AbortController();
    const eventStream = await app.request(
      "/api/events/stream?event_name=event",
      {
        headers: { Authorization: "Bearer read-token" },
        signal: controller.signal,
      },
    );
    expect(eventStream.status).toBe(200);
    controller.abort();

    const perf = await app.request("/api/perf", {
      headers: { Authorization: "Bearer read-token" },
    });
    expect(perf.status).toBe(422);
  });

  it("allows scoped browser ingest tokens to write only browser logs for their project", async () => {
    process.env.HASNA_LOGS_API_TOKEN = "admin-token";
    const { app, db } = buildApp();

    const pRes = await app.request("/api/projects", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer admin-token",
      },
      body: JSON.stringify({ name: "browser-token-app" }),
    });
    const project = (await pRes.json()) as { id: string };

    const unauthorizedTokenCreate = await app.request(
      `/api/projects/${project.id}/browser-tokens`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "browser" }),
      },
    );
    expect(unauthorizedTokenCreate.status).toBe(401);

    const tokenRes = await app.request(
      `/api/projects/${project.id}/browser-tokens`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer admin-token",
        },
        body: JSON.stringify({
          name: "browser",
          allowed_origins: ["https://app.example/path"],
        }),
      },
    );
    expect(tokenRes.status).toBe(201);
    const tokenBody = (await tokenRes.json()) as {
      id: string;
      token: string;
      token_prefix: string;
      allowed_origins: string;
    };
    expect(tokenBody.token).toStartWith("olb_");
    expect(tokenBody.token_prefix).toBe(tokenBody.token.slice(0, 12));
    expect(JSON.stringify(tokenBody)).not.toContain("token_hash");
    expect(JSON.parse(tokenBody.allowed_origins)).toEqual([
      "https://app.example",
    ]);

    const listRes = await app.request(
      `/api/projects/${project.id}/browser-tokens`,
      {
        headers: { Authorization: "Bearer admin-token" },
      },
    );
    expect(listRes.status).toBe(200);
    expect(JSON.stringify(await listRes.json())).not.toContain(tokenBody.token);

    const writeRes = await app.request("/api/logs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Logs-Browser-Token": tokenBody.token,
        Origin: "https://app.example",
      },
      body: JSON.stringify({
        level: "error",
        source: "script",
        project_id: "spoofed",
        message: "browser boom",
      }),
    });
    expect(writeRes.status).toBe(201);
    const row = (await writeRes.json()) as {
      id: string;
      project_id: string;
      source: string;
    };
    expect(row.project_id).toBe(project.id);
    expect(row.source).toBe("script");

    const eventWrite = await app.request("/api/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Logs-Browser-Token": tokenBody.token,
        Origin: "https://app.example",
      },
      body: JSON.stringify({
        type: "exception",
        event_id: "browser-producer-event-1",
        source: "browser",
        message: "browser exception event",
        attributes: { stack_trace: "Error: browser exception event" },
      }),
    });
    expect(eventWrite.status).toBe(201);
    const eventBody = (await eventWrite.json()) as {
      event_id: string;
      project_id: string;
      source: string;
      metadata: Record<string, unknown>;
    };
    expect(eventBody.event_id).toStartWith("evt_browser_");
    expect(eventBody.event_id).not.toBe("browser-producer-event-1");
    expect(eventBody.project_id).toBe(project.id);
    expect(eventBody.source).toBe("browser");
    expect(eventBody.metadata.ingest_scope).toBe("browser");
    expect(JSON.stringify(eventBody)).not.toContain(tokenBody.token);
    expect(JSON.stringify(eventBody)).not.toContain(tokenBody.token_prefix);

    const rawBrowserEvent = readRawEvent(db, eventBody.event_id);
    expect(JSON.stringify(rawBrowserEvent)).not.toContain(tokenBody.token);
    expect(JSON.stringify(rawBrowserEvent)).not.toContain(
      tokenBody.token_prefix,
    );
    expect(JSON.stringify(rawBrowserEvent)).toContain("[REDACTED]");

    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (
        input: string | URL | Request,
        init?: RequestInit,
      ) => {
        const requestUrl = new URL(String(input));
        const headers = new Headers(init?.headers);
        headers.set("Origin", "https://app.example");
        return app.request(`${requestUrl.pathname}${requestUrl.search}`, {
          method: init?.method,
          headers,
          body: init?.body,
        });
      }) as typeof fetch;
      const sdkClient = new LogsClient({
        url: "http://collector.test",
        projectId: "sdk-spoofed-project",
        browserToken: tokenBody.token,
        source: "browser",
        environment: "browser-test",
        appId: "browser-sdk-app",
        machineId: "sdk-spoofed-machine",
        repoId: "sdk-spoofed-repo",
        processId: "sdk-spoofed-process",
        runId: "sdk-spoofed-run",
        sessionId: "browser-sdk-session",
      });
      const sdkEvent = await sdkClient.pushEvent({
        type: "log",
        event_id: "browser-sdk-producer-event-1",
        message: "sdk browser event",
        project_id: "event-spoofed-project",
        machine_id: "event-spoofed-machine",
        attributes: {
          project_id: "nested-spoofed-project",
          machine_id: "nested-spoofed-machine",
          url: "https://app.example/sdk",
        },
      });
      expect(sdkEvent.project_id).toBe(project.id);
      expect(sdkEvent.source).toBe("browser");
      expect(sdkEvent.event_id).toStartWith("evt_browser_");
      expect(sdkEvent.message).toBe("sdk browser event");
      expect(JSON.stringify(sdkEvent)).not.toContain("spoofed");
    } finally {
      globalThis.fetch = originalFetch;
    }

    const invalidEventSource = await app.request("/api/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Logs-Browser-Token": tokenBody.token,
        Origin: "https://app.example",
      },
      body: JSON.stringify({
        type: "exception",
        source: "node",
        message: "server spoof",
      }),
    });
    expect(invalidEventSource.status).toBe(422);

    const invalidNestedIdentity = await app.request("/api/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Logs-Browser-Token": tokenBody.token,
        Origin: "https://app.example",
      },
      body: JSON.stringify({
        type: "exception",
        source: "browser",
        message: "nested identity spoof",
        attributes: {
          machine_id: "machine-spoof",
          process_id: "process-spoof",
        },
        metadata: { run_id: "run-spoof" },
      }),
    });
    expect(invalidNestedIdentity.status).toBe(422);

    const invalidTopLevelIdentity = await app.request("/api/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Logs-Browser-Token": tokenBody.token,
        Origin: "https://app.example",
      },
      body: JSON.stringify({
        type: "metric",
        source: "browser",
        message: "top-level identity spoof",
        artifact_id: "artifact-spoof",
      }),
    });
    expect(invalidTopLevelIdentity.status).toBe(422);
    expect(await invalidTopLevelIdentity.json()).toEqual({
      error:
        "event[0].artifact_id cannot be set when using a browser ingest token",
    });

    const invalidEventType = await app.request("/api/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Logs-Browser-Token": tokenBody.token,
        Origin: "https://app.example",
      },
      body: JSON.stringify({
        type: "process",
        source: "browser",
        message: "process spoof",
      }),
    });
    expect(invalidEventType.status).toBe(422);

    const projectBRes = await app.request("/api/projects", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer admin-token",
      },
      body: JSON.stringify({ name: "browser-token-app-b" }),
    });
    const projectB = (await projectBRes.json()) as { id: string };
    const tokenBRes = await app.request(
      `/api/projects/${projectB.id}/browser-tokens`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer admin-token",
        },
        body: JSON.stringify({
          name: "browser-b",
          allowed_origins: ["https://app.example"],
        }),
      },
    );
    const tokenB = (await tokenBRes.json()) as { token: string };
    const crossProjectDuplicate = await app.request("/api/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Logs-Browser-Token": tokenB.token,
        Origin: "https://app.example",
      },
      body: JSON.stringify({
        type: "exception",
        event_id: eventBody.event_id,
        source: "browser",
        message: "attempt to read project a event",
      }),
    });
    expect(crossProjectDuplicate.status).toBe(201);
    const crossProjectBody = (await crossProjectDuplicate.json()) as {
      event_id: string;
      project_id: string;
      message: string;
    };
    expect(crossProjectBody.project_id).toBe(projectB.id);
    expect(crossProjectBody.event_id).toStartWith("evt_browser_");
    expect(crossProjectBody.event_id).not.toBe(eventBody.event_id);
    expect(crossProjectBody.message).toBe("attempt to read project a event");

    const tokenRow = db
      .prepare(
        "SELECT token_hash, last_used_at FROM browser_ingest_tokens WHERE id = ?",
      )
      .get(tokenBody.id) as { token_hash: string; last_used_at: string | null };
    expect(tokenRow.token_hash).not.toContain(tokenBody.token);
    expect(tokenRow.last_used_at).toBeTruthy();

    const readDenied = await app.request("/api/logs", {
      headers: {
        "X-Logs-Browser-Token": tokenBody.token,
        Origin: "https://app.example",
      },
    });
    expect(readDenied.status).toBe(401);

    const adminDenied = await app.request("/api/projects", {
      headers: {
        "X-Logs-Browser-Token": tokenBody.token,
        Origin: "https://app.example",
      },
    });
    expect(adminDenied.status).toBe(401);

    const wrongOrigin = await app.request("/api/logs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Logs-Browser-Token": tokenBody.token,
        Origin: "https://evil.example",
      },
      body: JSON.stringify({
        level: "error",
        source: "script",
        message: "wrong origin",
      }),
    });
    expect(wrongOrigin.status).toBe(401);

    const invalidSource = await app.request("/api/logs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Logs-Browser-Token": tokenBody.token,
        Origin: "https://app.example",
      },
      body: JSON.stringify({
        level: "error",
        source: "node",
        message: "server spoof",
      }),
    });
    expect(invalidSource.status).toBe(422);

    const count = db
      .prepare("SELECT COUNT(*) AS count FROM logs WHERE project_id = ?")
      .get(project.id) as { count: number };
    expect(count.count).toBe(1);

    const revoke = await app.request(
      `/api/projects/${project.id}/browser-tokens/${tokenBody.id}`,
      {
        method: "DELETE",
        headers: { Authorization: "Bearer admin-token" },
      },
    );
    expect(revoke.status).toBe(200);
    expect(await revoke.json()).toEqual({ revoked: true });

    const afterRevoke = await app.request("/api/logs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Logs-Browser-Token": tokenBody.token,
        Origin: "https://app.example",
      },
      body: JSON.stringify({
        level: "error",
        source: "script",
        message: "after revoke",
      }),
    });
    expect(afterRevoke.status).toBe(401);
  });

  it("redacts canary secrets from HTTP ingest before SQLite and raw segment persistence", async () => {
    const { app, db } = buildApp();
    const secret = "OPENLOGS_SECRET_CANARY_http_route_12345";
    const res = await app.request("/api/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "http-redaction-1",
        level: "error",
        message: `api key ${secret}`,
        url: `https://example.test/collect?token=${secret}`,
        stack_trace: `Authorization: Bearer ${secret}`,
        metadata: { password: secret, nested: { token: secret } },
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      message: string;
      url: string;
      stack_trace: string;
      metadata: string;
    };
    expect(JSON.stringify(body)).not.toContain(secret);

    const raw = readRawEvent(db, body.id);
    expect(JSON.stringify(raw)).not.toContain(secret);
    expect(JSON.stringify(raw)).toContain("[REDACTED]");
  });
});

describe("POST /api/logs/structured", () => {
  it("ingests Pino and Winston-style structured logs through the canonical log store", async () => {
    const { app, db } = buildApp();
    const secret = "OPENLOGS_SECRET_CANARY_structured_route_12345";
    const pino = await app.request(
      "/api/logs/structured?format=pino&service=api&environment=test",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          level: 50,
          time: 1781596800000,
          msg: `route failed token=${secret}`,
          traceId: "trace-route-pino",
          err: { stack: `Error: route failed ${secret}` },
          token: secret,
        }),
      },
    );
    expect(pino.status).toBe(201);
    const pinoBody = (await pino.json()) as {
      inserted: number;
      events: Array<{
        id: string;
        source: string;
        level: string;
        service: string;
        message: string;
      }>;
    };
    expect(pinoBody.inserted).toBe(1);
    expect(pinoBody.events[0]).toMatchObject({
      source: "pino",
      level: "error",
      service: "api",
      message: "route failed token=[REDACTED]",
    });
    expect(
      JSON.stringify(readRawEvent(db, pinoBody.events[0]?.id ?? "")),
    ).not.toContain(secret);

    const winston = await app.request("/api/logs/structured", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format: "winston",
        service: "worker",
        logs: [
          {
            level: "warn",
            timestamp: "2026-06-16T10:00:00.000Z",
            message: "retry scheduled",
            trace_id: "trace-route-winston",
          },
        ],
      }),
    });
    expect(winston.status).toBe(201);
    const winstonBody = (await winston.json()) as {
      inserted: number;
      events: Array<{ source: string; service: string; trace_id: string }>;
    };
    expect(winstonBody).toMatchObject({
      inserted: 1,
      events: [
        {
          source: "winston",
          service: "worker",
          trace_id: "trace-route-winston",
        },
      ],
    });

    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM logs WHERE source IN ('pino','winston')",
        )
        .get(),
    ).toEqual({ count: 2 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM event_records WHERE source IN ('pino','winston')",
        )
        .get(),
    ).toEqual({ count: 2 });
  });

  it("rejects malformed structured requests before ingest", async () => {
    const { app, db } = buildApp();
    const nonJson = await app.request("/api/logs/structured", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "hello",
    });
    expect(nonJson.status).toBe(415);

    const invalid = await app.request("/api/logs/structured?format=bad", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "info", message: "ok" }),
    });
    expect(invalid.status).toBe(422);

    const missingMessage = await app.request("/api/logs/structured", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: "info" }),
    });
    expect(missingMessage.status).toBe(422);

    const browserSource = await app.request(
      "/api/logs/structured?source=browser",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: "info", message: "source spoof" }),
      },
    );
    expect(browserSource.status).toBe(422);
    expect(await browserSource.json()).toEqual({
      error:
        "entry[0].source cannot be browser or script for structured server log ingest",
    });

    const scriptEnvelopeSource = await app.request("/api/logs/structured", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "script",
        logs: [{ level: "info", message: "source spoof" }],
      }),
    });
    expect(scriptEnvelopeSource.status).toBe(422);

    const missingProject = await app.request(
      "/api/logs/structured?project_id=missing-project",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level: "info", message: "missing project" }),
      },
    );
    expect(missingProject.status).toBe(422);
    expect(await missingProject.json()).toEqual({
      error: "entry[0].project_id does not exist",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM logs").get()).toEqual({
      count: 0,
    });
    expect(verifyEventStore(db).unindexed_raw_events).toBe(0);
  });

  it("does not accept browser ingest tokens for server-side structured logs", async () => {
    process.env.HASNA_LOGS_API_TOKEN = "admin-token";
    const { app } = buildApp();
    const projectRes = await app.request("/api/projects", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer admin-token",
      },
      body: JSON.stringify({ name: "structured-browser-token-app" }),
    });
    const project = (await projectRes.json()) as { id: string };
    const tokenRes = await app.request(
      `/api/projects/${project.id}/browser-tokens`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer admin-token",
        },
        body: JSON.stringify({
          name: "browser",
          allowed_origins: ["https://app.example"],
        }),
      },
    );
    const token = (await tokenRes.json()) as { token: string };

    const res = await app.request("/api/logs/structured", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Logs-Browser-Token": token.token,
        Origin: "https://app.example",
      },
      body: JSON.stringify({
        level: 30,
        msg: "server spoof",
        hostname: "host-spoof",
      }),
    });
    expect(res.status).toBe(401);
  });
});

describe("production CORS policy", () => {
  it("allows local origins and rejects unconfigured remote origins by default", () => {
    expect(resolveCorsOrigin("http://localhost:5173")).toBe(
      "http://localhost:5173",
    );
    expect(resolveCorsOrigin("http://127.0.0.1:3000")).toBe(
      "http://127.0.0.1:3000",
    );
    expect(resolveCorsOrigin("https://evil.example")).toBe("");
  });

  it("allows explicit origins and wildcard configuration", () => {
    process.env.HASNA_LOGS_CORS_ORIGINS =
      "https://app.example, https://ops.example";
    expect(resolveCorsOrigin("https://app.example")).toBe(
      "https://app.example",
    );
    expect(resolveCorsOrigin("https://blocked.example")).toBe("");

    process.env.HASNA_LOGS_CORS_ORIGINS = "*";
    expect(resolveCorsOrigin("https://any.example")).toBe(
      "https://any.example",
    );
  });
});

describe("GET /api/logs", () => {
  it("lists logs", async () => {
    const { app, db } = buildApp();
    const { ingestBatch } = await import("../lib/ingest.ts");
    ingestBatch(db, [
      { level: "error", message: "e1" },
      { level: "info", message: "i1" },
    ]);
    const res = await app.request("/api/logs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body.length).toBeGreaterThanOrEqual(2);
  });

  it("filters by level", async () => {
    const { app, db } = buildApp();
    const { ingestBatch } = await import("../lib/ingest.ts");
    ingestBatch(db, [
      { level: "error", message: "e1" },
      { level: "info", message: "i1" },
    ]);
    const res = await app.request("/api/logs?level=error");
    const body = (await res.json()) as { level: string }[];
    expect(body.every((r) => r.level === "error")).toBe(true);
  });

  it("supports ?fields= projection", async () => {
    const { app, db } = buildApp();
    const { ingestLog } = await import("../lib/ingest.ts");
    ingestLog(db, { level: "info", message: "hello" });
    const res = await app.request("/api/logs?fields=level,message");
    const body = (await res.json()) as Record<string, unknown>[];
    const first = body[0];
    expect(first).toBeDefined();
    if (!first) throw new Error("expected projected log row");
    expect(Object.keys(first).sort()).toEqual(["level", "message"].sort());
  });
});

describe("GET /api/logs/tail", () => {
  it("returns recent logs", async () => {
    const { app, db } = buildApp();
    const { ingestBatch } = await import("../lib/ingest.ts");
    ingestBatch(
      db,
      Array.from({ length: 10 }, (_, i) => ({
        level: "info" as const,
        message: `m${i}`,
      })),
    );
    const res = await app.request("/api/logs/tail?n=5");
    const body = (await res.json()) as unknown[];
    expect(body).toHaveLength(5);
  });
});

describe("GET /api/logs/stream", () => {
  it("streams live ingested logs from the event bus", async () => {
    const { app, db } = buildApp();
    const controller = new AbortController();
    const res = await app.request("/api/logs/stream", {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);

    const waitForLog = readSseUntil(res, "live-stream-1");
    const { ingestLog } = await import("../lib/ingest.ts");
    ingestLog(db, {
      id: "live-stream-1",
      level: "error",
      message: "stream me",
    });
    const text = await waitForLog;
    controller.abort();

    expect(text).toContain("id: live-stream-1");
    expect(text).toContain("event: error");
    expect(text).toContain("stream me");
  });

  it("uses Last-Event-ID to catch up from SQLite", async () => {
    const { app, db } = buildApp();
    const { ingestLog } = await import("../lib/ingest.ts");
    const first = ingestLog(db, {
      id: "stream-catchup-1",
      level: "info",
      message: "first",
    });
    const second = ingestLog(db, {
      id: "stream-catchup-2",
      level: "warn",
      message: "second",
    });

    const controller = new AbortController();
    const res = await app.request("/api/logs/stream", {
      headers: { "Last-Event-ID": first.id },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const text = await readSseUntil(res, second.id);
    controller.abort();

    expect(text).toContain("id: stream-catchup-2");
    expect(text).toContain("event: warn");
    expect(text).toContain("second");
  });

  it("emits overflow when Last-Event-ID is unknown", async () => {
    const { app, db } = buildApp();
    const { ingestLog } = await import("../lib/ingest.ts");
    ingestLog(db, {
      id: "stream-known-latest",
      level: "info",
      message: "known latest",
    });
    const controller = new AbortController();
    const res = await app.request("/api/logs/stream", {
      headers: { "Last-Event-ID": "missing-log-id" },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const text = await readSseUntil(res, "last_event_id_unknown");
    controller.abort();

    expect(text).toContain("event: overflow");
    expect(text).toContain("last_event_id_unknown");
    expect(text).toContain('"last_event_id":"stream-known-latest"');
    expect(text).toContain('"requested_last_event_id":"missing-log-id"');
  });
});

describe("GET /api/events", () => {
  it("searches raw-backed event records and returns raw envelopes on request", async () => {
    const { app, db } = buildApp();
    const { ingestLog } = await import("../lib/ingest.ts");
    ingestLog(db, {
      id: "api-event-1",
      level: "error",
      source: "cli",
      message: "api event needle",
      machine_id: "api-machine",
      run_id: "api-run",
      trace_id: "api-trace",
      metadata: { area: "api-events" },
    });

    const res = await app.request(
      "/api/events?type=log&source=cli&severity=error&machine_id=api-machine&run_id=api-run&text=needle&include_raw=true",
    );
    expect(res.status).toBe(200);
    const rows = (await res.json()) as Array<{
      event_id: string;
      metadata: Record<string, unknown>;
      raw?: { event_id: string; body?: { log?: { message?: string } } };
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event_id).toBe("api-event-1");
    expect(rows[0]?.metadata).toEqual({ area: "api-events" });
    expect(rows[0]?.raw?.event_id).toBe("api-event-1");
    expect(rows[0]?.raw?.body?.log?.message).toBe("api event needle");

    const one = await app.request("/api/events/api-event-1");
    expect(one.status).toBe(200);
    const oneBody = (await one.json()) as { raw?: { event_id: string } };
    expect(oneBody.raw?.event_id).toBe("api-event-1");

    const missing = await app.request("/api/events/missing-event");
    expect(missing.status).toBe(404);
  });

  it("exports matching event records as JSON", async () => {
    const { app, db } = buildApp();
    const { ingestLog } = await import("../lib/ingest.ts");
    ingestLog(db, {
      id: "api-event-export-1",
      level: "info",
      message: "export me",
      trace_id: "api-export-trace",
    });

    const res = await app.request(
      "/api/events/export?trace_id=api-export-trace&include_raw=true",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      event_id: string;
      raw?: { trace_id?: string | null };
    }>;
    expect(body).toHaveLength(1);
    expect(body[0]?.event_id).toBe("api-event-export-1");
    expect(body[0]?.raw?.trace_id).toBe("api-export-trace");
  });
});

describe("GET /api/test-reports", () => {
  it("lists and reads projected test reports with bounded cases", async () => {
    const { app, db } = buildApp();
    const { ingestUniversalEvent } = await import("../lib/universal-ingest.ts");
    ingestUniversalEvent(db, {
      type: "build",
      event_id: "api-test-report-event",
      event_time: "2026-06-17T11:00:00.000Z",
      source: "test",
      severity: "error",
      run_id: "run-api-test-report",
      process_id: "proc-api-test-report",
      attributes: {
        category: "test_report",
        scanner: "api-test",
      },
      body: {
        test_report: {
          report_id: "report-api-test",
          path: "test-results/api.xml",
          parser: "junit-xml-v1",
          parse_status: "parsed",
          tests: 1,
          failures: 1,
          errors: 0,
          skipped: 0,
          suite_count: 1,
          testcase_count: 1,
          suites: [
            {
              name: "api suite",
              cases: [
                {
                  name: "fails over api",
                  classname: "api.Case",
                  status: "failed",
                },
              ],
            },
          ],
        },
      },
    });
    ingestUniversalEvent(db, {
      type: "build",
      event_id: "api-aggregate-failed-report-event",
      event_time: "2026-06-17T11:01:00.000Z",
      source: "test",
      severity: "error",
      run_id: "run-api-test-report",
      attributes: {
        category: "test_report",
      },
      body: {
        test_report: {
          report_id: "report-api-aggregate-failed",
          path: "test-results/api-aggregate.xml",
          parser: "external-junit",
          parse_status: "parsed",
          tests: 3,
          failures: 1,
          errors: 0,
          skipped: 0,
          testcase_count: 3,
        },
      },
    });

    const list = await app.request(
      "/api/test-reports?run_id=run-api-test-report&case_status=failed&include_cases=true",
    );
    expect(list.status).toBe(200);
    const reports = (await list.json()) as Array<{
      id: string;
      cases?: Array<{ name: string; status: string }>;
    }>;
    expect(reports).toHaveLength(1);
    expect(reports[0]?.id).toBe("report-api-test");
    expect(reports[0]?.cases).toEqual([
      expect.objectContaining({ name: "fails over api", status: "failed" }),
    ]);

    const one = await app.request("/api/test-reports/report-api-test");
    expect(one.status).toBe(200);
    const body = (await one.json()) as {
      id: string;
      event_id: string;
      cases?: unknown[];
    };
    expect(body).toMatchObject({
      id: "report-api-test",
      event_id: "api-test-report-event",
    });
    expect(body.cases).toHaveLength(1);

    const aggregate = await app.request(
      "/api/test-reports?run_id=run-api-test-report&outcome=failed&text=aggregate",
    );
    expect(aggregate.status).toBe(200);
    const aggregateReports = (await aggregate.json()) as Array<{
      id: string;
      failures: number;
      case_stored_count: number;
    }>;
    expect(aggregateReports).toEqual([
      expect.objectContaining({
        id: "report-api-aggregate-failed",
        failures: 1,
        case_stored_count: 0,
      }),
    ]);

    const missing = await app.request("/api/test-reports/missing-report");
    expect(missing.status).toBe(404);
  });
});

describe("GET /api/events/stream", () => {
  it("streams live non-log universal events from the event catalog bus", async () => {
    const { app } = buildApp();
    const controller = new AbortController();
    const res = await app.request(
      "/api/events/stream?type=span&trace_id=event-stream-trace&include_raw=true",
      { signal: controller.signal },
    );
    expect(res.status).toBe(200);

    const waitForEvent = readSseUntil(res, "event-stream-span-1");
    const post = await app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "span",
        event_id: "event-stream-span-1",
        source: "otel",
        severity: "info",
        trace_id: "event-stream-trace",
        span_id: "event-stream-span",
        message: "streamed universal span",
      }),
    });
    expect(post.status).toBe(201);
    const text = await waitForEvent;
    controller.abort();

    expect(text).toContain("id: event-stream-span-1");
    expect(text).toContain("event: span");
    expect(text).toContain("streamed universal span");
    expect(text).toContain('"raw"');
  });

  it("can stream catalog entries on one generic event channel", async () => {
    const { app } = buildApp();
    const controller = new AbortController();
    const res = await app.request(
      "/api/events/stream?type=span&trace_id=event-stream-generic-trace&event_name=event",
      { signal: controller.signal },
    );
    expect(res.status).toBe(200);

    const waitForEvent = readSseUntil(res, "event-stream-generic-span-1");
    const post = await app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "span",
        event_id: "event-stream-generic-span-1",
        source: "otel",
        severity: "info",
        trace_id: "event-stream-generic-trace",
        message: "generic event channel span",
      }),
    });
    expect(post.status).toBe(201);
    const text = await waitForEvent;
    controller.abort();

    expect(text).toContain("id: event-stream-generic-span-1");
    expect(text).toContain("event: event");
    expect(text).toContain('"event_type":"span"');
    expect(text).toContain("generic event channel span");
  });

  it("uses Last-Event-ID to catch up from event_records", async () => {
    const { app, db } = buildApp();
    const { ingestUniversalEvent } = await import("../lib/universal-ingest.ts");
    const first = ingestUniversalEvent(db, {
      type: "metric",
      event_id: "event-stream-catchup-1",
      source: "sdk",
      message: "first metric",
    });
    const second = ingestUniversalEvent(db, {
      type: "metric",
      event_id: "event-stream-catchup-2",
      source: "sdk",
      message: "second metric",
    });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(true);

    const controller = new AbortController();
    const res = await app.request("/api/events/stream?type=metric", {
      headers: { "Last-Event-ID": first.event.event_id },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const text = await readSseUntil(res, second.event.event_id);
    controller.abort();

    expect(text).toContain("id: event-stream-catchup-2");
    expect(text).toContain("event: metric");
    expect(text).toContain("second metric");
  });

  it("polls event_records for the first matching event when the stream starts empty", async () => {
    const { app, db } = buildApp();
    const controller = new AbortController();
    const res = await app.request(
      "/api/events/stream?type=metric&source=sqlite-only",
      { signal: controller.signal },
    );
    expect(res.status).toBe(200);
    const waitForEvent = readSseUntil(res, "event-stream-sqlite-only-1");

    const eventTime = new Date().toISOString();
    const envelope: TelemetryEnvelope = {
      schema_version: 1,
      event_id: "event-stream-sqlite-only-1",
      source_event_id: null,
      event_time: eventTime,
      ingest_time: eventTime,
      type: "metric",
      source: "sqlite-only",
      severity: "info",
      privacy: "internal",
      message: "sqlite only metric",
      body: { value: 1 },
      attributes: {},
    };
    const write = appendRawEvent(db, envelope);
    indexRawEvent(
      db,
      {
        event_id: envelope.event_id,
        schema_version: envelope.schema_version,
        source_event_id: envelope.source_event_id,
        event_type: envelope.type,
        event_time: envelope.event_time,
        ingest_time: envelope.ingest_time,
        severity: envelope.severity,
        source: envelope.source,
        privacy_tier: envelope.privacy,
        message: envelope.message,
        metadata: {},
      },
      write,
    );

    const text = await waitForEvent;
    controller.abort();

    expect(text).toContain("id: event-stream-sqlite-only-1");
    expect(text).toContain("event: metric");
    expect(text).toContain("sqlite only metric");
  });

  it("catches up SQLite-only records before emitting a later bus event", async () => {
    const { app, db } = buildApp();
    const controller = new AbortController();
    const res = await app.request("/api/events/stream?type=metric", {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const waitForBusEvent = readSseUntil(res, "event-stream-live-after-sqlite");

    const eventTime = new Date().toISOString();
    const envelope: TelemetryEnvelope = {
      schema_version: 1,
      event_id: "event-stream-sqlite-before-bus",
      source_event_id: null,
      event_time: eventTime,
      ingest_time: eventTime,
      type: "metric",
      source: "sqlite-only",
      severity: "info",
      privacy: "internal",
      message: "sqlite event before bus",
      body: { value: 1 },
      attributes: {},
    };
    const write = appendRawEvent(db, envelope);
    indexRawEvent(
      db,
      {
        event_id: envelope.event_id,
        schema_version: envelope.schema_version,
        source_event_id: envelope.source_event_id,
        event_type: envelope.type,
        event_time: envelope.event_time,
        ingest_time: envelope.ingest_time,
        severity: envelope.severity,
        source: envelope.source,
        privacy_tier: envelope.privacy,
        message: envelope.message,
        metadata: {},
      },
      write,
    );

    const post = await app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "metric",
        event_id: "event-stream-live-after-sqlite",
        source: "sdk",
        severity: "info",
        message: "live bus metric after sqlite",
      }),
    });
    expect(post.status).toBe(201);

    const text = await waitForBusEvent;
    controller.abort();

    expect(text).toContain("id: event-stream-sqlite-before-bus");
    expect(text).toContain("id: event-stream-live-after-sqlite");
    expect(text.indexOf("event-stream-sqlite-before-bus")).toBeLessThan(
      text.indexOf("event-stream-live-after-sqlite"),
    );
  });

  it("emits slow-subscriber overflow while catching up from event_records", async () => {
    process.env.HASNA_LOGS_STREAM_TEST_HOOKS = "1";
    const { app } = buildApp();
    const ids = Array.from(
      { length: 8 },
      (_, index) => `event-stream-overflow-${index}`,
    );
    const controller = new AbortController();
    const res = await app.request(
      "/api/events/stream?type=metric&event_name=event&debug_subscriber_queue=1&debug_write_delay_ms=10",
      { signal: controller.signal },
    );
    expect(res.status).toBe(200);
    const waitForOverflow = readSseUntil(res, "subscriber_queue_overflow");

    const post = await app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        events: ids.map((eventId, index) => ({
          type: "metric",
          event_id: eventId,
          source: "sdk",
          severity: "info",
          message: `slow subscriber metric ${index}`,
        })),
      }),
    });
    expect(post.status).toBe(201);

    const text = await waitForOverflow;
    controller.abort();

    expect(text).toContain("event: overflow");
    expect(text).toContain("subscriber_queue_overflow");
    for (const id of ids) {
      expect(text).toContain(`id: ${id}`);
    }
  });

  it("streams log events through the event catalog stream", async () => {
    const { app, db } = buildApp();
    const controller = new AbortController();
    const res = await app.request("/api/events/stream?type=log&source=sdk", {
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const waitForEvent = readSseUntil(res, "event-stream-log-1");
    const { ingestLog } = await import("../lib/ingest.ts");
    ingestLog(db, {
      id: "event-stream-log-1",
      level: "warn",
      source: "sdk",
      message: "catalog log stream",
    });

    const text = await waitForEvent;
    controller.abort();

    expect(text).toContain("id: event-stream-log-1");
    expect(text).toContain("event: log");
    expect(text).toContain("catalog log stream");
  });

  it("streams process lifecycle events from logs run capture", async () => {
    const { app, db } = buildApp();
    const controller = new AbortController();
    const res = await app.request(
      "/api/events/stream?type=process&source=cli",
      { signal: controller.signal },
    );
    expect(res.status).toBe(200);
    const waitForEvent = readSseUntil(res, "Process started");
    const { runCommand } = await import("../lib/command-runner.ts");
    await runCommand(db, [process.execPath, "-e", ""], {
      tee: false,
      environment: "test",
    });

    const text = await waitForEvent;
    controller.abort();

    expect(text).toContain("event: process");
    expect(text).toContain("Process started");
  });

  it("emits overflow when event Last-Event-ID is unknown", async () => {
    const { app, db } = buildApp();
    const { ingestUniversalEvent } = await import("../lib/universal-ingest.ts");
    ingestUniversalEvent(db, {
      type: "metric",
      event_id: "event-stream-known-latest",
      source: "sdk",
      message: "known latest metric",
    });
    const controller = new AbortController();
    const res = await app.request("/api/events/stream", {
      headers: { "Last-Event-ID": "missing-event-id" },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    const text = await readSseUntil(res, "last_event_id_unknown");
    controller.abort();

    expect(text).toContain("event: overflow");
    expect(text).toContain("last_event_id_unknown");
    expect(text).toContain('"last_event_id":"event-stream-known-latest"');
    expect(text).toContain('"requested_last_event_id":"missing-event-id"');
  });
});

describe("POST /api/events", () => {
  it("ingests non-log universal telemetry events with raw reconstruction and projections", async () => {
    const { app, db } = buildApp();
    const secret = "OPENLOGS_SECRET_CANARY_api_events_67890";
    const res = await app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "span",
        event_id: "api-universal-span-1",
        source_event_id: "producer-api-span-1",
        event_time: "2026-06-16T08:30:00.000Z",
        source: "otel",
        severity: "info",
        message: `span secret ${secret}`,
        trace_id: "api-universal-trace",
        span_id: "api-universal-span",
        process_id: "api-universal-process",
        run_id: "api-universal-run",
        body: { Authorization: `Bearer ${secret}` },
        attributes: {
          name: "GET /api/events",
          operation: "http.server",
          duration_ms: 12,
          token: secret,
        },
      }),
    });

    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      event_id: string;
      event_type: string;
      trace_id: string;
    };
    expect(created).toMatchObject({
      event_id: "api-universal-span-1",
      event_type: "span",
      trace_id: "api-universal-trace",
    });

    const raw = readRawEvent(db, "api-universal-span-1");
    expect(JSON.stringify(raw)).not.toContain(secret);
    expect(JSON.stringify(raw)).toContain("[REDACTED]");

    const span = db
      .prepare("SELECT id, trace_id, duration_ms FROM spans WHERE id = ?")
      .get("api-universal-span") as {
      id: string;
      trace_id: string;
      duration_ms: number;
    } | null;
    expect(span).toEqual({
      id: "api-universal-span",
      trace_id: "api-universal-trace",
      duration_ms: 12,
    });

    const listed = await app.request(
      "/api/events?type=span&trace_id=api-universal-trace&include_raw=true",
    );
    const rows = (await listed.json()) as Array<{
      event_id: string;
      raw?: { message?: string | null };
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.raw?.message).toContain("[REDACTED]");
  });

  it("ingests event batches and deduplicates retried producer IDs", async () => {
    const { app } = buildApp();
    const body = {
      events: [
        {
          type: "metric",
          event_id: "api-universal-metric-1",
          source: "sdk",
          message: "metric one",
          body: { value: 1 },
        },
        {
          type: "exception",
          event_id: "api-universal-exception-1",
          source: "node",
          severity: "error",
          message: "exception one",
        },
      ],
    };

    const first = await app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({ inserted: 2 });

    const second = await app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(second.status).toBe(201);
    expect(await second.json()).toMatchObject({ inserted: 0 });

    const oneItemBatch = await app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        {
          type: "metric",
          event_id: "api-universal-metric-single-batch",
          source: "sdk",
          message: "one item batch",
        },
      ]),
    });
    expect(oneItemBatch.status).toBe(201);
    expect(await oneItemBatch.json()).toMatchObject({
      inserted: 1,
      events: [{ event_id: "api-universal-metric-single-batch" }],
    });
  });

  it("rejects malformed universal event payloads before persistence", async () => {
    const { app, db } = buildApp();
    const nonJson = await app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "type=metric",
    });
    expect(nonJson.status).toBe(415);

    const invalidJson = await app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad",
    });
    expect(invalidJson.status).toBe(400);

    const unknown = await app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "metric", token: "not allowed" }),
    });
    expect(unknown.status).toBe(422);

    const badType = await app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "unknown", message: "bad" }),
    });
    expect(badType.status).toBe(422);

    const invalidBatch = await app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { type: "metric", message: "valid first" },
        { type: "metric", event_time: "not-a-date", message: "invalid second" },
      ]),
    });
    expect(invalidBatch.status).toBe(422);

    process.env.HASNA_LOGS_MAX_EVENT_BATCH_SIZE = "1";
    const oversizedBatch = await app.request("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([
        { type: "metric", message: "a" },
        { type: "metric", message: "b" },
      ]),
    });
    expect(oversizedBatch.status).toBe(413);

    const count = db
      .prepare(
        "SELECT COUNT(*) AS count FROM event_records WHERE event_type != 'log'",
      )
      .get() as { count: number };
    expect(count.count).toBe(0);
  });
});

describe("POST /api/otel", () => {
  it("ingests OTLP traces through the server route into the event catalog", async () => {
    const { app, db } = buildApp();
    const res = await app.request("/api/otel/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resourceSpans: [
          {
            resource: {
              attributes: [
                { key: "service.name", value: { stringValue: "api-server" } },
              ],
            },
            scopeSpans: [
              {
                scope: { name: "server-test" },
                spans: [
                  {
                    traceId: "cccccccccccccccccccccccccccccccc",
                    spanId: "dddddddddddddddd",
                    name: "GET /api/otel",
                    startTimeUnixNano: serverTestUnixNano(
                      "2026-06-16T08:10:00.000Z",
                    ),
                    endTimeUnixNano: serverTestUnixNano(
                      "2026-06-16T08:10:00.010Z",
                    ),
                    attributes: [
                      {
                        key: "http.route",
                        value: { stringValue: "/api/otel" },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      partialSuccess: {},
      signal: "traces",
      accepted: 1,
      inserted: 1,
      events: [
        {
          event_type: "span",
          source: "otel",
          trace_id: "cccccccccccccccccccccccccccccccc",
          span_id: "dddddddddddddddd",
        },
      ],
    });

    const row = db
      .prepare(
        "SELECT event_type, source, app_id, trace_id, span_id FROM event_records WHERE trace_id = ?",
      )
      .get("cccccccccccccccccccccccccccccccc") as {
      event_type: string;
      source: string;
      app_id: string;
      trace_id: string;
      span_id: string;
    } | null;
    expect(row).toEqual({
      event_type: "span",
      source: "otel",
      app_id: "api-server",
      trace_id: "cccccccccccccccccccccccccccccccc",
      span_id: "dddddddddddddddd",
    });

    const listed = await app.request(
      "/api/events?type=span&source=otel&trace_id=cccccccccccccccccccccccccccccccc&include_raw=true",
    );
    expect(listed.status).toBe(200);
    const events = (await listed.json()) as Array<{
      event_id: string;
      raw?: { attributes?: Record<string, unknown> };
    }>;
    expect(events).toHaveLength(1);
    expect(events[0]?.raw?.attributes?.resource).toMatchObject({
      "service.name": "api-server",
    });
  });

  it("ingests OTLP logs and metrics through server routes", async () => {
    const { app } = buildApp();
    const logs = await app.request("/api/otel/v1/logs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resourceLogs: [
          {
            resource: {
              attributes: [
                { key: "service.name", value: { stringValue: "job-runner" } },
              ],
            },
            scopeLogs: [
              {
                scope: { name: "logger" },
                logRecords: [
                  {
                    timeUnixNano: serverTestUnixNano(
                      "2026-06-16T08:11:00.000Z",
                    ),
                    severityNumber: 13,
                    severityText: "WARN",
                    body: { stringValue: "queued task slow" },
                  },
                ],
              },
            ],
          },
        ],
      }),
    });
    expect(logs.status).toBe(200);
    expect(await logs.json()).toMatchObject({
      signal: "logs",
      accepted: 1,
      inserted: 1,
      events: [{ event_type: "log", source: "otel" }],
    });

    const metrics = await app.request("/api/otel/v1/metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resourceMetrics: [
          {
            resource: {
              attributes: [
                { key: "service.name", value: { stringValue: "job-runner" } },
              ],
            },
            scopeMetrics: [
              {
                scope: { name: "runtime" },
                metrics: [
                  {
                    name: "jobs.active",
                    gauge: {
                      dataPoints: [
                        {
                          timeUnixNano: serverTestUnixNano(
                            "2026-06-16T08:11:01.000Z",
                          ),
                          asInt: "7",
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    });
    expect(metrics.status).toBe(200);
    expect(await metrics.json()).toMatchObject({
      signal: "metrics",
      accepted: 1,
      inserted: 1,
      events: [{ event_type: "metric", source: "otel" }],
    });
  });

  it("rejects malformed OTLP payloads and browser-token writes", async () => {
    const { app } = buildApp();
    const nonJson = await app.request("/api/otel/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "bad",
    });
    expect(nonJson.status).toBe(415);

    const wrongShape = await app.request("/api/otel/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resourceLogs: [] }),
    });
    expect(wrongShape.status).toBe(422);
    expect(await wrongShape.json()).toEqual({
      error: "payload.resourceSpans must be an array",
    });

    const malformedNested = await app.request("/api/otel/v1/traces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resourceSpans: [{ scopeSpans: "not-array" }] }),
    });
    expect(malformedNested.status).toBe(422);
    expect(await malformedNested.json()).toEqual({
      error: "payload.resourceSpans[].scopeSpans must be an array",
    });

    const pRes = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "otlp-browser-token-block" }),
    });
    const project = (await pRes.json()) as { id: string };
    const tokenRes = await app.request(
      `/api/projects/${project.id}/browser-tokens`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "browser" }),
      },
    );
    const token = (await tokenRes.json()) as { token: string };

    const browserWrite = await app.request("/api/otel/v1/logs", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Logs-Browser-Token": token.token,
      },
      body: JSON.stringify({ resourceLogs: [] }),
    });
    expect(browserWrite.status).toBe(403);
    expect(await browserWrite.json()).toEqual({
      error: "Browser ingest tokens cannot write OTLP telemetry",
    });
  });
});

describe("GET /api/logs/summary", () => {
  it("returns summary of errors/warns", async () => {
    const { app, db } = buildApp();
    const { ingestBatch } = await import("../lib/ingest.ts");
    ingestBatch(db, [
      { level: "error", message: "x", service: "api" },
      { level: "warn", message: "y", service: "db" },
    ]);
    const res = await app.request("/api/logs/summary");
    const body = (await res.json()) as unknown[];
    expect(body.length).toBeGreaterThan(0);
  });
});

describe("GET /api/logs/:trace_id/context", () => {
  it("returns logs for trace", async () => {
    const { app, db } = buildApp();
    const { ingestBatch } = await import("../lib/ingest.ts");
    ingestBatch(db, [
      { level: "info", message: "a", trace_id: "t99" },
      { level: "error", message: "b", trace_id: "t99" },
    ]);
    const res = await app.request("/api/logs/t99/context");
    const body = (await res.json()) as unknown[];
    expect(body).toHaveLength(2);
  });
});

describe("POST /api/projects", () => {
  it("creates a project", async () => {
    const { app } = buildApp();
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "myapp" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe("myapp");
  });

  it("returns 422 without name", async () => {
    const { app } = buildApp();
    const res = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it("rejects malformed, unknown, and oversized project create payloads before mutation", async () => {
    const { app, db } = buildApp();
    const nonJson = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "name=x",
    });
    expect(nonJson.status).toBe(415);

    const unknown = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", token: "not allowed" }),
    });
    expect(unknown.status).toBe(422);

    process.env.HASNA_LOGS_MAX_PAYLOAD_BYTES = "64";
    const oversized = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(128) }),
    });
    expect(oversized.status).toBe(413);

    const count = db
      .prepare("SELECT COUNT(*) AS count FROM projects")
      .get() as { count: number };
    expect(count.count).toBe(0);
  });
});

describe("GET /api/projects", () => {
  it("lists projects", async () => {
    const { app } = buildApp();
    await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "p1" }),
    });
    const res = await app.request("/api/projects");
    const body = (await res.json()) as unknown[];
    expect(body.length).toBeGreaterThanOrEqual(1);
  });
});

describe("POST /api/projects/:id/pages", () => {
  it("registers a page", async () => {
    const { app } = buildApp();
    const pRes = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "app" }),
    });
    const project = (await pRes.json()) as { id: string };
    const res = await app.request(`/api/projects/${project.id}/pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://app.com/home" }),
    });
    expect(res.status).toBe(201);
    const page = (await res.json()) as { url: string };
    expect(page.url).toBe("https://app.com/home");
  });

  it("returns 422 without url", async () => {
    const { app } = buildApp();
    const pRes = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "app2" }),
    });
    const project = (await pRes.json()) as { id: string };
    const res = await app.request(`/api/projects/${project.id}/pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it("rejects invalid page URLs before mutation", async () => {
    const { app, db } = buildApp();
    const pRes = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "page-validation" }),
    });
    const project = (await pRes.json()) as { id: string };
    const res = await app.request(`/api/projects/${project.id}/pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "not-a-url" }),
    });
    expect(res.status).toBe(422);
    const count = db
      .prepare("SELECT COUNT(*) AS count FROM pages WHERE project_id = ?")
      .get(project.id) as { count: number };
    expect(count.count).toBe(0);
  });

  it("validates retention and page-auth mutation payloads", async () => {
    const { app, db } = buildApp();
    const pRes = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "admin-validation" }),
    });
    const project = (await pRes.json()) as { id: string };
    const pageRes = await app.request(`/api/projects/${project.id}/pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://app.example/admin" }),
    });
    const page = (await pageRes.json()) as { id: string };

    const badRetention = await app.request(
      `/api/projects/${project.id}/retention`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_rows: "many" }),
      },
    );
    expect(badRetention.status).toBe(422);

    const goodRetention = await app.request(
      `/api/projects/${project.id}/retention`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ max_rows: 100, error_ttl_hours: 24 }),
      },
    );
    expect(goodRetention.status).toBe(200);

    const badAuthType = await app.request(
      `/api/projects/${project.id}/pages/${page.id}/auth`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "apikey", credentials: "secret" }),
      },
    );
    expect(badAuthType.status).toBe(422);

    const badAuthShape = await app.request(
      `/api/projects/${project.id}/pages/${page.id}/auth`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "bearer",
          credentials: { token: "secret" },
        }),
      },
    );
    expect(badAuthShape.status).toBe(422);

    const noAuthRows = db
      .prepare("SELECT COUNT(*) AS count FROM page_auth WHERE page_id = ?")
      .get(page.id) as { count: number };
    expect(noAuthRows.count).toBe(0);

    process.env.HASNA_LOGS_SECRET_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const goodAuth = await app.request(
      `/api/projects/${project.id}/pages/${page.id}/auth`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "bearer", credentials: "secret" }),
      },
    );
    expect(goodAuth.status).toBe(201);
  });
});

describe("jobs routes", () => {
  it("creates and lists jobs", async () => {
    const { app } = buildApp();
    const pRes = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "appj" }),
    });
    const { id } = (await pRes.json()) as { id: string };
    const jRes = await app.request("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: id, schedule: "*/5 * * * *" }),
    });
    expect(jRes.status).toBe(201);
    const listRes = await app.request(`/api/jobs?project_id=${id}`);
    const jobs = (await listRes.json()) as unknown[];
    expect(jobs).toHaveLength(1);
  });

  it("returns 422 without required fields", async () => {
    const { app } = buildApp();
    const res = await app.request("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it("rejects invalid job create and update payloads before mutation", async () => {
    const { app, db } = buildApp();
    const pRes = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "job-validation" }),
    });
    const { id } = (await pRes.json()) as { id: string };

    const unknown = await app.request("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: id,
        schedule: "* * * * *",
        token: "bad",
      }),
    });
    expect(unknown.status).toBe(422);

    const good = await app.request("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: id, schedule: "* * * * *" }),
    });
    expect(good.status).toBe(201);
    const job = (await good.json()) as { id: string };

    const badUpdate = await app.request(`/api/jobs/${job.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(badUpdate.status).toBe(422);

    const row = db
      .prepare("SELECT enabled FROM scan_jobs WHERE id = ?")
      .get(job.id) as { enabled: number };
    expect(row.enabled).toBe(1);
  });

  it("deletes a job", async () => {
    const { app } = buildApp();
    const pRes = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "appd" }),
    });
    const { id } = (await pRes.json()) as { id: string };
    const jRes = await app.request("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_id: id, schedule: "*/5 * * * *" }),
    });
    const job = (await jRes.json()) as { id: string };
    const del = await app.request(`/api/jobs/${job.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
  });
});

describe("alerts and issues route validation", () => {
  it("rejects invalid alert mutation payloads before mutation", async () => {
    const { app, db } = buildApp();
    const pRes = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "alert-validation" }),
    });
    const project = (await pRes.json()) as { id: string };

    const badLevel = await app.request("/api/alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: project.id,
        name: "bad",
        level: "verbose",
      }),
    });
    expect(badLevel.status).toBe(422);

    const badUrl = await app.request("/api/alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: project.id,
        name: "bad-url",
        webhook_url: "not-a-url",
      }),
    });
    expect(badUrl.status).toBe(422);

    const good = await app.request("/api/alerts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        project_id: project.id,
        name: "errors",
        threshold_count: 2,
        window_seconds: 30,
        action: "log",
      }),
    });
    expect(good.status).toBe(201);
    const alert = (await good.json()) as { id: string };

    const badUpdate = await app.request(`/api/alerts/${alert.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(badUpdate.status).toBe(422);

    const count = db
      .prepare("SELECT COUNT(*) AS count FROM alert_rules")
      .get() as { count: number };
    expect(count.count).toBe(1);
  });

  it("rejects invalid issue update payloads", async () => {
    const { app, db } = buildApp();
    const { upsertIssue } = await import("../lib/issues.ts");
    const issue = upsertIssue(db, { level: "error", message: "boom" });

    const badUnknown = await app.request(`/api/issues/${issue.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "resolved", extra: true }),
    });
    expect(badUnknown.status).toBe(422);

    const badStatus = await app.request(`/api/issues/${issue.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "closed" }),
    });
    expect(badStatus.status).toBe(422);

    const good = await app.request(`/api/issues/${issue.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "resolved" }),
    });
    expect(good.status).toBe(200);
  });
});

describe("perf routes", () => {
  it("returns 422 without project_id", async () => {
    const { app } = buildApp();
    const res = await app.request("/api/perf");
    expect(res.status).toBe(422);
  });

  it("returns null when no snapshot exists", async () => {
    const { app } = buildApp();
    const pRes = await app.request("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "perf-app" }),
    });
    const { id } = (await pRes.json()) as { id: string };
    const res = await app.request(`/api/perf?project_id=${id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toBeNull();
  });
});

function serverTestUnixNano(iso: string): string {
  return String(BigInt(new Date(iso).getTime()) * 1_000_000n);
}
