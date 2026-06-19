import { describe, expect, it } from "bun:test";
import { createTestDb } from "../db/index.ts";
import { readRawEvent } from "./event-store.ts";
import { getEvent, searchEvents } from "./events.ts";
import {
  ingestOtlpLogs,
  ingestOtlpMetrics,
  ingestOtlpTraces,
} from "./otlp-ingest.ts";

describe("OTLP ingest", () => {
  it("maps OTLP spans into raw-backed span events and projections", () => {
    const db = createTestDb();
    const secret = "OPENLOGS_SECRET_CANARY_otlp_span_12345";

    const result = ingestOtlpTraces(db, {
      resourceSpans: [
        {
          resource: {
            attributes: [
              attr("service.name", { stringValue: "checkout-api" }),
              attr("deployment.environment", { stringValue: "test" }),
              attr("host.id", { stringValue: "host-1" }),
              attr("process.pid", { intValue: "4242" }),
            ],
          },
          scopeSpans: [
            {
              scope: {
                name: "otel-http",
                version: "1.0.0",
                attributes: [attr("instrumentation", { stringValue: "hono" })],
              },
              spans: [
                {
                  traceId: "0123456789abcdef0123456789abcdef",
                  spanId: "0123456789abcdef",
                  parentSpanId: "1111111111111111",
                  name: "POST /checkout",
                  kind: "SPAN_KIND_SERVER",
                  startTimeUnixNano: unixNano("2026-06-16T08:00:00.000Z"),
                  endTimeUnixNano: unixNano("2026-06-16T08:00:00.025Z"),
                  status: {
                    code: "STATUS_CODE_ERROR",
                    message: `failed token=${secret}`,
                  },
                  attributes: [
                    attr("http.route", { stringValue: "/checkout" }),
                    attr("secret.token", { stringValue: secret }),
                  ],
                  events: [
                    {
                      name: "exception",
                      timeUnixNano: unixNano("2026-06-16T08:00:00.020Z"),
                      attributes: [
                        attr("exception.message", {
                          stringValue: `boom ${secret}`,
                        }),
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(result.accepted).toBe(1);
    expect(result.inserted).toBe(1);
    expect(result.events[0]).toMatchObject({
      event_type: "span",
      source: "otel",
      severity: "error",
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: "0123456789abcdef",
      app_id: "checkout-api",
      machine_id: "host-1",
      environment: "test",
    });
    expect(result.events[0]?.process_id).toBeNull();

    const event = getEvent(db, result.events[0]?.event_id ?? "", true);
    expect(event?.raw?.message).toBe("POST /checkout");
    expect(event?.raw?.attributes?.resource).toMatchObject({
      "service.name": "checkout-api",
      "process.pid": 4242,
    });
    expect(event?.raw?.attributes?.scope).toMatchObject({
      name: "otel-http",
      version: "1.0.0",
    });
    expect(
      JSON.stringify(readRawEvent(db, result.events[0]?.event_id ?? "")),
    ).not.toContain(secret);
    expect(JSON.stringify(event?.raw)).toContain("[REDACTED]");

    const span = db
      .prepare(
        "SELECT trace_id, parent_span_id, operation, status, duration_ms FROM spans WHERE id = ?",
      )
      .get("0123456789abcdef") as {
      trace_id: string;
      parent_span_id: string;
      operation: string;
      status: string;
      duration_ms: number;
    } | null;
    expect(span).toEqual({
      trace_id: "0123456789abcdef0123456789abcdef",
      parent_span_id: "1111111111111111",
      operation: "/checkout",
      status: "error",
      duration_ms: 25,
    });
    const process = db
      .prepare("SELECT id FROM processes WHERE id = ?")
      .get("4242");
    expect(process).toBeNull();
  });

  it("maps OTLP logs with severity and deterministic retry deduplication", () => {
    const db = createTestDb();
    const secret = "OPENLOGS_SECRET_CANARY_otlp_log_12345";
    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              attr("service.name", { stringValue: "worker" }),
              attr("deployment.environment", { stringValue: "prod" }),
            ],
          },
          scopeLogs: [
            {
              scope: { name: "console" },
              logRecords: [
                {
                  timeUnixNano: unixNano("2026-06-16T08:01:00.000Z"),
                  observedTimeUnixNano: unixNano("2026-06-16T08:01:01.000Z"),
                  severityNumber: 17,
                  severityText: "ERROR",
                  traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  spanId: "bbbbbbbbbbbbbbbb",
                  body: { stringValue: `background job failed ${secret}` },
                  attributes: [attr("api.key", { stringValue: secret })],
                },
              ],
            },
          ],
        },
      ],
    };

    const first = ingestOtlpLogs(db, payload);
    const second = ingestOtlpLogs(db, payload);

    expect(first).toMatchObject({ accepted: 1, inserted: 1, duplicates: 0 });
    expect(second).toMatchObject({ accepted: 1, inserted: 0, duplicates: 1 });
    expect(first.events[0]).toMatchObject({
      event_type: "log",
      source: "otel",
      severity: "error",
      trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      span_id: "bbbbbbbbbbbbbbbb",
      app_id: "worker",
      environment: "prod",
    });

    const raw = readRawEvent(db, first.events[0]?.event_id ?? "");
    expect(JSON.stringify(raw)).not.toContain(secret);
    expect(JSON.stringify(raw)).toContain("[REDACTED]");
    expect(
      searchEvents(db, {
        event_type: "log",
        source: "otel",
        trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
    ).toHaveLength(1);
  });

  it("keeps identical logs and metrics from different resources distinct", () => {
    const db = createTestDb();
    const logRecord = {
      timeUnixNano: unixNano("2026-06-16T08:01:30.000Z"),
      severityText: "INFO",
      body: { stringValue: "same log" },
    };
    const logPayload = {
      resourceLogs: [
        resourceLogs("svc-a", "logger", [logRecord]),
        resourceLogs("svc-b", "logger", [logRecord]),
      ],
    };

    const firstLogs = ingestOtlpLogs(db, logPayload);
    const retriedLogs = ingestOtlpLogs(db, logPayload);

    expect(firstLogs).toMatchObject({
      accepted: 2,
      inserted: 2,
      duplicates: 0,
    });
    expect(retriedLogs).toMatchObject({
      accepted: 2,
      inserted: 0,
      duplicates: 2,
    });
    expect(
      searchEvents(db, { event_type: "log", source: "otel", text: "same log" })
        .map((event) => event.app_id)
        .sort(),
    ).toEqual(["svc-a", "svc-b"]);

    const metricPoint = {
      timeUnixNano: unixNano("2026-06-16T08:01:31.000Z"),
      asInt: "7",
    };
    const metricPayload = {
      resourceMetrics: [
        resourceMetrics("svc-a", "runtime", [
          {
            name: "same.metric",
            gauge: { dataPoints: [metricPoint] },
          },
        ]),
        resourceMetrics("svc-b", "runtime", [
          {
            name: "same.metric",
            gauge: { dataPoints: [metricPoint] },
          },
        ]),
      ],
    };

    const metrics = ingestOtlpMetrics(db, metricPayload);
    expect(metrics).toMatchObject({ accepted: 2, inserted: 2, duplicates: 0 });
    expect(
      searchEvents(db, {
        event_type: "metric",
        source: "otel",
        text: "same.metric",
      })
        .map((event) => event.app_id)
        .sort(),
    ).toEqual(["svc-a", "svc-b"]);
  });

  it("keeps same-resource log records distinct when severity or ordinal differs", () => {
    const db = createTestDb();
    const payload = {
      resourceLogs: [
        resourceLogs("same-svc", "logger", [
          {
            timeUnixNano: unixNano("2026-06-16T08:01:40.000Z"),
            severityText: "INFO",
            body: { stringValue: "same body" },
          },
          {
            timeUnixNano: unixNano("2026-06-16T08:01:40.000Z"),
            severityText: "ERROR",
            body: { stringValue: "same body" },
          },
        ]),
      ],
    };

    const first = ingestOtlpLogs(db, payload);
    const retry = ingestOtlpLogs(db, payload);

    expect(first).toMatchObject({ accepted: 2, inserted: 2, duplicates: 0 });
    expect(retry).toMatchObject({ accepted: 2, inserted: 0, duplicates: 2 });
    expect(
      searchEvents(db, { event_type: "log", source: "otel", text: "same body" })
        .map((event) => event.severity)
        .sort(),
    ).toEqual(["error", "info"]);
  });

  it("maps OTLP gauge and histogram datapoints into metric events", () => {
    const db = createTestDb();

    const result = ingestOtlpMetrics(db, {
      resourceMetrics: [
        {
          resource: {
            attributes: [attr("service.name", { stringValue: "web" })],
          },
          scopeMetrics: [
            {
              scope: { name: "runtime" },
              metrics: [
                {
                  name: "http.server.duration",
                  description: "request duration",
                  unit: "ms",
                  gauge: {
                    dataPoints: [
                      {
                        timeUnixNano: unixNano("2026-06-16T08:02:00.000Z"),
                        asDouble: 12.5,
                        attributes: [
                          attr("http.route", { stringValue: "/api" }),
                        ],
                      },
                    ],
                  },
                },
                {
                  name: "queue.depth",
                  unit: "items",
                  histogram: {
                    aggregationTemporality:
                      "AGGREGATION_TEMPORALITY_CUMULATIVE",
                    dataPoints: [
                      {
                        startTimeUnixNano: unixNano("2026-06-16T08:00:00.000Z"),
                        timeUnixNano: unixNano("2026-06-16T08:02:00.000Z"),
                        count: "3",
                        sum: 21,
                        bucketCounts: ["1", "2"],
                        explicitBounds: [10],
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    });

    expect(result.accepted).toBe(2);
    expect(result.inserted).toBe(2);

    const metrics = searchEvents(db, {
      event_type: "metric",
      source: "otel",
      include_raw: true,
    });
    expect(metrics).toHaveLength(2);
    expect(metrics.map((event) => event.message).sort()).toEqual([
      "http.server.duration",
      "queue.depth",
    ]);
    const gauge = metrics.find(
      (event) => event.message === "http.server.duration",
    );
    expect(gauge?.raw?.body?.metric).toMatchObject({
      kind: "gauge",
      value: 12.5,
      unit: "ms",
    });
    const histogram = metrics.find((event) => event.message === "queue.depth");
    expect(histogram?.raw?.body?.metric).toMatchObject({
      kind: "histogram",
      value: {
        count: 3,
        sum: 21,
        bucket_counts: ["1", "2"],
        explicit_bounds: [10],
      },
    });
  });

  it("rejects payloads that are not the expected OTLP signal shape", () => {
    const db = createTestDb();
    expect(() => ingestOtlpTraces(db, { resourceLogs: [] })).toThrow(
      "payload.resourceSpans must be an array",
    );
    expect(() => ingestOtlpLogs(db, { resourceSpans: [] })).toThrow(
      "payload.resourceLogs must be an array",
    );
    expect(() => ingestOtlpMetrics(db, { resourceMetrics: "bad" })).toThrow(
      "payload.resourceMetrics must be an array",
    );
    expect(() =>
      ingestOtlpTraces(db, { resourceSpans: [{ scopeSpans: "bad" }] }),
    ).toThrow("payload.resourceSpans[].scopeSpans must be an array");
    expect(() =>
      ingestOtlpLogs(db, {
        resourceLogs: [{ scopeLogs: [{ logRecords: ["bad"] }] }],
      }),
    ).toThrow(
      "payload.resourceLogs[].scopeLogs[].logRecords[0] must be an object",
    );
    expect(() =>
      ingestOtlpMetrics(db, {
        resourceMetrics: [
          {
            scopeMetrics: [
              {
                metrics: [{ name: "bad", gauge: { dataPoints: "bad" } }],
              },
            ],
          },
        ],
      }),
    ).toThrow("metric.gauge.dataPoints must be an array");
    expect(() =>
      ingestOtlpMetrics(db, {
        resourceMetrics: [
          {
            scopeMetrics: [{ metrics: [{ name: "bad", gauge: "bad" }] }],
          },
        ],
      }),
    ).toThrow("metric.gauge must be an object");
    expect(() =>
      ingestOtlpMetrics(db, {
        resourceMetrics: [
          {
            scopeMetrics: [{ metrics: [{ name: "bad" }] }],
          },
        ],
      }),
    ).toThrow(
      "metric must contain one of gauge, sum, histogram, exponentialHistogram, summary",
    );
  });
});

function attr(key: string, value: Record<string, unknown>) {
  return { key, value };
}

function resourceLogs(
  serviceName: string,
  scopeName: string,
  logRecords: unknown[],
) {
  return {
    resource: {
      attributes: [attr("service.name", { stringValue: serviceName })],
    },
    scopeLogs: [{ scope: { name: scopeName }, logRecords }],
  };
}

function resourceMetrics(
  serviceName: string,
  scopeName: string,
  metrics: unknown[],
) {
  return {
    resource: {
      attributes: [attr("service.name", { stringValue: serviceName })],
    },
    scopeMetrics: [{ scope: { name: scopeName }, metrics }],
  };
}

function unixNano(iso: string): string {
  return String(BigInt(new Date(iso).getTime()) * 1_000_000n);
}
