import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LogsClient,
  captureNodeHttpRequest,
  createExpressErrorTelemetryMiddleware,
  createExpressTelemetryMiddleware,
  createFastifyTelemetryHooks,
  createHonoTelemetryMiddleware,
  createPinoOpenLogsTransport,
  createWinstonOpenLogsTransport,
  initNodeLogs,
  initUniversalLogs,
  instrumentFetchHandler,
} from "../../sdk/src/index.ts";

const originalFetch = globalThis.fetch;
const originalSetInterval = globalThis.setInterval;
const originalConsoleWarn = console.warn;
const originalConsoleError = console.error;
const originalConsoleDebug = console.debug;
const originalConsoleInfo = console.info;
const originalConsoleLog = console.log;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalLocation = Object.getOwnPropertyDescriptor(
  globalThis,
  "location",
);
const originalHistory = Object.getOwnPropertyDescriptor(globalThis, "history");
const originalPerformance = Object.getOwnPropertyDescriptor(
  globalThis,
  "performance",
);
const originalPerformanceObserver = Object.getOwnPropertyDescriptor(
  globalThis,
  "PerformanceObserver",
);
const originalLocalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setInterval = originalSetInterval;
  console.debug = originalConsoleDebug;
  console.info = originalConsoleInfo;
  console.log = originalConsoleLog;
  console.warn = originalConsoleWarn;
  console.error = originalConsoleError;
  restoreGlobal("window", originalWindow);
  restoreGlobal("location", originalLocation);
  restoreGlobal("history", originalHistory);
  restoreGlobal("performance", originalPerformance);
  restoreGlobal("PerformanceObserver", originalPerformanceObserver);
  restoreGlobal("localStorage", originalLocalStorage);
});

describe("LogsClient universal event methods", () => {
  it("pushes universal events with browser token headers and omits browser-forbidden identity context", async () => {
    const requests = mockFetch();
    const client = new LogsClient({
      url: "http://collector.test/",
      projectId: "project-1",
      browserToken: "browser-token-1",
      source: "browser",
      environment: "development",
      releaseId: "release-1",
      appId: "app-1",
      sessionId: "session-1",
    });

    await client.pushEvent({
      type: "metric",
      message: "queue.depth",
      project_id: "spoofed-project",
      machine_id: "spoofed-machine",
      attributes: {
        name: "queue.depth",
        project_id: "spoofed-project",
        machine_id: "spoofed-machine",
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://collector.test/api/events");
    expect(requests[0]?.headers["X-Logs-Browser-Token"]).toBe(
      "browser-token-1",
    );
    expect(requests[0]?.body).toMatchObject({
      type: "metric",
      source: "browser",
      environment: "development",
      release_id: "release-1",
      session_id: "session-1",
      attributes: {
        name: "queue.depth",
        sdk_name: "@hasna/logs-sdk",
      },
    });
    expect(JSON.stringify(requests[0]?.body)).not.toContain("spoofed-project");
    expect(JSON.stringify(requests[0]?.body)).not.toContain("spoofed-machine");
    expect(requests[0]?.body).not.toHaveProperty("project_id");
    expect(requests[0]?.body).not.toHaveProperty("machine_id");
    expect(requests[0]?.body).not.toHaveProperty("app_id");
  });

  it("pushes one-item batches as batch payloads", async () => {
    const requests = mockFetch({
      response: { inserted: 1, events: [{ event_id: "evt-batch-1" }] },
    });
    const client = new LogsClient({
      url: "http://collector.test",
      projectId: "project-1",
    });

    await client.pushEvents([
      {
        type: "metric",
        event_id: "evt-batch-1",
        message: "single batch metric",
      },
    ]);

    expect(Array.isArray(requests[0]?.body)).toBe(true);
    expect(requests[0]?.body).toMatchObject([
      { type: "metric", event_id: "evt-batch-1", project_id: "project-1" },
    ]);
  });

  it("pushes structured logs through the server-side structured ingest route", async () => {
    const requests = mockFetch({
      response: {
        inserted: 1,
        events: [
          {
            id: "log-structured-1",
            source: "pino",
            level: "info",
            message: "structured sdk log",
          },
        ],
      },
    });
    const client = new LogsClient({
      url: "http://collector.test/",
      projectId: "project-structured",
      apiKey: "api-key",
      browserToken: "browser-token-should-not-be-sent",
      machineId: "machine-1",
      repoId: "repo-1",
      appId: "app-1",
      processId: "process-1",
      runId: "run-1",
      environment: "test",
      releaseId: "release-1",
    });

    const result = await client.pushStructuredLog(
      {
        level: 30,
        msg: "structured sdk log",
        time: 1781596800000,
        traceId: "trace-structured-sdk",
      },
      { format: "pino", service: "api" },
    );

    expect(result.inserted).toBe(1);
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]?.url ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(
      "http://collector.test/api/logs/structured",
    );
    expect(url.searchParams.get("format")).toBe("pino");
    expect(url.searchParams.get("service")).toBe("api");
    expect(url.searchParams.get("project_id")).toBe("project-structured");
    expect(url.searchParams.get("machine_id")).toBe("machine-1");
    expect(url.searchParams.get("repo_id")).toBe("repo-1");
    expect(url.searchParams.get("app_id")).toBe("app-1");
    expect(url.searchParams.get("process_id")).toBe("process-1");
    expect(url.searchParams.get("run_id")).toBe("run-1");
    expect(url.searchParams.get("environment")).toBe("test");
    expect(url.searchParams.get("release_id")).toBe("release-1");
    expect(requests[0]?.headers.Authorization).toBe("Bearer api-key");
    expect(requests[0]?.headers["X-Logs-Browser-Token"]).toBeUndefined();
    expect(requests[0]?.body).toMatchObject({
      level: 30,
      msg: "structured sdk log",
      traceId: "trace-structured-sdk",
    });
  });

  it("creates a Pino-compatible structured transport that batches JSON lines", async () => {
    const requests = mockFetch({
      response: { inserted: 2, events: [{ id: "log-pino-1" }] },
    });
    const transport = createPinoOpenLogsTransport({
      url: "http://collector.test",
      projectId: "project-pino",
      apiKey: "api-key",
      service: "api",
      environment: "test",
      maxBatchSize: 10,
      flushIntervalMs: 60_000,
      sourceEventPrefix: "pino-test",
    });

    let callbackCalled = false;
    transport.write(
      `${JSON.stringify({ level: 30, msg: "pino one", name: "api" })}\n${JSON.stringify({ level: 50, msg: "pino two", traceId: "trace-pino-transport" })}\n`,
      () => {
        callbackCalled = true;
      },
    );
    await transport.flush();
    transport.stop();

    expect(callbackCalled).toBe(true);
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]?.url ?? "");
    expect(`${url.origin}${url.pathname}`).toBe(
      "http://collector.test/api/logs/structured",
    );
    expect(url.searchParams.get("format")).toBe("pino");
    expect(url.searchParams.get("project_id")).toBe("project-pino");
    expect(url.searchParams.get("service")).toBe("api");
    expect(requests[0]?.headers.Authorization).toBe("Bearer api-key");
    expect(requests[0]?.body).toMatchObject({
      logs: [
        { level: 30, msg: "pino one", name: "api" },
        { level: 50, msg: "pino two", traceId: "trace-pino-transport" },
      ],
    });
    expect(
      (requests[0]?.body as { source_event_prefix?: string })
        .source_event_prefix,
    ).toContain("pino-test:");
  });

  it("flushes queued Pino transport records on stop", async () => {
    const requests = mockFetch({
      response: { inserted: 1, events: [{ id: "log-pino-stop-1" }] },
    });
    const transport = createPinoOpenLogsTransport({
      url: "http://collector.test",
      projectId: "project-pino",
      maxBatchSize: 10,
      flushIntervalMs: 60_000,
    });

    transport.write(`${JSON.stringify({ level: 30, msg: "pino stop" })}\n`);
    transport.stop();
    await waitForRequestCount(requests, 1);

    expect(requests[0]?.body).toMatchObject({
      logs: [{ level: 30, msg: "pino stop" }],
    });
  });

  it("retries failed structured transport batches without changing their source prefix", async () => {
    const retries: Array<{ attempts: number; pending: number }> = [];
    const drops: unknown[] = [];
    const requests = mockFetch({
      statuses: [503, 201],
      responses: [
        { error: "collector unavailable" },
        { inserted: 1, events: [{ id: "log-pino-retry-1" }] },
      ],
    });
    const transport = createPinoOpenLogsTransport({
      url: "http://collector.test",
      projectId: "project-pino",
      maxBatchSize: 10,
      maxRetries: 1,
      retryBaseDelayMs: 0,
      flushIntervalMs: 60_000,
      onRetry: (event) => {
        retries.push({ attempts: event.attempts, pending: event.pending });
      },
      onDrop: (event) => {
        drops.push(event);
      },
    });

    transport.write(`${JSON.stringify({ level: 30, msg: "retry me" })}\n`);
    await transport.flush();
    transport.stop();

    expect(requests).toHaveLength(2);
    expect(requests[0]?.body).toMatchObject({
      logs: [{ level: 30, msg: "retry me" }],
    });
    expect(requests[1]?.body).toMatchObject({
      logs: [{ level: 30, msg: "retry me" }],
    });
    expect(
      (requests[1]?.body as { source_event_prefix?: string })
        .source_event_prefix,
    ).toBe(
      (requests[0]?.body as { source_event_prefix?: string })
        .source_event_prefix,
    );
    expect(retries).toEqual([{ attempts: 1, pending: 1 }]);
    expect(drops).toHaveLength(0);
    expect(transport.stats()).toMatchObject({
      pending: 0,
      sent: 1,
      dropped: 0,
      retries: 1,
      failed_batches: 1,
    });
  });

  it("drops structured transport batches only after configured retries are exhausted", async () => {
    const drops: Array<{ reason: string; attempts: number; record: unknown }> =
      [];
    const errors: unknown[] = [];
    const requests = mockFetch({
      statuses: [503, 503],
      response: { error: "still unavailable" },
    });
    const transport = createPinoOpenLogsTransport({
      url: "http://collector.test",
      projectId: "project-pino",
      maxBatchSize: 10,
      maxRetries: 1,
      retryBaseDelayMs: 0,
      flushIntervalMs: 60_000,
      onError: (error) => {
        errors.push(error);
      },
      onDrop: (event) => {
        drops.push({
          reason: event.reason,
          attempts: event.attempts,
          record: event.record,
        });
      },
    });

    transport.write(
      `${JSON.stringify({ level: 30, msg: "drop after retry" })}\n`,
    );

    await expect(transport.flush()).rejects.toThrow("still unavailable");
    transport.stop();

    expect(requests).toHaveLength(2);
    expect(drops).toHaveLength(1);
    expect(drops[0]).toMatchObject({
      reason: "retries_exhausted",
      attempts: 2,
      record: { level: 30, msg: "drop after retry" },
    });
    expect(errors).toHaveLength(1);
    expect(transport.stats()).toMatchObject({
      pending: 0,
      sent: 0,
      dropped: 1,
      retries: 1,
      failed_batches: 2,
    });
  });

  it("bounds structured transport memory and reports queue-full drops", async () => {
    const drops: Array<{ reason: string; record: unknown }> = [];
    const requests = mockFetch({
      response: { inserted: 2, events: [{ id: "log-pino-queue-1" }] },
    });
    const transport = createPinoOpenLogsTransport({
      url: "http://collector.test",
      projectId: "project-pino",
      maxBatchSize: 10,
      maxQueueSize: 2,
      flushIntervalMs: 60_000,
      onDrop: (event) => {
        drops.push({ reason: event.reason, record: event.record });
      },
    });

    transport.write(`${JSON.stringify({ level: 30, msg: "queue one" })}\n`);
    transport.write(`${JSON.stringify({ level: 30, msg: "queue two" })}\n`);
    transport.write(`${JSON.stringify({ level: 30, msg: "queue three" })}\n`);

    expect(transport.stats()).toMatchObject({
      pending: 2,
      dropped: 1,
      max_queue_size: 2,
    });
    expect(drops).toEqual([
      {
        reason: "queue_full",
        record: { level: 30, msg: "queue one" },
      },
    ]);

    await transport.flush();
    transport.stop();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({
      logs: [
        { level: 30, msg: "queue two" },
        { level: 30, msg: "queue three" },
      ],
    });
    expect(transport.stats()).toMatchObject({
      pending: 0,
      sent: 2,
      dropped: 1,
    });
  });

  it("does not drop the in-flight structured transport batch under queue pressure", async () => {
    const requests: MockRequest[] = [];
    let releaseResponse: (() => void) | undefined;
    const drops: Array<{ reason: string; record: unknown }> = [];
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body ?? "{}")) as unknown,
      });
      await new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
      return new Response(
        JSON.stringify({ inserted: 1, events: [{ id: "log-in-flight-1" }] }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    const transport = createPinoOpenLogsTransport({
      url: "http://collector.test",
      projectId: "project-pino",
      maxBatchSize: 1,
      maxQueueSize: 1,
      flushIntervalMs: 60_000,
      onDrop: (event) => {
        drops.push({ reason: event.reason, record: event.record });
      },
    });

    transport.write(`${JSON.stringify({ level: 30, msg: "in flight" })}\n`);
    const flush = transport.flush();
    await waitForRequestCount(requests, 1);
    transport.write(`${JSON.stringify({ level: 30, msg: "new pressure" })}\n`);

    expect(drops).toEqual([
      {
        reason: "queue_full",
        record: { level: 30, msg: "new pressure" },
      },
    ]);
    expect(transport.stats()).toMatchObject({
      pending: 1,
      dropped: 1,
      sent: 0,
    });

    releaseResponse?.();
    await flush;
    transport.stop();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({
      logs: [{ level: 30, msg: "in flight" }],
    });
    expect(transport.stats()).toMatchObject({
      pending: 0,
      sent: 1,
      dropped: 1,
    });
  });

  it("drops each structured transport record when its own retry budget is exhausted", async () => {
    const requests: MockRequest[] = [];
    const drops: Array<{ reason: string; attempts: number; record: unknown }> =
      [];
    let releaseFirstResponse: (() => void) | undefined;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body ?? "{}")) as unknown,
      });
      if (requests.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirstResponse = resolve;
        });
      }
      return new Response(JSON.stringify({ error: "collector down" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const transport = createPinoOpenLogsTransport({
      url: "http://collector.test",
      projectId: "project-pino",
      maxBatchSize: 2,
      maxQueueSize: 2,
      maxRetries: 1,
      retryBaseDelayMs: 0,
      flushIntervalMs: 60_000,
      onDrop: (event) => {
        drops.push({
          reason: event.reason,
          attempts: event.attempts,
          record: event.record,
        });
      },
    });

    transport.write(`${JSON.stringify({ level: 30, msg: "older active" })}\n`);
    const flush = transport.flush();
    await waitForRequestCount(requests, 1);
    transport.write(`${JSON.stringify({ level: 30, msg: "new queued" })}\n`);
    transport.write(`${JSON.stringify({ level: 30, msg: "new retained" })}\n`);

    releaseFirstResponse?.();
    await expect(flush).rejects.toThrow("collector down");
    transport.stop();

    const sentMessages = requests.flatMap((request) => {
      const body = request.body as { logs?: Array<{ msg?: string }> };
      return body.logs?.map((log) => log.msg) ?? [];
    });
    expect(
      sentMessages.filter((message) => message === "older active"),
    ).toHaveLength(2);
    const retainedAttempts = requests.flatMap((request) => {
      const body = request.body as {
        logs?: Array<{ msg?: string; _open_logs_event_id?: string }>;
        source_event_prefix?: string;
      };
      return (body.logs ?? [])
        .filter((log) => log.msg === "new retained")
        .map((log) => ({
          id: log._open_logs_event_id,
          prefix: body.source_event_prefix,
        }));
    });
    expect(retainedAttempts).toHaveLength(2);
    expect(new Set(retainedAttempts.map((attempt) => attempt.id)).size).toBe(1);
    expect(
      new Set(retainedAttempts.map((attempt) => attempt.prefix)).size,
    ).toBe(1);
    expect(drops).toEqual([
      {
        reason: "queue_full",
        attempts: 0,
        record: { level: 30, msg: "new queued" },
      },
      {
        reason: "retries_exhausted",
        attempts: 2,
        record: { level: 30, msg: "older active" },
      },
      {
        reason: "retries_exhausted",
        attempts: 2,
        record: { level: 30, msg: "new retained" },
      },
    ]);
    expect(transport.stats()).toMatchObject({
      pending: 0,
      sent: 0,
      dropped: 3,
      retries: 2,
      failed_batches: 3,
    });
  });

  it("persists structured transport records to a redacted file spool and replays them after restart", async () => {
    const spoolDirectory = mkdtempSync(join(tmpdir(), "open-logs-sdk-spool-"));
    const basicAuthSecret = "dXNlcjpzdXBlci1zZWNyZXQ=";
    const urlUserinfoPassword = "sdk-url-spool-secret";
    const requests: MockRequest[] = [];
    let collectorUp = false;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body ?? "{}")) as unknown,
      });
      if (!collectorUp) {
        return new Response(JSON.stringify({ error: "collector down" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ inserted: 1, events: [{ id: "log-spooled-1" }] }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const transport = createPinoOpenLogsTransport({
        url: "http://collector.test",
        projectId: "project-pino",
        service: "spool-service",
        environment: "spool-env",
        releaseId: "spool-release",
        metadata: {
          producer: "spool-test",
          token: "OPENLOGS_SECRET_CANARY_sdk_spool_metadata_12345",
        },
        maxBatchSize: 10,
        maxRetries: 0,
        retryBaseDelayMs: 0,
        flushIntervalMs: 60_000,
        spoolDirectory,
        sourceEventPrefix:
          "spool-test-token=OPENLOGS_SECRET_CANARY_sdk_spool_prefix_12345",
      });
      transport.write(
        `${JSON.stringify({
          level: 30,
          msg: "spool me token=OPENLOGS_SECRET_CANARY_sdk_spool_12345",
          token: "OPENLOGS_SECRET_CANARY_sdk_spool_12345",
          args: ["--api-key", "plain-spool-secret"],
          headers_json: `{"Authorization":"Basic ${basicAuthSecret}"}`,
          env_header: `HTTP_AUTHORIZATION=Basic ${basicAuthSecret}`,
          db_url: `postgres://app:${urlUserinfoPassword}@db.example/logs`,
        })}\n`,
      );

      await expect(transport.flush()).rejects.toThrow("collector down");
      transport.stop();
      await waitForRequestCount(requests, 2);

      const spoolPath = join(
        spoolDirectory,
        readdirSync(spoolDirectory).find((file) =>
          file.endsWith("structured-spool.jsonl"),
        ) ?? "",
      );
      expect(existsSync(spoolPath)).toBe(true);
      const spooled = readFileSync(spoolPath, "utf8");
      expect(spooled).toContain("[REDACTED]");
      expect(spooled).not.toContain("OPENLOGS_SECRET_CANARY_sdk_spool_12345");
      expect(spooled).not.toContain(
        "OPENLOGS_SECRET_CANARY_sdk_spool_prefix_12345",
      );
      expect(spooled).not.toContain("plain-spool-secret");
      expect(spooled).not.toContain(basicAuthSecret);
      expect(spooled).not.toContain(urlUserinfoPassword);

      const failedBody = requests[0]?.body as {
        logs?: Array<{
          msg?: string;
          token?: string;
          _open_logs_event_id?: string;
        }>;
        metadata?: Record<string, unknown>;
        source_event_prefix?: string;
      };
      const failedUrl = new URL(requests[0]?.url ?? "");
      expect(failedUrl.searchParams.get("project_id")).toBe("project-pino");
      expect(failedUrl.searchParams.get("service")).toBe("spool-service");
      expect(failedUrl.searchParams.get("environment")).toBe("spool-env");
      expect(failedUrl.searchParams.get("release_id")).toBe("spool-release");
      expect(failedBody.metadata).toMatchObject({
        producer: "spool-test",
        token: "OPENLOGS_SECRET_CANARY_sdk_spool_metadata_12345",
      });
      expect(failedBody.logs?.[0]?.msg).toContain(
        "OPENLOGS_SECRET_CANARY_sdk_spool_12345",
      );
      expect(failedBody.logs?.[0]?.token).toBe(
        "OPENLOGS_SECRET_CANARY_sdk_spool_12345",
      );
      const failedEventId = failedBody.logs?.[0]?._open_logs_event_id;
      const failedPrefix = failedBody.source_event_prefix;
      expect(failedPrefix).toContain("[REDACTED]");
      expect(failedPrefix).not.toContain(
        "OPENLOGS_SECRET_CANARY_sdk_spool_prefix_12345",
      );

      collectorUp = true;
      const restarted = createPinoOpenLogsTransport({
        url: "http://collector.test",
        projectId: "project-pino",
        service: "wrong-restart-service",
        environment: "wrong-restart-env",
        releaseId: "wrong-restart-release",
        metadata: { producer: "wrong-restart-metadata" },
        maxBatchSize: 10,
        maxRetries: 0,
        retryBaseDelayMs: 0,
        flushIntervalMs: 60_000,
        spoolDirectory,
        sourceEventPrefix: "wrong-restart-prefix",
      });
      expect(restarted.stats()).toMatchObject({
        pending: 1,
        spool_enabled: true,
        spool_pending: 1,
        spool_loaded: 1,
        spool_errors: 0,
      });

      await restarted.flush();
      restarted.stop();

      expect(requests).toHaveLength(3);
      const replayBody = requests[2]?.body as {
        logs?: Array<{
          msg?: string;
          token?: string;
          args?: string[];
          headers_json?: string;
          env_header?: string;
          db_url?: string;
          _open_logs_event_id?: string;
        }>;
        metadata?: Record<string, unknown>;
        source_event_prefix?: string;
      };
      const replayUrl = new URL(requests[2]?.url ?? "");
      expect(replayUrl.searchParams.get("project_id")).toBe("project-pino");
      expect(replayUrl.searchParams.get("service")).toBe("spool-service");
      expect(replayUrl.searchParams.get("environment")).toBe("spool-env");
      expect(replayUrl.searchParams.get("release_id")).toBe("spool-release");
      expect(replayBody.source_event_prefix).toBe(failedPrefix);
      expect(replayBody.metadata).toMatchObject({
        producer: "spool-test",
        token: "[REDACTED]",
      });
      expect(replayBody.logs?.[0]?._open_logs_event_id).toBe(failedEventId);
      expect(replayBody.logs?.[0]?.msg).toBe("spool me token=[REDACTED]");
      expect(replayBody.logs?.[0]?.token).toBe("[REDACTED]");
      expect(replayBody.logs?.[0]?.args).toEqual(["--api-key", "[REDACTED]"]);
      expect(replayBody.logs?.[0]?.headers_json).toBe(
        `{"Authorization":"Basic [REDACTED]"}`,
      );
      expect(replayBody.logs?.[0]?.env_header).toBe(
        "HTTP_AUTHORIZATION=Basic [REDACTED]",
      );
      expect(replayBody.logs?.[0]?.db_url).toBe(
        "postgres://[REDACTED]@db.example/logs",
      );
      expect(existsSync(spoolPath)).toBe(false);
      expect(restarted.stats()).toMatchObject({
        pending: 0,
        sent: 1,
        spool_pending: 0,
      });
    } finally {
      rmSync(spoolDirectory, { recursive: true, force: true });
    }
  });

  it("skips malformed structured transport spool lines while replaying valid records", async () => {
    const spoolDirectory = mkdtempSync(join(tmpdir(), "open-logs-sdk-spool-"));
    const spoolFile = join(spoolDirectory, "manual-structured-spool.jsonl");
    const requests = mockFetch({
      response: { inserted: 1, events: [{ id: "log-spooled-valid-1" }] },
    });

    try {
      writeFileSync(
        spoolFile,
        [
          "{not-json",
          JSON.stringify({
            version: 2,
            record: { msg: "unsupported spool version" },
            event_id: "bad-version",
          }),
          JSON.stringify({
            version: 1,
            record: null,
            event_id: "bad-record",
          }),
          JSON.stringify({
            version: 1,
            record: { msg: "bad format context" },
            event_id: "bad-format-context",
            send_options: { format: "not-real" },
          }),
          JSON.stringify({
            version: 1,
            record: { msg: "bad source context" },
            event_id: "bad-source-context",
            send_options: { source: "browser" },
          }),
          JSON.stringify({
            version: 1,
            record: {
              level: 30,
              msg: "valid spooled token=OPENLOGS_SECRET_CANARY_sdk_spool_bad_line",
              token: "OPENLOGS_SECRET_CANARY_sdk_spool_bad_line",
            },
            event_id: "manual-event-id-1",
            attempts: 2,
            created_at: "2026-06-17T08:00:00.000Z",
            batch_prefix: "manual-prefix",
            send_options: {
              format: "pino",
              projectId: "manual-project",
              service: "manual-service",
              environment: "manual-env",
              metadata: {
                producer: "manual-spool",
                token: "OPENLOGS_SECRET_CANARY_sdk_spool_bad_line",
              },
            },
          }),
        ].join("\n"),
        "utf8",
      );

      const transport = createPinoOpenLogsTransport({
        url: "http://collector.test",
        projectId: "wrong-project",
        service: "wrong-service",
        environment: "wrong-env",
        metadata: { producer: "wrong-metadata" },
        maxBatchSize: 10,
        maxRetries: 0,
        retryBaseDelayMs: 0,
        flushIntervalMs: 60_000,
        spoolFile,
        sourceEventPrefix: "unused-after-load",
      });
      expect(transport.stats()).toMatchObject({
        pending: 1,
        spool_enabled: true,
        spool_pending: 1,
        spool_loaded: 1,
        spool_errors: 5,
      });

      await transport.flush();
      transport.stop();

      expect(requests).toHaveLength(1);
      const body = requests[0]?.body as {
        logs?: Array<{
          msg?: string;
          token?: string;
          _open_logs_event_id?: string;
        }>;
        metadata?: Record<string, unknown>;
        source_event_prefix?: string;
      };
      const replayUrl = new URL(requests[0]?.url ?? "");
      expect(replayUrl.searchParams.get("project_id")).toBe("manual-project");
      expect(replayUrl.searchParams.get("service")).toBe("manual-service");
      expect(replayUrl.searchParams.get("environment")).toBe("manual-env");
      expect(body.source_event_prefix).toBe("manual-prefix");
      expect(body.metadata).toMatchObject({
        producer: "manual-spool",
        token: "[REDACTED]",
      });
      expect(body.logs).toHaveLength(1);
      expect(body.logs?.[0]?._open_logs_event_id).toBe("manual-event-id-1");
      expect(body.logs?.[0]?.msg).toBe("valid spooled token=[REDACTED]");
      expect(body.logs?.[0]?.token).toBe("[REDACTED]");
      expect(existsSync(spoolFile)).toBe(false);
      expect(transport.stats()).toMatchObject({
        pending: 0,
        sent: 1,
        spool_pending: 0,
        spool_errors: 5,
      });
    } finally {
      rmSync(spoolDirectory, { recursive: true, force: true });
    }
  });

  it("reports load-time structured transport spool overflow drops", async () => {
    const spoolDirectory = mkdtempSync(join(tmpdir(), "open-logs-sdk-spool-"));
    const spoolFile = join(spoolDirectory, "overflow-structured-spool.jsonl");
    const requests = mockFetch({
      response: { inserted: 2, events: [{ id: "log-overflow-1" }] },
    });
    const drops: Array<{ reason: string; record: unknown; attempts: number }> =
      [];
    const spooledLine = (msg: string, eventId: string) =>
      JSON.stringify({
        version: 1,
        record: { level: 30, msg },
        send_options: {
          format: "pino",
          projectId: "overflow-project",
          service: "overflow-service",
          sourceEventPrefix: "overflow-base",
        },
        event_id: eventId,
        attempts: 0,
        created_at: "2026-06-17T08:00:00.000Z",
        batch_prefix: "overflow-prefix",
      });

    try {
      writeFileSync(
        spoolFile,
        [
          spooledLine("oldest spooled", "overflow-event-oldest"),
          spooledLine("middle spooled", "overflow-event-middle"),
          spooledLine("newest spooled", "overflow-event-newest"),
        ].join("\n"),
        "utf8",
      );

      const transport = createPinoOpenLogsTransport({
        url: "http://collector.test",
        projectId: "wrong-project",
        maxQueueSize: 2,
        maxBatchSize: 10,
        maxRetries: 0,
        retryBaseDelayMs: 0,
        flushIntervalMs: 60_000,
        spoolFile,
        onDrop(event) {
          drops.push({
            reason: event.reason,
            record: event.record,
            attempts: event.attempts,
          });
        },
      });

      expect(transport.stats()).toMatchObject({
        pending: 2,
        dropped: 1,
        spool_enabled: true,
        spool_pending: 2,
        spool_loaded: 2,
        spool_dropped: 1,
        spool_errors: 0,
      });
      expect(drops).toEqual([
        {
          reason: "queue_full",
          record: { level: 30, msg: "oldest spooled" },
          attempts: 0,
        },
      ]);
      expect(readFileSync(spoolFile, "utf8")).not.toContain("oldest spooled");

      await transport.flush();
      transport.stop();

      expect(requests).toHaveLength(1);
      const body = requests[0]?.body as {
        logs?: Array<{ msg?: string; _open_logs_event_id?: string }>;
        source_event_prefix?: string;
      };
      const replayUrl = new URL(requests[0]?.url ?? "");
      expect(replayUrl.searchParams.get("project_id")).toBe("overflow-project");
      expect(replayUrl.searchParams.get("service")).toBe("overflow-service");
      expect(body.source_event_prefix).toBe("overflow-prefix");
      expect(body.logs?.map((log) => log.msg)).toEqual([
        "middle spooled",
        "newest spooled",
      ]);
      expect(body.logs?.map((log) => log._open_logs_event_id)).toEqual([
        "overflow-event-middle",
        "overflow-event-newest",
      ]);
      expect(existsSync(spoolFile)).toBe(false);
    } finally {
      rmSync(spoolDirectory, { recursive: true, force: true });
    }
  });

  it("creates a Winston-compatible structured transport with logged events", async () => {
    const requests = mockFetch({
      response: { inserted: 1, events: [{ id: "log-winston-1" }] },
    });
    const transport = createWinstonOpenLogsTransport({
      url: "http://collector.test",
      projectId: "project-winston",
      service: "worker",
      metadata: { transport: "winston" },
      maxBatchSize: 10,
      flushIntervalMs: 60_000,
      sourceEventPrefix: "winston-test",
    });
    let logged = false;
    let callbackCalled = false;
    transport.on("logged", () => {
      logged = true;
    });

    transport.log(
      {
        level: "warn",
        message: "winston warning",
        timestamp: "2026-06-16T10:00:00.000Z",
        trace_id: "trace-winston-transport",
      },
      () => {
        callbackCalled = true;
      },
    );
    await Promise.resolve();
    await transport.flush();
    transport.close();

    expect(logged).toBe(true);
    expect(callbackCalled).toBe(true);
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]?.url ?? "");
    expect(url.searchParams.get("format")).toBe("winston");
    expect(url.searchParams.get("project_id")).toBe("project-winston");
    expect(url.searchParams.get("service")).toBe("worker");
    expect(requests[0]?.body).toMatchObject({
      metadata: { transport: "winston" },
      logs: [
        {
          level: "warn",
          message: "winston warning",
          trace_id: "trace-winston-transport",
        },
      ],
    });
    expect(
      (requests[0]?.body as { source_event_prefix?: string })
        .source_event_prefix,
    ).toContain("winston-test:");
  });

  it("preserves metadata from Winston legacy transport calls", async () => {
    const requests = mockFetch({
      response: { inserted: 1, events: [{ id: "log-winston-legacy-1" }] },
    });
    const transport = createWinstonOpenLogsTransport({
      url: "http://collector.test",
      projectId: "project-winston",
      maxBatchSize: 10,
      flushIntervalMs: 60_000,
      sourceEventPrefix: "winston-legacy-test",
    });
    let callbackCalled = false;

    transport.log(
      "warn",
      "winston legacy warning",
      {
        level: "warn",
        message: "winston legacy warning",
        trace_id: "trace-winston-legacy",
      },
      () => {
        callbackCalled = true;
      },
    );
    await transport.flush();
    transport.close();

    expect(callbackCalled).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({
      logs: [
        {
          level: "warn",
          message: "winston legacy warning",
          trace_id: "trace-winston-legacy",
        },
      ],
    });
    expect(JSON.stringify(requests[0]?.body)).not.toContain('"0":"w"');
  });

  it("accepts stream-style Winston writes and non-function callbacks", async () => {
    const requests = mockFetch({
      response: { inserted: 1, events: [{ id: "log-winston-stream-1" }] },
    });
    const transport = createWinstonOpenLogsTransport({
      url: "http://collector.test",
      projectId: "project-winston",
      maxBatchSize: 10,
      flushIntervalMs: 60_000,
    });

    expect(transport._writableState.objectMode).toBe(true);
    expect(transport.write({ level: "info", message: "stream write" })).toBe(
      true,
    );
    transport.log(
      { level: "warn", message: "non-function callback" },
      "not-a-callback",
    );
    await transport.flush();
    transport.close();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({
      logs: [
        { level: "info", message: "stream write" },
        { level: "warn", message: "non-function callback" },
      ],
    });
  });

  it("flushes queued Winston transport records on close", async () => {
    const requests = mockFetch({
      response: { inserted: 1, events: [{ id: "log-winston-close-1" }] },
    });
    const transport = createWinstonOpenLogsTransport({
      url: "http://collector.test",
      projectId: "project-winston",
      maxBatchSize: 10,
      flushIntervalMs: 60_000,
    });

    transport.log({ level: "info", message: "winston close" });
    transport.close();
    await waitForRequestCount(requests, 1);

    expect(requests[0]?.body).toMatchObject({
      logs: [{ level: "info", message: "winston close" }],
    });
  });

  it("throws on non-2xx event responses", async () => {
    mockFetch({ status: 422, response: { error: "bad event" } });
    const client = new LogsClient({ url: "http://collector.test" });

    await expect(
      client.pushEvent({ type: "metric", message: "bad" }),
    ).rejects.toThrow("bad event");
  });

  it("normalizes captured exceptions as raw-first exception events", async () => {
    const requests = mockFetch();
    const client = new LogsClient({
      url: "http://collector.test",
      projectId: "project-1",
      source: "node",
    });
    const error = new TypeError("bad input");

    await client.captureException(error, {
      handled: true,
      mechanism: "test",
      trace_id: "trace-1",
      span_id: "span-1",
    });

    expect(requests[0]?.body).toMatchObject({
      type: "exception",
      severity: "error",
      source: "node",
      project_id: "project-1",
      message: "bad input",
      trace_id: "trace-1",
      span_id: "span-1",
      body: {
        exception: {
          type: "TypeError",
          value: "bad input",
          handled: true,
          mechanism: "test",
        },
      },
      attributes: {
        exception_type: "TypeError",
        handled: true,
        mechanism: "test",
      },
    });
    const requestBody = requests[0]?.body as { body?: unknown } | undefined;
    const exceptionBody = requestBody?.body as
      | { exception?: { stack_trace?: unknown } }
      | undefined;
    expect(String(exceptionBody?.exception?.stack_trace)).toContain(
      "TypeError",
    );
  });

  it("emits metrics and spans with trace-correlation fields", async () => {
    const requests = mockFetch();
    const client = new LogsClient({
      url: "http://collector.test",
      projectId: "project-1",
      source: "sdk",
    });

    await client.captureMetric("http.requests", 3, {
      kind: "counter",
      unit: "request",
      trace_id: "trace-1",
      span_id: "span-1",
    });
    await client.captureSpan({
      name: "GET /health",
      operation: "http.server",
      status: "ok",
      duration_ms: 12,
      trace_id: "trace-1",
      span_id: "span-2",
      parent_span_id: "span-1",
    });

    expect(requests[0]?.body).toMatchObject({
      type: "metric",
      message: "http.requests",
      trace_id: "trace-1",
      span_id: "span-1",
      body: {
        name: "http.requests",
        value: 3,
        kind: "counter",
        unit: "request",
      },
    });
    expect(requests[1]?.body).toMatchObject({
      type: "span",
      message: "GET /health",
      trace_id: "trace-1",
      span_id: "span-2",
      parent_span_id: "span-1",
      body: {
        name: "GET /health",
        operation: "http.server",
        status: "ok",
        duration_ms: 12,
      },
      attributes: {
        name: "GET /health",
        operation: "http.server",
        status: "ok",
        duration_ms: 12,
      },
    });
  });

  it("queues browser universal logs and flushes them through pushEvents", async () => {
    const requests = mockFetch({
      response: { inserted: 1, events: [{ event_id: "evt-browser-1" }] },
    });
    const intervalHandlers: Array<() => void> = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener() {},
      },
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: "https://app.example/dashboard" },
    });
    globalThis.setInterval = ((handler: Parameters<typeof setInterval>[0]) => {
      if (typeof handler === "function") intervalHandlers.push(() => handler());
      return 0 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    console.warn = () => {};

    initUniversalLogs({
      url: "http://collector.test",
      projectId: "project-browser",
      browserToken: "browser-token",
      sessionId: "session-browser",
    });
    console.warn("slow route");
    intervalHandlers[0]?.();
    await Promise.resolve();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers["X-Logs-Browser-Token"]).toBe("browser-token");
    expect(requests[0]?.body).toMatchObject([
      {
        type: "log",
        severity: "warn",
        source: "browser",
        session_id: "session-browser",
        message: "slow route",
        attributes: {
          console_method: "warn",
          url: "https://app.example/dashboard",
        },
      },
    ]);
    expect(JSON.stringify(requests[0]?.body)).not.toContain("project-browser");
  });

  it("captures browser console levels and fetch client telemetry", async () => {
    const requests: MockRequest[] = [];
    const appFetches: string[] = [];
    const underlyingFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.startsWith("http://collector.test")) {
        requests.push({
          url,
          headers: init?.headers as Record<string, string>,
          body: JSON.parse(String(init?.body ?? "{}")) as unknown,
        });
        return new Response(
          JSON.stringify({
            inserted: 1,
            events: [{ event_id: `evt-browser-runtime-${requests.length}` }],
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      appFetches.push(url);
      if (url.includes("/throw")) throw new Error("dns down");
      if (url.includes("/fail")) return new Response("nope", { status: 503 });
      return new Response("ok", { status: 204 });
    }) as typeof fetch;
    globalThis.fetch = underlyingFetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener() {},
        removeEventListener() {},
      },
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: "https://app.example/dashboard" },
    });
    globalThis.setInterval = (() =>
      0 as unknown as ReturnType<typeof setInterval>) as typeof setInterval;
    console.debug = () => {};
    console.log = () => {};
    console.info = () => {};
    console.warn = () => {};
    console.error = () => {};

    const controller = initUniversalLogs({
      url: "http://collector.test",
      projectId: "project-browser",
      browserToken: "browser-token",
      sessionId: "session-browser",
      flushIntervalMs: 60_000,
    });
    console.debug("debug route");
    console.log("log route");
    console.info("info route");
    console.warn("warn route");
    console.error(new Error("broken route"));
    await fetch("https://api.example.test/users");
    await fetch("/relative?x=1");
    await fetch("https://api.example.test/fail");
    await expect(fetch("https://api.example.test/throw")).rejects.toThrow(
      "dns down",
    );
    await controller?.flush();

    expect(appFetches).toEqual([
      "https://api.example.test/users",
      "/relative?x=1",
      "https://api.example.test/fail",
      "https://api.example.test/throw",
    ]);
    expect(requests).toHaveLength(1);
    const body = requests[0]?.body as Array<{
      type?: string;
      severity?: string;
      message?: string;
      body?: Record<string, unknown>;
      attributes?: Record<string, unknown>;
    }>;
    expect(body).toHaveLength(9);
    expect(body.slice(0, 5)).toMatchObject([
      {
        type: "log",
        severity: "debug",
        message: "debug route",
        attributes: { console_method: "debug" },
      },
      {
        type: "log",
        severity: "info",
        message: "log route",
        attributes: { console_method: "log" },
      },
      {
        type: "log",
        severity: "info",
        message: "info route",
        attributes: { console_method: "info" },
      },
      {
        type: "log",
        severity: "warn",
        message: "warn route",
        attributes: { console_method: "warn" },
      },
      {
        type: "log",
        severity: "error",
        message: "Error: broken route",
        attributes: { console_method: "error" },
      },
    ]);
    expect(body[5]).toMatchObject({
      type: "span",
      severity: "info",
      message: "GET https://api.example.test/users",
      body: { operation: "http.client", status: "ok" },
      attributes: {
        method: "GET",
        url: "https://api.example.test/users",
        status_code: 204,
        ok: true,
      },
    });
    expect(body[6]).toMatchObject({
      type: "span",
      severity: "info",
      message: "GET https://app.example/relative?x=1",
      body: { operation: "http.client", status: "ok" },
      attributes: {
        method: "GET",
        url: "https://app.example/relative?x=1",
        status_code: 204,
        ok: true,
      },
    });
    expect(body[7]).toMatchObject({
      type: "span",
      severity: "error",
      message: "GET https://api.example.test/fail",
      body: { operation: "http.client", status: "error" },
      attributes: {
        method: "GET",
        url: "https://api.example.test/fail",
        status_code: 503,
        ok: false,
      },
    });
    expect(body[8]).toMatchObject({
      type: "network",
      severity: "error",
      message: "GET https://api.example.test/throw failed: dns down",
      attributes: {
        method: "GET",
        url: "https://api.example.test/throw",
        error_type: "Error",
      },
    });

    controller?.stop();
    expect(globalThis.fetch).toBe(underlyingFetch);
  });

  it("does not capture relative browser collector requests as app fetch telemetry", async () => {
    const requests: MockRequest[] = [];
    const underlyingFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (
        url === "/collector/api/events" ||
        url === "https://app.example/collector/api/events"
      ) {
        requests.push({
          url,
          headers: init?.headers as Record<string, string>,
          body: JSON.parse(String(init?.body ?? "{}")) as unknown,
        });
        return new Response(
          JSON.stringify({
            inserted: 1,
            events: [{ event_id: `evt-relative-collector-${requests.length}` }],
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unexpected app fetch", { status: 204 });
    }) as typeof fetch;
    globalThis.fetch = underlyingFetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener() {},
        removeEventListener() {},
      },
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: "https://app.example/dashboard" },
    });
    globalThis.setInterval = (() =>
      0 as unknown as ReturnType<typeof setInterval>) as typeof setInterval;
    console.warn = () => {};

    const controller = initUniversalLogs({
      url: "/collector",
      projectId: "project-browser",
      browserToken: "browser-token",
      sessionId: "session-browser",
      maxBatchSize: 1,
      flushIntervalMs: 60_000,
    });
    console.warn("first event");
    await waitForRequestCount(requests, 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await controller?.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://app.example/collector/api/events");
    expect(JSON.stringify(requests[0]?.body)).not.toContain(
      "collector/api/events",
    );

    controller?.stop();
    expect(globalThis.fetch).toBe(underlyingFetch);
  });

  it("propagates opt-in browser fetch trace context for same-origin requests", async () => {
    const requests: MockRequest[] = [];
    const appFetches: Array<{ url: string; traceparent: string | null }> = [];
    const existingTraceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const existingSpanId = "bbbbbbbbbbbbbbbb";
    const underlyingFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url =
        typeof Request !== "undefined" && input instanceof Request
          ? input.url
          : String(input);
      const headers = new Headers(
        init?.headers ??
          (typeof Request !== "undefined" && input instanceof Request
            ? input.headers
            : undefined),
      );
      if (url === "https://app.example/collector/api/events") {
        requests.push({
          url,
          headers: init?.headers as Record<string, string>,
          body: JSON.parse(String(init?.body ?? "{}")) as unknown,
        });
        return new Response(
          JSON.stringify({
            inserted: 1,
            events: [{ event_id: `evt-browser-trace-${requests.length}` }],
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      appFetches.push({ url, traceparent: headers.get("traceparent") });
      return new Response("ok", { status: 204 });
    }) as typeof fetch;
    globalThis.fetch = underlyingFetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener() {},
        removeEventListener() {},
      },
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: "https://app.example/dashboard" },
    });
    globalThis.setInterval = (() =>
      0 as unknown as ReturnType<typeof setInterval>) as typeof setInterval;

    const controller = initUniversalLogs({
      url: "/collector",
      projectId: "project-browser",
      browserToken: "browser-token",
      sessionId: "session-browser",
      captureConsole: false,
      captureExceptions: false,
      captureRejections: false,
      captureFetch: true,
      propagateTrace: true,
      maxBatchSize: 20,
      flushIntervalMs: 60_000,
    });
    await fetch("/api/same-origin", { headers: { "x-app": "one" } });
    await fetch("/api/existing-trace", {
      headers: {
        traceparent: `00-${existingTraceId}-${existingSpanId}-01`,
      },
    });
    await fetch("https://api.example.test/external");
    await fetch("/api/invalid-trace", {
      headers: { traceparent: "not-a-valid-traceparent" },
    });
    await fetch(
      new Request("https://app.example/api/request-invalid-trace", {
        headers: { traceparent: "bad-request-traceparent" },
      }),
    );
    await fetch("/api/uppercase-trace", {
      headers: {
        traceparent: "00-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBB-01",
      },
    });
    await fetch(
      new Request("https://app.example/api/request-uppercase-trace", {
        headers: {
          traceparent:
            "00-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC-DDDDDDDDDDDDDDDD-01",
        },
      }),
    );
    await fetch("/api/ff-version-trace", {
      headers: {
        traceparent: "ff-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-ffffffffffffffff-01",
      },
    });
    await fetch("/api/duplicate-trace", {
      headers: [
        [
          "traceparent",
          "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01",
        ],
        ["traceparent", "not-valid"],
      ],
    });
    await fetch("/api/no-cors-trace", { mode: "no-cors" });
    await fetch("/api/no-cors-existing-trace", {
      mode: "no-cors",
      headers: {
        traceparent: `00-${existingTraceId}-${existingSpanId}-01`,
      },
    });
    await fetch("blob:https://app.example/runtime-blob");
    await controller?.flush();

    expect(appFetches).toHaveLength(12);
    const propagated = appFetches[0]?.traceparent?.match(
      /^00-([\da-f]{32})-([\da-f]{16})-01$/,
    );
    expect(propagated).toBeTruthy();
    if (!propagated) throw new Error("expected propagated traceparent");
    expect(appFetches[1]?.traceparent).toBe(
      `00-${existingTraceId}-${existingSpanId}-01`,
    );
    expect(appFetches[2]?.traceparent).toBeNull();
    expect(appFetches[3]?.traceparent).toBe("not-a-valid-traceparent");
    expect(appFetches[4]?.traceparent).toBe("bad-request-traceparent");
    expect(appFetches[5]?.traceparent).toBe(
      "00-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBB-01",
    );
    expect(appFetches[6]?.traceparent).toBe(
      "00-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC-DDDDDDDDDDDDDDDD-01",
    );
    expect(appFetches[7]?.traceparent).toBe(
      "ff-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-ffffffffffffffff-01",
    );
    expect(appFetches[8]?.traceparent).toBe(
      "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01, not-valid",
    );
    expect(appFetches[9]?.traceparent).toBeNull();
    expect(appFetches[10]?.traceparent).toBe(
      `00-${existingTraceId}-${existingSpanId}-01`,
    );
    expect(appFetches[11]?.traceparent).toBeNull();
    expect(requests).toHaveLength(1);

    const body = requests[0]?.body as Array<{
      type?: string;
      trace_id?: string;
      span_id?: string;
      message?: string;
      attributes?: Record<string, unknown>;
    }>;
    expect(body).toHaveLength(12);
    expect(body[0]).toMatchObject({
      type: "span",
      trace_id: propagated[1],
      span_id: propagated[2],
      message: "GET https://app.example/api/same-origin",
      attributes: {
        operation: "http.client",
        url: "https://app.example/api/same-origin",
        traceparent_propagated: true,
      },
    });
    expect(body[1]).toMatchObject({
      type: "span",
      trace_id: existingTraceId,
      span_id: existingSpanId,
      message: "GET https://app.example/api/existing-trace",
      attributes: {
        operation: "http.client",
        traceparent_existing: true,
      },
    });
    expect(body[2]).toMatchObject({
      type: "span",
      message: "GET https://api.example.test/external",
      attributes: {
        operation: "http.client",
        url: "https://api.example.test/external",
      },
    });
    expect(body[2]?.trace_id).toBeUndefined();
    expect(String(body[2]?.span_id).startsWith("span_")).toBe(true);
    expect(body[2]?.attributes?.traceparent_propagated).toBeUndefined();
    expect(body[3]).toMatchObject({
      type: "span",
      message: "GET https://app.example/api/invalid-trace",
      attributes: {
        operation: "http.client",
        traceparent_existing: true,
      },
    });
    expect(body[3]?.trace_id).toBeUndefined();
    expect(String(body[3]?.span_id).startsWith("span_")).toBe(true);
    expect(body[3]?.attributes?.traceparent_propagated).toBeUndefined();
    expect(body[4]).toMatchObject({
      type: "span",
      message: "GET https://app.example/api/request-invalid-trace",
      attributes: {
        operation: "http.client",
        traceparent_existing: true,
      },
    });
    expect(body[4]?.trace_id).toBeUndefined();
    expect(String(body[4]?.span_id).startsWith("span_")).toBe(true);
    expect(body[4]?.attributes?.traceparent_propagated).toBeUndefined();
    expect(body[5]).toMatchObject({
      type: "span",
      message: "GET https://app.example/api/uppercase-trace",
      attributes: {
        operation: "http.client",
        traceparent_existing: true,
      },
    });
    expect(body[5]?.trace_id).toBeUndefined();
    expect(String(body[5]?.span_id).startsWith("span_")).toBe(true);
    expect(body[5]?.attributes?.traceparent_propagated).toBeUndefined();
    expect(body[6]).toMatchObject({
      type: "span",
      message: "GET https://app.example/api/request-uppercase-trace",
      attributes: {
        operation: "http.client",
        traceparent_existing: true,
      },
    });
    expect(body[6]?.trace_id).toBeUndefined();
    expect(String(body[6]?.span_id).startsWith("span_")).toBe(true);
    expect(body[6]?.attributes?.traceparent_propagated).toBeUndefined();
    expect(body[7]).toMatchObject({
      type: "span",
      message: "GET https://app.example/api/ff-version-trace",
      attributes: {
        operation: "http.client",
        traceparent_existing: true,
      },
    });
    expect(body[7]?.trace_id).toBeUndefined();
    expect(String(body[7]?.span_id).startsWith("span_")).toBe(true);
    expect(body[7]?.attributes?.traceparent_propagated).toBeUndefined();
    expect(body[8]).toMatchObject({
      type: "span",
      message: "GET https://app.example/api/duplicate-trace",
      attributes: {
        operation: "http.client",
        traceparent_existing: true,
      },
    });
    expect(body[8]?.trace_id).toBeUndefined();
    expect(String(body[8]?.span_id).startsWith("span_")).toBe(true);
    expect(body[8]?.attributes?.traceparent_propagated).toBeUndefined();
    expect(body[9]).toMatchObject({
      type: "span",
      message: "GET https://app.example/api/no-cors-trace",
      attributes: {
        operation: "http.client",
        traceparent_suppressed: "no-cors",
      },
    });
    expect(body[9]?.trace_id).toBeUndefined();
    expect(String(body[9]?.span_id).startsWith("span_")).toBe(true);
    expect(body[9]?.attributes?.traceparent_propagated).toBeUndefined();
    expect(body[9]?.attributes?.traceparent_existing).toBeUndefined();
    expect(body[10]).toMatchObject({
      type: "span",
      message: "GET https://app.example/api/no-cors-existing-trace",
      attributes: {
        operation: "http.client",
        traceparent_suppressed: "no-cors",
      },
    });
    expect(body[10]?.trace_id).toBeUndefined();
    expect(String(body[10]?.span_id).startsWith("span_")).toBe(true);
    expect(body[10]?.attributes?.traceparent_propagated).toBeUndefined();
    expect(body[10]?.attributes?.traceparent_existing).toBeUndefined();
    expect(body[11]).toMatchObject({
      type: "span",
      message: "GET blob:https://app.example/runtime-blob",
      attributes: {
        operation: "http.client",
        traceparent_suppressed: "non-http",
      },
    });
    expect(body[11]?.trace_id).toBeUndefined();
    expect(String(body[11]?.span_id).startsWith("span_")).toBe(true);
    expect(body[11]?.attributes?.traceparent_propagated).toBeUndefined();
    expect(body[11]?.attributes?.traceparent_existing).toBeUndefined();

    controller?.stop();
    expect(globalThis.fetch).toBe(underlyingFetch);
  });

  it("propagates opt-in browser fetch trace context only for exact absolute target origins", async () => {
    const requests: MockRequest[] = [];
    const appFetches: Array<{ url: string; traceparent: string | null }> = [];
    const underlyingFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url =
        typeof Request !== "undefined" && input instanceof Request
          ? input.url
          : String(input);
      const headers = new Headers(
        init?.headers ??
          (typeof Request !== "undefined" && input instanceof Request
            ? input.headers
            : undefined),
      );
      if (url === "https://app.example/collector/api/events") {
        requests.push({
          url,
          headers: init?.headers as Record<string, string>,
          body: JSON.parse(String(init?.body ?? "{}")) as unknown,
        });
        return new Response(
          JSON.stringify({
            inserted: 1,
            events: [{ event_id: `evt-browser-target-${requests.length}` }],
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      appFetches.push({ url, traceparent: headers.get("traceparent") });
      return new Response("ok", { status: 204 });
    }) as typeof fetch;
    globalThis.fetch = underlyingFetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener() {},
        removeEventListener() {},
      },
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: "https://app.example/dashboard" },
    });
    globalThis.setInterval = (() =>
      0 as unknown as ReturnType<typeof setInterval>) as typeof setInterval;

    const controller = initUniversalLogs({
      url: "/collector",
      projectId: "project-browser",
      browserToken: "browser-token",
      sessionId: "session-browser",
      captureConsole: false,
      captureExceptions: false,
      captureRejections: false,
      captureFetch: true,
      propagateTrace: true,
      tracePropagationTargets: ["https://api.example.test"],
      flushIntervalMs: 60_000,
    });
    await fetch("https://api.example.test/users");
    await fetch("https://api.example.test.evil/users");
    await controller?.flush();

    expect(appFetches).toHaveLength(2);
    const propagated = appFetches[0]?.traceparent?.match(
      /^00-([\da-f]{32})-([\da-f]{16})-01$/,
    );
    expect(propagated).toBeTruthy();
    if (!propagated) throw new Error("expected propagated traceparent");
    expect(appFetches[1]?.traceparent).toBeNull();
    expect(requests).toHaveLength(1);

    const body = requests[0]?.body as Array<{
      trace_id?: string;
      span_id?: string;
      message?: string;
      attributes?: Record<string, unknown>;
    }>;
    expect(body).toHaveLength(2);
    expect(body[0]).toMatchObject({
      trace_id: propagated[1],
      span_id: propagated[2],
      message: "GET https://api.example.test/users",
      attributes: {
        operation: "http.client",
        traceparent_propagated: true,
      },
    });
    expect(body[1]).toMatchObject({
      message: "GET https://api.example.test.evil/users",
      attributes: {
        operation: "http.client",
      },
    });
    expect(body[1]?.trace_id).toBeUndefined();
    expect(String(body[1]?.span_id).startsWith("span_")).toBe(true);
    expect(body[1]?.attributes?.traceparent_propagated).toBeUndefined();

    controller?.stop();
    expect(globalThis.fetch).toBe(underlyingFetch);
  });

  it("captures opt-in browser navigation and resource timing telemetry", async () => {
    const requests: MockRequest[] = [];
    const listeners = new Map<string, Set<(event?: unknown) => void>>();
    const observeOptions: unknown[] = [];
    let disconnects = 0;
    let resourceCallback:
      | ((list: { getEntries(): Array<Record<string, unknown>> }) => void)
      | undefined;
    const location = { href: "https://app.example/dashboard" };
    const underlyingFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url === "https://app.example/collector/api/events") {
        requests.push({
          url,
          headers: init?.headers as Record<string, string>,
          body: JSON.parse(String(init?.body ?? "{}")) as unknown,
        });
        return new Response(
          JSON.stringify({
            inserted: 1,
            events: [{ event_id: `evt-browser-nav-${requests.length}` }],
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unexpected app fetch", { status: 204 });
    }) as typeof fetch;
    globalThis.fetch = underlyingFetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener(type: string, listener: (event?: unknown) => void) {
          const set = listeners.get(type) ?? new Set();
          set.add(listener);
          listeners.set(type, set);
        },
        removeEventListener(type: string, listener: (event?: unknown) => void) {
          listeners.get(type)?.delete(listener);
        },
      },
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: location,
    });
    Object.defineProperty(globalThis, "history", {
      configurable: true,
      value: {
        pushState(_state: unknown, _title: string, url?: string | URL | null) {
          if (url)
            location.href = new URL(String(url), location.href).toString();
        },
        replaceState(
          _state: unknown,
          _title: string,
          url?: string | URL | null,
        ) {
          if (url)
            location.href = new URL(String(url), location.href).toString();
        },
      },
    });
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: {
        getEntriesByType(type: string) {
          if (type !== "resource") return [];
          return [
            {
              name: "/app.js",
              initiatorType: "script",
              startTime: 3.2,
              duration: 12.7,
              transferSize: 512,
              encodedBodySize: 256,
              decodedBodySize: 1024,
            },
          ];
        },
      },
    });
    Object.defineProperty(globalThis, "PerformanceObserver", {
      configurable: true,
      value: class FakePerformanceObserver {
        constructor(
          callback: (list: {
            getEntries(): Array<Record<string, unknown>>;
          }) => void,
        ) {
          resourceCallback = callback;
        }

        observe(options: unknown) {
          observeOptions.push(options);
        }

        disconnect() {
          disconnects += 1;
        }
      },
    });
    globalThis.setInterval = (() =>
      0 as unknown as ReturnType<typeof setInterval>) as typeof setInterval;

    const controller = initUniversalLogs({
      url: "/collector",
      projectId: "project-browser",
      browserToken: "browser-token",
      sessionId: "session-browser",
      captureConsole: false,
      captureExceptions: false,
      captureRejections: false,
      captureNavigation: true,
      captureResourceTiming: true,
      maxResourceTimingEvents: 5,
      flushIntervalMs: 60_000,
    });
    (
      globalThis as unknown as {
        history: {
          pushState(state: unknown, title: string, url?: string): void;
        };
      }
    ).history.pushState({}, "", "/settings");
    resourceCallback?.({
      getEntries: () => [
        {
          name: "/app.js",
          initiatorType: "script",
          startTime: 3.2,
          duration: 12.7,
          transferSize: 512,
        },
        {
          name: "https://app.example/collector/api/events",
          initiatorType: "fetch",
          duration: 5,
        },
        {
          name: "/assets/app.css",
          initiatorType: "link",
          startTime: 20,
          duration: 8.4,
          transferSize: 2048,
        },
      ],
    });
    await controller?.flush();

    expect(observeOptions).toEqual([{ type: "resource", buffered: true }]);
    expect(requests).toHaveLength(1);
    const body = requests[0]?.body as Array<{
      type?: string;
      message?: string;
      attributes?: Record<string, unknown>;
    }>;
    expect(body).toHaveLength(4);
    expect(body.map((event) => event.attributes?.operation)).toEqual([
      "browser.navigation",
      "browser.resource",
      "browser.navigation",
      "browser.resource",
    ]);
    expect(body[0]).toMatchObject({
      type: "span",
      message: "NAVIGATION https://app.example/dashboard",
      attributes: {
        navigation_type: "page_load",
        to_url: "https://app.example/dashboard",
      },
    });
    expect(body[2]).toMatchObject({
      type: "span",
      message: "NAVIGATION https://app.example/settings",
      attributes: {
        navigation_type: "pushState",
        from_url: "https://app.example/dashboard",
        to_url: "https://app.example/settings",
      },
    });
    expect(body[1]).toMatchObject({
      type: "span",
      message: "RESOURCE https://app.example/app.js",
      attributes: {
        initiator_type: "script",
        duration_ms: 13,
        transfer_size: 512,
      },
    });
    expect(body[3]).toMatchObject({
      type: "span",
      message: "RESOURCE https://app.example/assets/app.css",
      attributes: {
        initiator_type: "link",
        duration_ms: 8,
        transfer_size: 2048,
      },
    });
    expect(JSON.stringify(body)).not.toContain("collector/api/events");

    controller?.stop();
    expect(disconnects).toBe(1);
    expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
    expect(globalThis.fetch).toBe(underlyingFetch);
  });

  it("captures opt-in browser web vitals telemetry", async () => {
    const requests: MockRequest[] = [];
    const listeners = new Map<string, Set<(event?: unknown) => void>>();
    const observeOptions: unknown[] = [];
    const callbacks = new Map<
      string,
      (list: { getEntries(): Array<Record<string, unknown>> }) => void
    >();
    let disconnects = 0;
    const location = { href: "https://app.example/dashboard" };
    const underlyingFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url === "https://app.example/collector/api/events") {
        requests.push({
          url,
          headers: init?.headers as Record<string, string>,
          body: JSON.parse(String(init?.body ?? "{}")) as unknown,
        });
        return new Response(
          JSON.stringify({
            inserted: 1,
            events: [{ event_id: `evt-browser-vitals-${requests.length}` }],
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unexpected app fetch", { status: 204 });
    }) as typeof fetch;
    globalThis.fetch = underlyingFetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener(type: string, listener: (event?: unknown) => void) {
          const set = listeners.get(type) ?? new Set();
          set.add(listener);
          listeners.set(type, set);
        },
        removeEventListener(type: string, listener: (event?: unknown) => void) {
          listeners.get(type)?.delete(listener);
        },
      },
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: location,
    });
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: {
        getEntriesByType(type: string) {
          if (type === "paint") {
            return [
              {
                entryType: "paint",
                name: "first-paint",
                startTime: 900,
              },
              {
                entryType: "paint",
                name: "first-contentful-paint",
                startTime: 1234.4,
              },
            ];
          }
          if (type === "largest-contentful-paint") {
            return [
              {
                entryType: "largest-contentful-paint",
                name: "",
                startTime: 2700.2,
                renderTime: 2700.2,
              },
            ];
          }
          if (type === "layout-shift") {
            return [
              {
                entryType: "layout-shift",
                name: "",
                startTime: 1500,
                value: 0.12,
                hadRecentInput: false,
              },
              {
                entryType: "layout-shift",
                name: "",
                startTime: 1600,
                value: 0.75,
                hadRecentInput: true,
              },
            ];
          }
          if (type === "first-input") {
            return [
              {
                entryType: "first-input",
                name: "pointerdown",
                startTime: 2000,
                processingStart: 2042,
                duration: 55,
              },
            ];
          }
          if (type === "event") {
            return [
              {
                entryType: "event",
                name: "click",
                startTime: 3000,
                duration: 180,
                interactionId: 7,
              },
            ];
          }
          return [];
        },
      },
    });
    Object.defineProperty(globalThis, "PerformanceObserver", {
      configurable: true,
      value: class FakePerformanceObserver {
        constructor(
          private readonly callback: (list: {
            getEntries(): Array<Record<string, unknown>>;
          }) => void,
        ) {}

        observe(options: { type?: string; entryTypes?: string[] }) {
          observeOptions.push(options);
          const type = options.type ?? options.entryTypes?.[0];
          if (type) callbacks.set(type, this.callback);
        }

        disconnect() {
          disconnects += 1;
        }
      },
    });
    globalThis.setInterval = (() =>
      0 as unknown as ReturnType<typeof setInterval>) as typeof setInterval;

    const controller = initUniversalLogs({
      url: "/collector",
      projectId: "project-browser",
      browserToken: "browser-token",
      sessionId: "session-browser",
      captureConsole: false,
      captureExceptions: false,
      captureRejections: false,
      captureFetch: false,
      captureWebVitals: true,
      maxWebVitalEvents: 10,
      flushIntervalMs: 60_000,
    });
    callbacks.get("paint")?.({
      getEntries: () => [
        {
          entryType: "paint",
          name: "first-contentful-paint",
          startTime: 1234.4,
        },
      ],
    });
    callbacks.get("event")?.({
      getEntries: () => [
        {
          entryType: "event",
          name: "keydown",
          startTime: 3200,
          duration: 120,
          interactionId: 8,
        },
      ],
    });
    await controller?.flush();

    expect(observeOptions).toEqual([
      { type: "paint", buffered: true },
      { type: "largest-contentful-paint", buffered: true },
      { type: "layout-shift", buffered: true },
      { type: "first-input", buffered: true },
      { type: "event", buffered: true, durationThreshold: 16 },
    ]);
    expect(requests).toHaveLength(1);
    const body = requests[0]?.body as Array<{
      type?: string;
      message?: string;
      body?: Record<string, unknown>;
      attributes?: Record<string, unknown>;
    }>;
    expect(body).toHaveLength(5);
    expect(body.every((event) => event.type === "metric")).toBe(true);
    expect(body.map((event) => event.attributes?.web_vital).sort()).toEqual([
      "cls",
      "fcp",
      "fid",
      "inp",
      "lcp",
    ]);
    const metrics = new Map(
      body.map((event) => [event.attributes?.web_vital, event]),
    );
    expect(metrics.get("fcp")).toMatchObject({
      message: "WEB_VITAL fcp 1234",
      body: {
        name: "browser.web_vital.fcp",
        value: 1234,
        kind: "gauge",
        unit: "ms",
      },
      attributes: {
        operation: "browser.web_vital",
        rating: "good",
      },
    });
    expect(metrics.get("lcp")).toMatchObject({
      message: "WEB_VITAL lcp 2700",
      attributes: {
        rating: "needs_improvement",
      },
    });
    expect(metrics.get("cls")).toMatchObject({
      message: "WEB_VITAL cls 0.12",
      attributes: {
        value: 0.12,
        unit: "score",
        rating: "needs_improvement",
        delta: 0.12,
      },
    });
    expect(metrics.get("fid")).toMatchObject({
      message: "WEB_VITAL fid 42",
      attributes: {
        rating: "good",
      },
    });
    expect(metrics.get("inp")).toMatchObject({
      message: "WEB_VITAL inp 180",
      attributes: {
        interaction_id: 7,
        rating: "good",
      },
    });

    controller?.stop();
    expect(disconnects).toBe(5);
    expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
    expect(globalThis.fetch).toBe(underlyingFetch);
  });

  it("stops browser web vitals observers when the metric cap is reached", async () => {
    const requests: MockRequest[] = [];
    const listeners = new Map<string, Set<(event?: unknown) => void>>();
    const callbacks = new Map<
      string,
      (list: { getEntries(): Array<Record<string, unknown>> }) => void
    >();
    let disconnects = 0;
    const underlyingFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url === "https://app.example/collector/api/events") {
        requests.push({
          url,
          headers: init?.headers as Record<string, string>,
          body: JSON.parse(String(init?.body ?? "{}")) as unknown,
        });
        return new Response(
          JSON.stringify({
            inserted: 1,
            events: [{ event_id: `evt-browser-vitals-cap-${requests.length}` }],
          }),
          { status: 201, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("unexpected app fetch", { status: 204 });
    }) as typeof fetch;
    globalThis.fetch = underlyingFetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener(type: string, listener: (event?: unknown) => void) {
          const set = listeners.get(type) ?? new Set();
          set.add(listener);
          listeners.set(type, set);
        },
        removeEventListener(type: string, listener: (event?: unknown) => void) {
          listeners.get(type)?.delete(listener);
        },
      },
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: "https://app.example/dashboard" },
    });
    Object.defineProperty(globalThis, "performance", {
      configurable: true,
      value: {
        getEntriesByType() {
          return [];
        },
      },
    });
    Object.defineProperty(globalThis, "PerformanceObserver", {
      configurable: true,
      value: class FakePerformanceObserver {
        constructor(
          private readonly callback: (list: {
            getEntries(): Array<Record<string, unknown>>;
          }) => void,
        ) {}

        observe(options: { type?: string; entryTypes?: string[] }) {
          const type = options.type ?? options.entryTypes?.[0];
          if (type) callbacks.set(type, this.callback);
        }

        disconnect() {
          disconnects += 1;
        }
      },
    });
    globalThis.setInterval = (() =>
      0 as unknown as ReturnType<typeof setInterval>) as typeof setInterval;

    const controller = initUniversalLogs({
      url: "/collector",
      projectId: "project-browser",
      browserToken: "browser-token",
      sessionId: "session-browser",
      captureConsole: false,
      captureExceptions: false,
      captureRejections: false,
      captureFetch: false,
      captureWebVitals: true,
      maxWebVitalEvents: 2,
      flushIntervalMs: 60_000,
    });
    expect(callbacks.size).toBe(5);

    callbacks.get("event")?.({
      getEntries: () => [
        {
          entryType: "event",
          name: "click",
          startTime: 1000,
          duration: 120,
          interactionId: 1,
        },
        {
          entryType: "event",
          name: "keydown",
          startTime: 1100,
          duration: 180,
          interactionId: 2,
        },
        {
          entryType: "event",
          name: "pointerdown",
          startTime: 1200,
          duration: 240,
          interactionId: 3,
        },
      ],
    });
    expect(disconnects).toBe(5);
    await controller?.flush();
    expect(requests).toHaveLength(1);
    const body = requests[0]?.body as Array<{
      type?: string;
      attributes?: Record<string, unknown>;
    }>;
    expect(body).toHaveLength(2);
    expect(body.map((event) => event.attributes?.web_vital)).toEqual([
      "inp",
      "inp",
    ]);
    expect(body.map((event) => event.attributes?.value)).toEqual([120, 180]);

    callbacks.get("largest-contentful-paint")?.({
      getEntries: () => [
        {
          entryType: "largest-contentful-paint",
          name: "",
          startTime: 2500,
          renderTime: 2500,
        },
      ],
    });
    await controller?.flush();
    expect(requests).toHaveLength(1);

    controller?.stop();
    expect(disconnects).toBe(5);
    expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
    expect(globalThis.fetch).toBe(underlyingFetch);
  });

  it("honors browser runtime capture opt-out flags", async () => {
    const requests: MockRequest[] = [];
    const listeners = new Map<string, (event: unknown) => void>();
    const underlyingFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.startsWith("http://collector.test")) {
        requests.push({
          url,
          headers: init?.headers as Record<string, string>,
          body: JSON.parse(String(init?.body ?? "{}")) as unknown,
        });
      }
      return new Response("ok", { status: 204 });
    }) as typeof fetch;
    globalThis.fetch = underlyingFetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener(type: string, listener: (event: unknown) => void) {
          listeners.set(type, listener);
        },
        removeEventListener(type: string, listener: (event: unknown) => void) {
          if (listeners.get(type) === listener) listeners.delete(type);
        },
      },
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: "https://app.example/dashboard" },
    });
    globalThis.setInterval = (() =>
      0 as unknown as ReturnType<typeof setInterval>) as typeof setInterval;
    console.warn = () => {};

    const controller = initUniversalLogs({
      url: "http://collector.test",
      projectId: "project-browser",
      browserToken: "browser-token",
      sessionId: "session-browser",
      captureConsole: false,
      captureExceptions: false,
      captureRejections: false,
      captureFetch: false,
      flushIntervalMs: 60_000,
    });
    expect(globalThis.fetch).toBe(underlyingFetch);
    expect([...listeners.keys()]).toEqual(["beforeunload"]);

    console.warn("ignored warning");
    await fetch("https://api.example.test/users");
    await controller?.flush();

    expect(requests).toHaveLength(0);
    controller?.stop();
    expect(listeners.size).toBe(0);
  });

  it("removes browser universal event listeners on stop", () => {
    type BrowserTestListener = (event: unknown) => void;
    const listeners = new Map<string, BrowserTestListener>();
    const removals: string[] = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener(type: string, listener: BrowserTestListener) {
          listeners.set(type, listener);
        },
        removeEventListener(type: string, listener: BrowserTestListener) {
          if (listeners.get(type) !== listener) return;
          listeners.delete(type);
          removals.push(type);
        },
      },
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: "https://app.example/dashboard" },
    });
    globalThis.setInterval = (() =>
      0 as unknown as ReturnType<typeof setInterval>) as typeof setInterval;

    const controller = initUniversalLogs({
      url: "http://collector.test",
      projectId: "project-browser",
      browserToken: "browser-token",
      sessionId: "session-browser",
    });

    expect([...listeners.keys()].sort()).toEqual([
      "beforeunload",
      "error",
      "unhandledrejection",
    ]);
    controller?.stop();
    expect(removals.sort()).toEqual([
      "beforeunload",
      "error",
      "unhandledrejection",
    ]);
    expect(listeners.size).toBe(0);
  });

  it("serializes browser universal flushes and preserves queued events while a send is in flight", async () => {
    const spoolKey = "open-logs-test-browser-overlap-spool";
    const storage = createMemoryStorage();
    const requests: MockRequest[] = [];
    const resolvers: Array<() => void> = [];
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body ?? "{}")) as unknown,
      });
      await new Promise<void>((resolve) => resolvers.push(resolve));
      return new Response(
        JSON.stringify({
          inserted: 1,
          events: [{ event_id: `evt-browser-overlap-${requests.length}` }],
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener() {},
        removeEventListener() {},
      },
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: "https://app.example/dashboard" },
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    });
    globalThis.setInterval = (() =>
      0 as unknown as ReturnType<typeof setInterval>) as typeof setInterval;
    console.warn = () => {};

    const controller = initUniversalLogs({
      url: "http://collector.test",
      projectId: "project-browser",
      browserToken: "browser-token",
      sessionId: "session-browser",
      browserSpoolKey: spoolKey,
      maxBatchSize: 1,
      maxQueueSize: 3,
      flushIntervalMs: 60_000,
    });
    console.warn("first overlap event");
    await waitForRequestCount(requests, 1);
    console.warn("second overlap event");
    console.warn("third overlap event");
    await Promise.resolve();

    expect(requests).toHaveLength(1);
    expect(
      JSON.parse(storage.getItem(spoolKey) ?? "{}") as {
        events?: Array<{ message?: string }>;
      },
    ).toMatchObject({
      events: [
        { message: "first overlap event" },
        { message: "second overlap event" },
        { message: "third overlap event" },
      ],
    });

    resolvers.shift()?.();
    await waitForRequestCount(requests, 2);
    expect(requests[0]?.body).toMatchObject([
      { message: "first overlap event" },
    ]);
    expect(requests[1]?.body).toMatchObject([
      { message: "second overlap event" },
    ]);

    resolvers.shift()?.();
    await waitForRequestCount(requests, 3);
    expect(requests[2]?.body).toMatchObject([
      { message: "third overlap event" },
    ]);

    const finalFlush = controller?.flush();
    resolvers.shift()?.();
    await finalFlush;
    controller?.stop();
    expect(storage.getItem(spoolKey)).toBe(null);
  });

  it("keeps a failed in-flight browser flush batch when the spool is at capacity", async () => {
    const spoolKey = "open-logs-test-browser-failed-inflight-spool";
    const storage = createMemoryStorage();
    const requests: MockRequest[] = [];
    const resolvers: Array<() => void> = [];
    const statuses = [503, 201, 201, 201];
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const requestIndex = requests.length;
      requests.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body ?? "{}")) as unknown,
      });
      await new Promise<void>((resolve) => resolvers.push(resolve));
      const status = statuses[requestIndex] ?? 201;
      return new Response(
        JSON.stringify(
          status >= 400
            ? { error: "collector down" }
            : {
                inserted: 1,
                events: [{ event_id: `evt-browser-retry-${requestIndex}` }],
              },
        ),
        { status, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener() {},
        removeEventListener() {},
      },
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: "https://app.example/dashboard" },
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    });
    globalThis.setInterval = (() =>
      0 as unknown as ReturnType<typeof setInterval>) as typeof setInterval;
    console.warn = () => {};

    const controller = initUniversalLogs({
      url: "http://collector.test",
      projectId: "project-browser",
      browserToken: "browser-token",
      sessionId: "session-browser",
      browserSpoolKey: spoolKey,
      maxBatchSize: 1,
      maxQueueSize: 3,
      flushIntervalMs: 60_000,
    });
    console.warn("failed first event");
    await waitForRequestCount(requests, 1);
    console.warn("queued second event");
    console.warn("queued third event");

    resolvers.shift()?.();
    await waitForRequestCount(requests, 2);
    expect(requests[1]?.body).toMatchObject([
      { message: "failed first event" },
    ]);

    resolvers.shift()?.();
    await waitForRequestCount(requests, 3);
    expect(requests[2]?.body).toMatchObject([
      { message: "queued second event" },
    ]);

    resolvers.shift()?.();
    await waitForRequestCount(requests, 4);
    expect(requests[3]?.body).toMatchObject([
      { message: "queued third event" },
    ]);

    const finalFlush = controller?.flush();
    resolvers.shift()?.();
    await finalFlush;
    controller?.stop();
    expect(storage.getItem(spoolKey)).toBe(null);
  });

  it("redacts browser retry payloads after a failed live send", async () => {
    const spoolKey = "open-logs-test-browser-redacted-retry-spool";
    const secret = "OPENLOGS_SECRET_CANARY_browser_retry_12345";
    const storage = createMemoryStorage();
    const requests: MockRequest[] = [];
    const statuses = [503, 201];
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const requestIndex = requests.length;
      requests.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body ?? "{}")) as unknown,
      });
      const status = statuses[requestIndex] ?? 201;
      return new Response(
        JSON.stringify(
          status >= 400
            ? { error: "collector down" }
            : {
                inserted: 1,
                events: [
                  { event_id: `evt-browser-redacted-retry-${requestIndex}` },
                ],
              },
        ),
        { status, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener() {},
        removeEventListener() {},
      },
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: "https://app.example/dashboard?token=secret" },
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    });
    globalThis.setInterval = (() =>
      0 as unknown as ReturnType<typeof setInterval>) as typeof setInterval;
    console.warn = () => {};

    const controller = initUniversalLogs({
      url: "http://collector.test",
      projectId: "project-browser",
      browserToken: "browser-token",
      sessionId: "session-browser",
      browserSpoolKey: spoolKey,
      maxBatchSize: 1,
      flushIntervalMs: 60_000,
    });
    console.warn(`browser retry token=${secret}`);
    await waitForRequestCount(requests, 2);

    expect(JSON.stringify(requests[0]?.body)).toContain(secret);
    expect(JSON.stringify(requests[1]?.body)).toContain("[REDACTED]");
    expect(JSON.stringify(requests[1]?.body)).not.toContain(secret);
    expect(JSON.stringify(requests[1]?.body)).not.toContain("token=secret");

    controller?.stop();
    expect(storage.getItem(spoolKey)).toBe(null);
  });

  it("persists browser universal telemetry to a redacted localStorage spool and replays it after reload", async () => {
    const spoolKey = "open-logs-test-browser-spool";
    const storage = createMemoryStorage();
    const requests: MockRequest[] = [];
    let collectorUp = false;
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      requests.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(String(init?.body ?? "{}")) as unknown,
      });
      if (!collectorUp) {
        return new Response(JSON.stringify({ error: "collector down" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          inserted: 1,
          events: [{ event_id: "evt-browser-spool" }],
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener() {},
      },
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: "https://app.example/dashboard?token=secret" },
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    });
    globalThis.setInterval = (() =>
      0 as unknown as ReturnType<typeof setInterval>) as typeof setInterval;
    console.warn = () => {};

    const first = initUniversalLogs({
      url: "http://collector.test",
      projectId: "project-browser",
      browserToken: "browser-token",
      sessionId: "session-browser",
      browserSpool: true,
      browserSpoolKey: spoolKey,
      flushIntervalMs: 60_000,
    });
    console.warn("token=OPENLOGS_SECRET_CANARY_browser_spool_12345");
    await first?.flush();
    first?.stop();

    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]?.body)).toContain(
      "OPENLOGS_SECRET_CANARY_browser_spool_12345",
    );
    const spooled = storage.getItem(spoolKey) ?? "";
    expect(spooled).toContain("[REDACTED]");
    expect(spooled).not.toContain("OPENLOGS_SECRET_CANARY_browser_spool_12345");
    expect(spooled).not.toContain("token=secret");

    collectorUp = true;
    const reloaded = initUniversalLogs({
      url: "http://collector.test",
      projectId: "project-browser",
      browserToken: "browser-token",
      sessionId: "session-browser",
      browserSpoolKey: spoolKey,
      flushIntervalMs: 60_000,
    });
    await reloaded?.flush();
    reloaded?.stop();

    expect(requests).toHaveLength(2);
    expect(requests[1]?.headers["X-Logs-Browser-Token"]).toBe("browser-token");
    expect(requests[1]?.body).toMatchObject([
      {
        type: "log",
        severity: "warn",
        source: "browser",
        session_id: "session-browser",
        message: "token=[REDACTED]",
        attributes: { url: "https://app.example/dashboard?token=[REDACTED]" },
      },
    ]);
    expect(JSON.stringify(requests[1]?.body)).not.toContain("project-browser");
    expect(JSON.stringify(requests[1]?.body)).not.toContain(
      "OPENLOGS_SECRET_CANARY_browser_spool_12345",
    );
    expect(storage.getItem(spoolKey)).toBe(null);
  });

  it("clears corrupt and invalid-only browser universal spools without replaying them", async () => {
    const corruptKey = "open-logs-test-browser-corrupt-spool";
    const invalidKey = "open-logs-test-browser-invalid-only-spool";
    const storage = createMemoryStorage({ [corruptKey]: "{not-json" });
    const requests = mockFetch({
      response: {
        inserted: 1,
        events: [{ event_id: "evt-browser-should-not-send" }],
      },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener() {},
        removeEventListener() {},
      },
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: "https://app.example/current" },
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    });
    globalThis.setInterval = (() =>
      0 as unknown as ReturnType<typeof setInterval>) as typeof setInterval;

    const corruptController = initUniversalLogs({
      url: "http://collector.test",
      projectId: "project-browser",
      browserToken: "browser-token",
      browserSpoolKey: corruptKey,
      flushIntervalMs: 60_000,
    });
    await corruptController?.flush();
    corruptController?.stop();
    expect(storage.getItem(corruptKey)).toBe(null);

    storage.setItem(
      invalidKey,
      JSON.stringify({
        version: 1,
        events: [
          "poison",
          { type: "log", source: "node", message: "bad source" },
          {
            type: "log",
            source: "browser",
            project_id: "spoofed-project",
            message: "bad identity",
          },
          {
            type: "log",
            source: "browser",
            severity: "verbose",
            message: "bad severity",
          },
          {
            type: "log",
            source: "browser",
            event_time: "not-a-date",
            message: "bad timestamp",
          },
          {
            type: "log",
            source: "browser",
            body: "not-object",
            message: "bad body",
          },
          {
            type: "log",
            source: "browser",
            attributes: { machine_id: "nested-spoofed-machine" },
            message: "bad nested identity",
          },
        ],
      }),
    );

    const invalidController = initUniversalLogs({
      url: "http://collector.test",
      projectId: "project-browser",
      browserToken: "browser-token",
      browserSpoolKey: invalidKey,
      flushIntervalMs: 60_000,
    });
    await invalidController?.flush();
    invalidController?.stop();

    expect(requests).toHaveLength(0);
    expect(storage.getItem(invalidKey)).toBe(null);
  });

  it("skips invalid browser universal spool records while replaying valid telemetry", async () => {
    const spoolKey = "open-logs-test-browser-invalid-spool";
    const storage = createMemoryStorage({
      [spoolKey]: JSON.stringify({
        version: 1,
        events: [
          "poison",
          { type: "process", source: "browser", message: "bad type" },
          { type: "log", source: "node", message: "bad source" },
          {
            type: "log",
            source: "browser",
            project_id: "spoofed-project",
            message: "bad identity",
          },
          {
            type: "log",
            source: "browser",
            severity: "verbose",
            message: "bad severity",
          },
          {
            type: "log",
            source: "browser",
            timestamp: "not-a-date",
            message: "bad timestamp",
          },
          {
            type: "log",
            source: "browser",
            metadata: { run_id: "nested-spoofed-run" },
            message: "bad nested identity",
          },
          {
            type: "log",
            source: "browser",
            message: "valid token=OPENLOGS_SECRET_CANARY_browser_invalid_spool",
            attributes: {
              url: "https://app.example/?token=OPENLOGS_SECRET_CANARY_browser_invalid_spool",
            },
          },
        ],
      }),
    });
    const requests = mockFetch({
      response: {
        inserted: 1,
        events: [{ event_id: "evt-browser-valid-spool" }],
      },
    });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        addEventListener() {},
      },
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: "https://app.example/current" },
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: storage,
    });
    globalThis.setInterval = (() =>
      0 as unknown as ReturnType<typeof setInterval>) as typeof setInterval;

    const controller = initUniversalLogs({
      url: "http://collector.test",
      projectId: "project-browser",
      browserToken: "browser-token",
      browserSpoolKey: spoolKey,
      flushIntervalMs: 60_000,
    });
    await controller?.flush();
    controller?.stop();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject([
      {
        type: "log",
        source: "browser",
        message: "valid token=[REDACTED]",
        attributes: { url: "https://app.example/?token=[REDACTED]" },
      },
    ]);
    expect(JSON.stringify(requests[0]?.body)).not.toContain(
      "OPENLOGS_SECRET_CANARY_browser_invalid_spool",
    );
    expect(JSON.stringify(requests[0]?.body)).not.toContain("poison");
    expect(JSON.stringify(requests[0]?.body)).not.toContain("spoofed-project");
    expect(storage.getItem(spoolKey)).toBe(null);
  });

  it("captures Node console and process start telemetry through universal events", async () => {
    const requests = mockFetch({
      response: { inserted: 2, events: [{ event_id: "evt-process-1" }] },
    });
    console.warn = () => {};

    const controller = initNodeLogs({
      url: "http://collector.test",
      projectId: "project-node",
      source: "node",
      processId: "proc-test",
      runId: "run-test",
      captureFetch: false,
      captureExceptions: false,
      captureRejections: false,
      flushIntervalMs: 60_000,
    });

    expect(controller).toBeTruthy();
    console.warn("node warning", { route: "/health" });
    await controller?.flush();
    controller?.stop();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://collector.test/api/events");
    expect(requests[0]?.body).toMatchObject([
      {
        type: "process",
        source: "node",
        project_id: "project-node",
        process_id: "proc-test",
        run_id: "run-test",
        message: "Process started",
        attributes: {
          phase: "start",
          sdk_name: "@hasna/logs-sdk",
        },
      },
      {
        type: "log",
        severity: "warn",
        source: "node",
        project_id: "project-node",
        process_id: "proc-test",
        run_id: "run-test",
        message: 'node warning {"route":"/health"}',
        attributes: {
          console_method: "warn",
          sdk_name: "@hasna/logs-sdk",
        },
      },
    ]);
  });

  it("captures Node fetch calls as HTTP client spans without collector recursion", async () => {
    const requests = mockFetch({
      response: { inserted: 1, events: [{ event_id: "evt-fetch-1" }] },
    });

    const controller = initNodeLogs({
      url: "http://collector.test",
      projectId: "project-node",
      source: "node",
      processId: "proc-fetch",
      captureConsole: false,
      captureExceptions: false,
      captureFetch: true,
      captureProcess: false,
      captureRejections: false,
      flushIntervalMs: 60_000,
    });

    const response = await fetch("https://api.example.test/users", {
      method: "POST",
    });
    expect(response.status).toBe(201);
    const lookalikeResponse = await fetch("http://collector.test.evil/users");
    expect(lookalikeResponse.status).toBe(201);
    await controller?.flush();
    controller?.stop();

    expect(requests).toHaveLength(3);
    expect(requests[0]?.url).toBe("https://api.example.test/users");
    expect(requests[1]?.url).toBe("http://collector.test.evil/users");
    expect(requests[2]?.url).toBe("http://collector.test/api/events");
    expect(requests[2]?.body).toMatchObject([
      {
        type: "span",
        severity: "info",
        source: "node",
        project_id: "project-node",
        process_id: "proc-fetch",
        message: "POST https://api.example.test/users",
        body: {
          name: "POST https://api.example.test/users",
          operation: "http.client",
          status: "ok",
        },
        attributes: {
          method: "POST",
          url: "https://api.example.test/users",
          status_code: 201,
          ok: true,
          sdk_name: "@hasna/logs-sdk",
        },
      },
      {
        type: "span",
        severity: "info",
        source: "node",
        project_id: "project-node",
        process_id: "proc-fetch",
        message: "GET http://collector.test.evil/users",
        attributes: {
          method: "GET",
          url: "http://collector.test.evil/users",
        },
      },
    ]);
  });

  it("propagates opt-in Node fetch trace context", async () => {
    const requests = mockFetch({
      response: { inserted: 1, events: [{ event_id: "evt-fetch-trace-1" }] },
    });

    const controller = initNodeLogs({
      url: "http://collector.test",
      projectId: "project-node",
      source: "node",
      processId: "proc-fetch",
      captureConsole: false,
      captureExceptions: false,
      captureFetch: true,
      captureProcess: false,
      captureRejections: false,
      propagateTrace: true,
      flushIntervalMs: 60_000,
    });

    await fetch("https://api.example.test/users");
    await fetch("https://api.example.test/invalid-trace", {
      headers: { traceparent: "not-a-valid-traceparent" },
    });
    await fetch(
      new Request("https://api.example.test/request-invalid-trace", {
        headers: { traceparent: "bad-request-traceparent" },
      }),
    );
    await fetch("https://api.example.test/uppercase-trace", {
      headers: {
        traceparent: "00-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBB-01",
      },
    });
    await fetch(
      new Request("https://api.example.test/request-uppercase-trace", {
        headers: {
          traceparent:
            "00-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC-DDDDDDDDDDDDDDDD-01",
        },
      }),
    );
    await fetch("https://api.example.test/ff-version-trace", {
      headers: {
        traceparent: "ff-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-ffffffffffffffff-01",
      },
    });
    await fetch("https://api.example.test/duplicate-trace", {
      headers: [
        [
          "traceparent",
          "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01",
        ],
        ["traceparent", "not-valid"],
      ],
    });
    await controller?.flush();
    controller?.stop();

    expect(requests).toHaveLength(8);
    const traceparent = new Headers(requests[0]?.headers).get("traceparent");
    const propagated = traceparent?.match(
      /^00-([\da-f]{32})-([\da-f]{16})-01$/,
    );
    expect(propagated).toBeTruthy();
    if (!propagated) throw new Error("expected propagated traceparent");
    expect(new Headers(requests[1]?.headers).get("traceparent")).toBe(
      "not-a-valid-traceparent",
    );
    expect(new Headers(requests[2]?.headers).get("traceparent")).toBe(
      "bad-request-traceparent",
    );
    expect(new Headers(requests[3]?.headers).get("traceparent")).toBe(
      "00-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-BBBBBBBBBBBBBBBB-01",
    );
    expect(new Headers(requests[4]?.headers).get("traceparent")).toBe(
      "00-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC-DDDDDDDDDDDDDDDD-01",
    );
    expect(new Headers(requests[5]?.headers).get("traceparent")).toBe(
      "ff-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-ffffffffffffffff-01",
    );
    expect(new Headers(requests[6]?.headers).get("traceparent")).toBe(
      "00-cccccccccccccccccccccccccccccccc-dddddddddddddddd-01, not-valid",
    );
    expect(requests[7]?.body).toMatchObject([
      {
        type: "span",
        source: "node",
        project_id: "project-node",
        process_id: "proc-fetch",
        trace_id: propagated[1],
        span_id: propagated[2],
        message: "GET https://api.example.test/users",
        attributes: {
          operation: "http.client",
          url: "https://api.example.test/users",
          traceparent_propagated: true,
        },
      },
      {
        type: "span",
        source: "node",
        project_id: "project-node",
        process_id: "proc-fetch",
        message: "GET https://api.example.test/invalid-trace",
        attributes: {
          operation: "http.client",
          url: "https://api.example.test/invalid-trace",
          traceparent_existing: true,
        },
      },
      {
        type: "span",
        source: "node",
        project_id: "project-node",
        process_id: "proc-fetch",
        message: "GET https://api.example.test/request-invalid-trace",
        attributes: {
          operation: "http.client",
          url: "https://api.example.test/request-invalid-trace",
          traceparent_existing: true,
        },
      },
      {
        type: "span",
        source: "node",
        project_id: "project-node",
        process_id: "proc-fetch",
        message: "GET https://api.example.test/uppercase-trace",
        attributes: {
          operation: "http.client",
          url: "https://api.example.test/uppercase-trace",
          traceparent_existing: true,
        },
      },
      {
        type: "span",
        source: "node",
        project_id: "project-node",
        process_id: "proc-fetch",
        message: "GET https://api.example.test/request-uppercase-trace",
        attributes: {
          operation: "http.client",
          url: "https://api.example.test/request-uppercase-trace",
          traceparent_existing: true,
        },
      },
      {
        type: "span",
        source: "node",
        project_id: "project-node",
        process_id: "proc-fetch",
        message: "GET https://api.example.test/ff-version-trace",
        attributes: {
          operation: "http.client",
          url: "https://api.example.test/ff-version-trace",
          traceparent_existing: true,
        },
      },
      {
        type: "span",
        source: "node",
        project_id: "project-node",
        process_id: "proc-fetch",
        message: "GET https://api.example.test/duplicate-trace",
        attributes: {
          operation: "http.client",
          url: "https://api.example.test/duplicate-trace",
          traceparent_existing: true,
        },
      },
    ]);
    const body = requests[7]?.body as Array<{
      trace_id?: string;
      span_id?: string;
      attributes?: Record<string, unknown>;
    }>;
    expect(body[1]?.trace_id).toBeUndefined();
    expect(String(body[1]?.span_id).startsWith("span_")).toBe(true);
    expect(body[1]?.attributes?.traceparent_propagated).toBeUndefined();
    expect(body[2]?.trace_id).toBeUndefined();
    expect(String(body[2]?.span_id).startsWith("span_")).toBe(true);
    expect(body[2]?.attributes?.traceparent_propagated).toBeUndefined();
    expect(body[3]?.trace_id).toBeUndefined();
    expect(String(body[3]?.span_id).startsWith("span_")).toBe(true);
    expect(body[3]?.attributes?.traceparent_propagated).toBeUndefined();
    expect(body[4]?.trace_id).toBeUndefined();
    expect(String(body[4]?.span_id).startsWith("span_")).toBe(true);
    expect(body[4]?.attributes?.traceparent_propagated).toBeUndefined();
    expect(body[5]?.trace_id).toBeUndefined();
    expect(String(body[5]?.span_id).startsWith("span_")).toBe(true);
    expect(body[5]?.attributes?.traceparent_propagated).toBeUndefined();
    expect(body[6]?.trace_id).toBeUndefined();
    expect(String(body[6]?.span_id).startsWith("span_")).toBe(true);
    expect(body[6]?.attributes?.traceparent_propagated).toBeUndefined();
  });

  it("restores the exact fetch function and uses non-mutating fatal exception monitoring", () => {
    mockFetch();
    const originalPatchedFetch = globalThis.fetch;
    const beforeUncaught = process.listenerCount("uncaughtException");
    const beforeMonitor = process.listenerCount("uncaughtExceptionMonitor");
    const beforeUnhandledRejection =
      process.listenerCount("unhandledRejection");

    const controller = initNodeLogs({
      url: "http://collector.test",
      projectId: "project-node",
      source: "node",
      processId: "proc-restore",
      captureConsole: false,
      captureFetch: true,
      captureProcess: false,
      flushIntervalMs: 60_000,
    });

    expect(globalThis.fetch).not.toBe(originalPatchedFetch);
    expect(process.listenerCount("uncaughtException")).toBe(beforeUncaught);
    expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(
      beforeMonitor + 1,
    );
    expect(process.listenerCount("unhandledRejection")).toBe(
      beforeUnhandledRejection,
    );

    controller?.stop();

    expect(globalThis.fetch).toBe(originalPatchedFetch);
    expect(process.listenerCount("uncaughtException")).toBe(beforeUncaught);
    expect(process.listenerCount("uncaughtExceptionMonitor")).toBe(
      beforeMonitor,
    );
    expect(process.listenerCount("unhandledRejection")).toBe(
      beforeUnhandledRejection,
    );
  });

  it("wraps fetch-style request handlers as inbound HTTP server spans", async () => {
    const requests = mockFetch({
      response: { inserted: 1, events: [{ event_id: "evt-http-1" }] },
    });
    const handler = instrumentFetchHandler(
      async () => new Response("ok", { status: 201 }),
      {
        url: "http://collector.test",
        projectId: "project-web",
        source: "next",
        framework: "next",
        route: "/api/users/[id]",
        processId: "proc-web",
        runId: "run-web",
        requestHeaderNames: ["x-request-id"],
        responseHeaderNames: ["content-type"],
        waitForTelemetry: true,
      },
    );
    const response = await handler(
      new Request("https://app.example/api/users/42?token=secret", {
        headers: {
          traceparent:
            "00-0123456789abcdef0123456789abcdef-1111111111111111-01",
          "x-request-id": "req-1",
          authorization: "Bearer secret",
        },
      }),
    );

    expect(response.status).toBe(201);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({
      type: "span",
      source: "next",
      project_id: "project-web",
      process_id: "proc-web",
      run_id: "run-web",
      trace_id: "0123456789abcdef0123456789abcdef",
      parent_span_id: "1111111111111111",
      message: "GET /api/users/[id]",
      body: {
        name: "GET /api/users/[id]",
        operation: "http.server",
        status: "ok",
      },
      attributes: {
        method: "GET",
        route: "/api/users/[id]",
        framework: "next",
        status_code: 201,
        url_scheme: "https",
        url_host: "app.example",
        url_path: "/api/users/42",
        query_present: true,
        request_headers: { "x-request-id": "req-1" },
        sdk_name: "@hasna/logs-sdk",
      },
    });
    expect(JSON.stringify(requests[0]?.body)).not.toContain("secret");
    expect(JSON.stringify(requests[0]?.body)).not.toContain("authorization");
  });

  it("emits request exception telemetry and rethrows handler failures", async () => {
    const requests = mockFetch({
      response: { inserted: 2, events: [{ event_id: "evt-http-error-1" }] },
    });
    const handler = instrumentFetchHandler(
      async () => {
        throw new Error("route exploded");
      },
      {
        url: "http://collector.test",
        projectId: "project-web",
        source: "hono",
        framework: "hono",
        route: (request) => `/route${new URL(request.url).pathname}`,
        waitForTelemetry: true,
      },
    );

    await expect(
      handler(new Request("https://api.example.test/fail")),
    ).rejects.toThrow("route exploded");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject([
      {
        type: "span",
        severity: "error",
        source: "hono",
        message: "GET /route/fail",
        attributes: {
          operation: "http.server",
          method: "GET",
          route: "/route/fail",
          status_code: 500,
          error_type: "Error",
        },
      },
      {
        type: "exception",
        severity: "error",
        source: "hono",
        message: "route exploded",
        body: {
          exception: {
            type: "Error",
            value: "route exploded",
            handled: false,
            mechanism: "hono.request",
          },
        },
        attributes: {
          route: "/route/fail",
          method: "GET",
          framework: "hono",
        },
      },
    ]);
  });

  it("creates Hono-style middleware that captures route and response status", async () => {
    const requests = mockFetch({
      response: { inserted: 1, events: [{ event_id: "evt-hono-1" }] },
    });
    const middleware = createHonoTelemetryMiddleware({
      url: "http://collector.test",
      projectId: "project-hono",
      source: "hono",
      waitForTelemetry: true,
    });
    const context = {
      req: {
        raw: new Request("https://api.example.test/items/1", {
          method: "PATCH",
        }),
        routePath: "/*",
      },
      res: new Response("updated", { status: 204 }),
    };

    await middleware(context, async () => {
      context.req.routePath = "/items/:id";
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({
      type: "span",
      source: "hono",
      project_id: "project-hono",
      message: "PATCH /items/:id",
      attributes: {
        method: "PATCH",
        route: "/items/:id",
        framework: "hono",
        status_code: 204,
      },
    });
  });

  it("captures Node HTTP responses after finish with route templates and allowlisted headers", async () => {
    const requests = mockFetch({
      response: { inserted: 1, events: [{ event_id: "evt-node-http-1" }] },
    });
    const response = new MockNodeResponse(202, {
      "content-type": "application/json",
      "set-cookie": "session=secret",
    });
    const controller = captureNodeHttpRequest(
      {
        method: "POST",
        originalUrl: "/users/42?token=secret",
        baseUrl: "/api",
        route: { path: "/users/:id" },
        headers: {
          host: "app.example",
          traceparent:
            "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
          authorization: "Bearer secret",
          "x-request-id": "req-node-1",
        },
      },
      response,
      {
        url: "http://collector.test",
        projectId: "project-node-http",
        source: "express",
        framework: "express",
        requestHeaderNames: ["x-request-id"],
        responseHeaderNames: ["content-type"],
        waitForTelemetry: true,
      },
    );

    response.emit("finish");
    await controller.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({
      type: "span",
      source: "express",
      project_id: "project-node-http",
      trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      parent_span_id: "bbbbbbbbbbbbbbbb",
      message: "POST /api/users/:id",
      body: {
        name: "POST /api/users/:id",
        operation: "http.server",
        status: "ok",
      },
      attributes: {
        method: "POST",
        route: "/api/users/:id",
        framework: "express",
        status_code: 202,
        url_scheme: "http",
        url_host: "app.example",
        url_path: "/users/42",
        query_present: true,
        request_headers: { "x-request-id": "req-node-1" },
        response_headers: { "content-type": "application/json" },
      },
    });
    expect(JSON.stringify(requests[0]?.body)).not.toContain("secret");
    expect(JSON.stringify(requests[0]?.body)).not.toContain("authorization");
    expect(JSON.stringify(requests[0]?.body)).not.toContain("set-cookie");
  });

  it("creates Express-style middleware that resolves the route after downstream handlers", () => {
    const requests = mockFetch({
      response: { inserted: 1, events: [{ event_id: "evt-express-1" }] },
    });
    const middleware = createExpressTelemetryMiddleware({
      url: "http://collector.test",
      projectId: "project-express",
      source: "express",
      waitForTelemetry: true,
    });
    const request = {
      method: "GET",
      url: "/orders/12?debug=1",
      headers: { host: "web.example" },
      route: undefined as undefined | { path: string },
    };
    const response = new MockNodeResponse(204);

    middleware(request, response, () => {
      request.route = { path: "/orders/:id" };
      response.emit("finish");
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({
      type: "span",
      source: "express",
      project_id: "project-express",
      message: "GET /orders/:id",
      attributes: {
        method: "GET",
        route: "/orders/:id",
        framework: "express",
        status_code: 204,
        url_path: "/orders/12",
        query_present: true,
      },
    });
  });

  it("captures Express-style downstream errors through an error middleware pair", () => {
    const requests = mockFetch({
      response: { inserted: 2, events: [{ event_id: "evt-express-error" }] },
    });
    const opts = {
      url: "http://collector.test",
      projectId: "project-express",
      source: "express",
      waitForTelemetry: true,
    };
    const middleware = createExpressTelemetryMiddleware(opts);
    const errorMiddleware = createExpressErrorTelemetryMiddleware(opts);
    const request = {
      method: "PUT",
      url: "/accounts/55?token=secret",
      headers: { host: "web.example" },
      route: undefined as undefined | { path: string },
    };
    const response = new MockNodeResponse(200);
    const error = new Error("async route failed");
    let forwarded: unknown;

    middleware(request, response, () => {
      request.route = { path: "/accounts/:id" };
    });
    errorMiddleware(error, request, response, (nextError) => {
      forwarded = nextError;
    });

    expect(forwarded).toBe(error);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject([
      {
        type: "span",
        severity: "error",
        source: "express",
        project_id: "project-express",
        message: "PUT /accounts/:id",
        attributes: {
          method: "PUT",
          route: "/accounts/:id",
          framework: "express",
          status_code: 500,
          error_type: "Error",
          url_path: "/accounts/55",
          query_present: true,
        },
      },
      {
        type: "exception",
        severity: "error",
        source: "express",
        message: "async route failed",
        body: {
          exception: {
            type: "Error",
            value: "async route failed",
            handled: false,
            mechanism: "express.request",
          },
        },
      },
    ]);
    expect(JSON.stringify(requests[0]?.body)).not.toContain("secret");
  });

  it("falls back safely when Node HTTP host/url synthesis receives malformed input", async () => {
    const requests = mockFetch({
      response: {
        inserted: 1,
        events: [{ event_id: "evt-node-http-safe-url" }],
      },
    });
    const response = new MockNodeResponse(200);
    const controller = captureNodeHttpRequest(
      {
        method: "GET",
        url: "/safe?token=secret",
        headers: {
          host: "[::1",
          "x-forwarded-proto": "javascript",
        },
      },
      response,
      {
        url: "http://collector.test",
        projectId: "project-node-http",
        source: "express",
        framework: "express",
        waitForTelemetry: true,
      },
    );

    response.emit("finish");
    await controller.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({
      type: "span",
      source: "express",
      project_id: "project-node-http",
      message: "GET /safe",
      attributes: {
        method: "GET",
        route: "/safe",
        framework: "express",
        status_code: 200,
        url_scheme: "http",
        url_host: "localhost",
        url_path: "/safe",
        query_present: true,
      },
    });
    expect(JSON.stringify(requests[0]?.body)).not.toContain("secret");
  });

  it("rejects delimiter-bearing Node HTTP host values before URL synthesis", async () => {
    const requests = mockFetch({
      response: {
        inserted: 1,
        events: [{ event_id: "evt-node-http-delimiter-host" }],
      },
    });
    const response = new MockNodeResponse(200);
    const controller = captureNodeHttpRequest(
      {
        method: "GET",
        url: "/safe?token=secret",
        headers: {
          host: "example.com?token=secret",
        },
      },
      response,
      {
        url: "http://collector.test",
        projectId: "project-node-http",
        source: "express",
        framework: "express",
        waitForTelemetry: true,
      },
    );

    response.emit("finish");
    await controller.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({
      type: "span",
      source: "express",
      project_id: "project-node-http",
      message: "GET /safe",
      attributes: {
        method: "GET",
        route: "/safe",
        framework: "express",
        status_code: 200,
        url_host: "localhost",
        url_path: "/safe",
        query_present: true,
      },
    });
    expect(JSON.stringify(requests[0]?.body)).not.toContain("secret");
    expect(JSON.stringify(requests[0]?.body)).not.toContain("example.com");
  });

  it("emits Node HTTP exception telemetry when a request capture finishes with an error", async () => {
    const requests = mockFetch({
      response: { inserted: 2, events: [{ event_id: "evt-node-http-error" }] },
    });
    const response = new MockNodeResponse(200);
    const controller = captureNodeHttpRequest(
      {
        method: "PATCH",
        url: "/explode",
        headers: { host: "api.example" },
      },
      response,
      {
        url: "http://collector.test",
        projectId: "project-node-http",
        source: "express",
        framework: "express",
        route: "/explode",
        waitForTelemetry: true,
      },
    );

    controller.finish(new TypeError("handler failed"));
    await controller.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject([
      {
        type: "span",
        severity: "error",
        source: "express",
        message: "PATCH /explode",
        attributes: {
          method: "PATCH",
          route: "/explode",
          framework: "express",
          status_code: 500,
          error_type: "TypeError",
        },
      },
      {
        type: "exception",
        severity: "error",
        source: "express",
        message: "handler failed",
        body: {
          exception: {
            type: "TypeError",
            value: "handler failed",
            handled: false,
            mechanism: "express.request",
          },
        },
        attributes: {
          method: "PATCH",
          route: "/explode",
          framework: "express",
        },
      },
    ]);
  });

  it("captures Node HTTP response error events without waiting for finish", async () => {
    const requests = mockFetch({
      response: {
        inserted: 2,
        events: [{ event_id: "evt-node-response-error" }],
      },
    });
    const response = new MockNodeResponse(200);
    const errorMonitor = process.getBuiltinModule("node:events").errorMonitor;
    const controller = captureNodeHttpRequest(
      {
        method: "GET",
        url: "/response-error?token=secret",
        headers: { host: "api.example" },
      },
      response,
      {
        url: "http://collector.test",
        projectId: "project-node-http",
        source: "node",
        framework: "node-http",
        waitForTelemetry: true,
      },
    );

    expect(response.listenerCount("error")).toBe(0);
    expect(response.listenerCount(errorMonitor)).toBe(1);
    response.emit("error", new Error("response stream failed"));
    await controller.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject([
      {
        type: "span",
        severity: "error",
        source: "node",
        message: "GET /response-error",
        attributes: {
          method: "GET",
          route: "/response-error",
          framework: "node-http",
          status_code: 500,
          error_type: "Error",
          query_present: true,
        },
      },
      {
        type: "exception",
        severity: "error",
        source: "node",
        message: "response stream failed",
      },
    ]);
    expect(JSON.stringify(requests[0]?.body)).not.toContain("secret");
    expect(response.listenerCount(errorMonitor)).toBe(0);
    expect(response.listenerCount("finish")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
  });

  it("captures Node HTTP request error events without waiting for finish", async () => {
    const requests = mockFetch({
      response: {
        inserted: 2,
        events: [{ event_id: "evt-node-request-error" }],
      },
    });
    const request = new MockNodeRequest({
      method: "POST",
      url: "/request-error?token=secret",
      headers: { host: "api.example" },
    });
    const response = new MockNodeResponse(200);
    const errorMonitor = process.getBuiltinModule("node:events").errorMonitor;
    const controller = captureNodeHttpRequest(request, response, {
      url: "http://collector.test",
      projectId: "project-node-http",
      source: "node",
      framework: "node-http",
      waitForTelemetry: true,
    });

    expect(request.listenerCount("error")).toBe(0);
    expect(request.listenerCount(errorMonitor)).toBe(1);
    request.emit("error", new TypeError("request parser failed"));
    await controller.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject([
      {
        type: "span",
        severity: "error",
        source: "node",
        message: "POST /request-error",
        attributes: {
          method: "POST",
          route: "/request-error",
          framework: "node-http",
          status_code: 500,
          error_type: "TypeError",
          query_present: true,
        },
      },
      {
        type: "exception",
        severity: "error",
        source: "node",
        message: "request parser failed",
        body: {
          exception: {
            type: "TypeError",
            value: "request parser failed",
            handled: false,
            mechanism: "node-http.request",
          },
        },
      },
    ]);
    expect(JSON.stringify(requests[0]?.body)).not.toContain("secret");
    expect(request.listenerCount(errorMonitor)).toBe(0);
    expect(request.listenerCount("aborted")).toBe(0);
    expect(response.listenerCount("finish")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
  });

  it("captures Node HTTP request aborts as closed-response spans", async () => {
    const requests = mockFetch({
      response: {
        inserted: 1,
        events: [{ event_id: "evt-node-request-aborted" }],
      },
    });
    const request = new MockNodeRequest({
      method: "GET",
      url: "/aborted?token=secret",
      headers: { host: "api.example" },
    });
    const response = new MockNodeResponse(200);
    const controller = captureNodeHttpRequest(request, response, {
      url: "http://collector.test",
      projectId: "project-node-http",
      source: "node",
      framework: "node-http",
      waitForTelemetry: true,
    });

    expect(request.listenerCount("aborted")).toBe(1);
    request.emit("aborted");
    await controller.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({
      type: "span",
      severity: "error",
      source: "node",
      project_id: "project-node-http",
      message: "GET /aborted",
      attributes: {
        method: "GET",
        route: "/aborted",
        framework: "node-http",
        status_code: 499,
        error_type: "ResponseClosedError",
        query_present: true,
      },
    });
    expect(JSON.stringify(requests[0]?.body)).not.toContain("secret");
    expect(request.listenerCount("aborted")).toBe(0);
    expect(response.listenerCount("finish")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
  });

  it("creates Fastify-style hooks that preserve route templates and reply status", () => {
    const requests = mockFetch({
      response: { inserted: 1, events: [{ event_id: "evt-fastify-1" }] },
    });
    const hooks = createFastifyTelemetryHooks({
      url: "http://collector.test",
      projectId: "project-fastify",
      source: "fastify",
      waitForTelemetry: true,
    });
    const rawResponse = new MockNodeResponse(503);
    const request = {
      raw: {
        method: "DELETE",
        url: "/fast/99?token=secret",
        headers: { host: "api.example" },
      },
      routeOptions: { url: "/fast/:id" },
    };
    const reply = {
      raw: rawResponse,
      statusCode: 503,
    };
    let doneCount = 0;

    hooks.onRequest(request, reply, () => {
      doneCount += 1;
    });
    hooks.onResponse(request, reply, () => {
      doneCount += 1;
    });

    expect(doneCount).toBe(2);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.body).toMatchObject({
      type: "span",
      source: "fastify",
      project_id: "project-fastify",
      message: "DELETE /fast/:id",
      attributes: {
        method: "DELETE",
        route: "/fast/:id",
        framework: "fastify",
        status_code: 503,
        url_path: "/fast/99",
        query_present: true,
      },
    });
    expect(JSON.stringify(requests[0]?.body)).not.toContain("secret");
  });
});

interface MockFetchOptions {
  status?: number;
  statuses?: number[];
  response?: unknown;
  responses?: unknown[];
}

interface MockRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

class MockNodeRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | number | undefined>;
  private listeners = new Map<
    string | symbol,
    Set<(...args: unknown[]) => void>
  >();

  constructor(
    opts: {
      method?: string;
      url?: string;
      headers?: Record<string, string | string[] | number | undefined>;
    } = {},
  ) {
    this.method = opts.method ?? "GET";
    this.url = opts.url ?? "/";
    this.headers = opts.headers ?? {};
  }

  on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener);
    return this;
  }

  once(event: string | symbol, listener: (...args: unknown[]) => void): this {
    const onceListener = (...args: unknown[]) => {
      this.removeListener(event, onceListener);
      listener(...args);
    };
    return this.on(event, onceListener);
  }

  off(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return this.removeListener(event, listener);
  }

  removeListener(
    event: string | symbol,
    listener: (...args: unknown[]) => void,
  ): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string | symbol, ...args: unknown[]): void {
    if (event === "error") this.emitErrorMonitor(...args);
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener(...args);
    }
  }

  listenerCount(event: string | symbol): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  private emitErrorMonitor(...args: unknown[]): void {
    const monitor = process.getBuiltinModule("node:events").errorMonitor;
    for (const listener of [...(this.listeners.get(monitor) ?? [])]) {
      listener(...args);
    }
  }
}

class MockNodeResponse {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  private listeners = new Map<
    string | symbol,
    Set<(...args: unknown[]) => void>
  >();

  constructor(
    statusCode = 200,
    headers: Record<string, string | string[] | number | undefined> = {},
  ) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  getHeader(name: string): string | string[] | number | undefined {
    const lowerName = name.toLowerCase();
    for (const [headerName, value] of Object.entries(this.headers)) {
      if (headerName.toLowerCase() === lowerName) return value;
    }
    return undefined;
  }

  on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener);
    return this;
  }

  once(event: string | symbol, listener: (...args: unknown[]) => void): this {
    const onceListener = (...args: unknown[]) => {
      this.removeListener(event, onceListener);
      listener(...args);
    };
    return this.on(event, onceListener);
  }

  off(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return this.removeListener(event, listener);
  }

  removeListener(
    event: string | symbol,
    listener: (...args: unknown[]) => void,
  ): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string | symbol, ...args: unknown[]): void {
    if (event === "error") this.emitErrorMonitor(...args);
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener(...args);
    }
  }

  listenerCount(event: string | symbol): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  private emitErrorMonitor(...args: unknown[]): void {
    const monitor = process.getBuiltinModule("node:events").errorMonitor;
    for (const listener of [...(this.listeners.get(monitor) ?? [])]) {
      listener(...args);
    }
  }
}

function mockFetch(opts: MockFetchOptions = {}): MockRequest[] {
  const requests: MockRequest[] = [];
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const requestIndex = requests.length;
    const headers = (init?.headers ??
      (typeof Request !== "undefined" && input instanceof Request
        ? input.headers
        : undefined)) as Record<string, string>;
    requests.push({
      url:
        typeof Request !== "undefined" && input instanceof Request
          ? input.url
          : String(input),
      headers,
      body: JSON.parse(String(init?.body ?? "{}")) as unknown,
    });
    const response = opts.responses?.[requestIndex] ??
      opts.response ?? {
        event_id: "evt-test",
        event_type: "metric",
        metadata: null,
      };
    return new Response(JSON.stringify(response), {
      status: opts.statuses?.[requestIndex] ?? opts.status ?? 201,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return requests;
}

function createMemoryStorage(initial: Record<string, string> = {}): {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
} {
  const store = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return store.get(key) ?? null;
    },
    setItem(key, value) {
      store.set(key, value);
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

async function waitForRequestCount(
  requests: MockRequest[],
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (requests.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${count} request(s)`);
}

function restoreGlobal(
  name: string,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    delete (globalThis as Record<string, unknown>)[name];
  }
}
