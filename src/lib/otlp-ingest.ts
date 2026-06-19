import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { EventCatalogEntry } from "./events.ts";
import {
  type UniversalEventInput,
  ingestUniversalEvent,
} from "./universal-ingest.ts";

export type OtlpSignal = "traces" | "logs" | "metrics";

export interface OtlpIngestSummary {
  signal: OtlpSignal;
  accepted: number;
  inserted: number;
  duplicates: number;
  events: EventCatalogEntry[];
}

type JsonObject = Record<string, unknown>;

interface OtlpContext {
  resource: JsonObject;
  scope: JsonObject;
  resourceIndex: number;
  scopeIndex: number;
}

export function ingestOtlpTraces(
  db: Database,
  payload: unknown,
): OtlpIngestSummary {
  const events: UniversalEventInput[] = [];
  for (const [resourceIndex, resourceSpan] of requiredObjectArray(
    payload,
    "resourceSpans",
    "payload.resourceSpans",
  ).entries()) {
    const resource = attributesFromContainer(resourceSpan.resource);
    for (const [scopeIndex, scopeSpan] of objectArray(
      resourceSpan.scopeSpans,
      "payload.resourceSpans[].scopeSpans",
    ).entries()) {
      const scope = scopeInfo(scopeSpan.scope);
      const context = { resource, scope, resourceIndex, scopeIndex };
      for (const span of objectArray(
        scopeSpan.spans,
        "payload.resourceSpans[].scopeSpans[].spans",
      )) {
        events.push(spanToEvent(span, context));
      }
    }
  }
  return ingestOtlpEvents(db, "traces", events);
}

export function ingestOtlpLogs(
  db: Database,
  payload: unknown,
): OtlpIngestSummary {
  const events: UniversalEventInput[] = [];
  for (const [resourceIndex, resourceLog] of requiredObjectArray(
    payload,
    "resourceLogs",
    "payload.resourceLogs",
  ).entries()) {
    const resource = attributesFromContainer(resourceLog.resource);
    for (const [scopeIndex, scopeLog] of objectArray(
      resourceLog.scopeLogs,
      "payload.resourceLogs[].scopeLogs",
    ).entries()) {
      const scope = scopeInfo(scopeLog.scope);
      const context = { resource, scope, resourceIndex, scopeIndex };
      for (const [recordIndex, logRecord] of objectArray(
        scopeLog.logRecords,
        "payload.resourceLogs[].scopeLogs[].logRecords",
      ).entries()) {
        events.push(logRecordToEvent(logRecord, context, recordIndex));
      }
    }
  }
  return ingestOtlpEvents(db, "logs", events);
}

export function ingestOtlpMetrics(
  db: Database,
  payload: unknown,
): OtlpIngestSummary {
  const events: UniversalEventInput[] = [];
  for (const [resourceIndex, resourceMetric] of requiredObjectArray(
    payload,
    "resourceMetrics",
    "payload.resourceMetrics",
  ).entries()) {
    const resource = attributesFromContainer(resourceMetric.resource);
    for (const [scopeIndex, scopeMetric] of objectArray(
      resourceMetric.scopeMetrics,
      "payload.resourceMetrics[].scopeMetrics",
    ).entries()) {
      const scope = scopeInfo(scopeMetric.scope);
      const context = { resource, scope, resourceIndex, scopeIndex };
      for (const [metricIndex, metric] of objectArray(
        scopeMetric.metrics,
        "payload.resourceMetrics[].scopeMetrics[].metrics",
      ).entries()) {
        events.push(...metricToEvents(metric, context, metricIndex));
      }
    }
  }
  return ingestOtlpEvents(db, "metrics", events);
}

function ingestOtlpEvents(
  db: Database,
  signal: OtlpSignal,
  inputs: UniversalEventInput[],
): OtlpIngestSummary {
  const events: EventCatalogEntry[] = [];
  let inserted = 0;
  for (const input of inputs) {
    const result = ingestUniversalEvent(db, input);
    if (result.inserted) inserted += 1;
    events.push(result.event);
  }
  return {
    signal,
    accepted: inputs.length,
    inserted,
    duplicates: inputs.length - inserted,
    events,
  };
}

function spanToEvent(
  span: JsonObject,
  context: OtlpContext,
): UniversalEventInput {
  const attributes = attributesFromArray(span.attributes);
  const traceId = optionalString(span.traceId);
  const spanId = optionalString(span.spanId);
  const parentSpanId = optionalString(span.parentSpanId);
  const startTime = unixNanoToIso(span.startTimeUnixNano);
  const endTime = unixNanoToIso(span.endTimeUnixNano);
  const spanDurationMs = durationMs(
    span.startTimeUnixNano,
    span.endTimeUnixNano,
  );
  const status = objectValue(span.status);
  const statusCode =
    optionalString(status?.code) ?? stringFromUnknown(status?.code);
  const isError =
    statusCode === "2" ||
    statusCode === "STATUS_CODE_ERROR" ||
    statusCode === "ERROR";
  const name = optionalString(span.name) ?? "OTLP span";
  const spanKind = optionalString(span.kind) ?? stringFromUnknown(span.kind);

  return {
    type: "span",
    source: "otel",
    source_event_id:
      traceId && spanId
        ? `otlp:span:${traceId}:${spanId}`
        : stableSourceEventId("span", span),
    event_time: startTime,
    severity: isError ? "error" : "info",
    trace_id: traceId,
    span_id: spanId,
    parent_span_id: parentSpanId,
    app_id: resourceString(context.resource, "service.name"),
    machine_id:
      resourceString(context.resource, "host.id") ??
      resourceString(context.resource, "host.name"),
    environment: resourceString(context.resource, "deployment.environment"),
    message: name,
    attributes: compactObject({
      category: "otlp_span",
      signal: "traces",
      name,
      operation:
        attributes["http.route"] ??
        attributes["rpc.method"] ??
        attributes["db.operation.name"] ??
        spanKind,
      status: isError ? "error" : "ok",
      started_at: startTime,
      ended_at: endTime,
      duration_ms: spanDurationMs,
      resource: context.resource,
      scope: context.scope,
      span_attributes: attributes,
      otel: compactObject({
        signal: "traces",
        span_kind: spanKind,
        status_code: statusCode,
        status_message: optionalString(status?.message),
        dropped_attributes_count: numberFromUnknown(
          span.droppedAttributesCount,
        ),
        dropped_events_count: numberFromUnknown(span.droppedEventsCount),
        dropped_links_count: numberFromUnknown(span.droppedLinksCount),
        start_time_unix_nano: stringFromUnknown(span.startTimeUnixNano),
        end_time_unix_nano: stringFromUnknown(span.endTimeUnixNano),
      }),
    }),
    body: {
      span: compactObject({
        name,
        kind: spanKind,
        status,
        events: spanEvents(span.events),
        links: spanLinks(span.links),
      }),
    },
  };
}

function logRecordToEvent(
  logRecord: JsonObject,
  context: OtlpContext,
  recordIndex: number,
): UniversalEventInput {
  const attributes = attributesFromArray(logRecord.attributes);
  const body = otlpAnyValue(logRecord.body);
  const traceId = optionalString(logRecord.traceId);
  const spanId = optionalString(logRecord.spanId);
  const severityNumber = numberFromUnknown(logRecord.severityNumber);
  const severityText = optionalString(logRecord.severityText);
  const eventTime =
    unixNanoToIso(logRecord.timeUnixNano) ??
    unixNanoToIso(logRecord.observedTimeUnixNano);
  const message =
    typeof body === "string"
      ? body
      : severityText
        ? `OTLP ${severityText} log`
        : "OTLP log";

  return {
    type: "log",
    source: "otel",
    source_event_id: stableSourceEventId("log", {
      traceId,
      spanId,
      timeUnixNano: logRecord.timeUnixNano,
      observedTimeUnixNano: logRecord.observedTimeUnixNano,
      severityNumber,
      severityText,
      resourceIndex: context.resourceIndex,
      scopeIndex: context.scopeIndex,
      recordIndex,
      resource: context.resource,
      scope: context.scope,
      body,
      attributes,
    }),
    event_time: eventTime,
    severity: otlpSeverity(severityNumber, severityText),
    trace_id: traceId,
    span_id: spanId,
    app_id: resourceString(context.resource, "service.name"),
    machine_id:
      resourceString(context.resource, "host.id") ??
      resourceString(context.resource, "host.name"),
    environment: resourceString(context.resource, "deployment.environment"),
    message,
    attributes: compactObject({
      category: "otlp_log",
      signal: "logs",
      resource: context.resource,
      scope: context.scope,
      log_attributes: attributes,
      otel: compactObject({
        signal: "logs",
        severity_number: severityNumber,
        severity_text: severityText,
        time_unix_nano: stringFromUnknown(logRecord.timeUnixNano),
        observed_time_unix_nano: stringFromUnknown(
          logRecord.observedTimeUnixNano,
        ),
        dropped_attributes_count: numberFromUnknown(
          logRecord.droppedAttributesCount,
        ),
        flags: numberFromUnknown(logRecord.flags),
      }),
    }),
    body: {
      log: compactObject({
        body,
        severity_number: severityNumber,
        severity_text: severityText,
      }),
    },
  };
}

function metricToEvents(
  metric: JsonObject,
  context: OtlpContext,
  metricIndex: number,
): UniversalEventInput[] {
  const name = optionalString(metric.name) ?? "otel.metric";
  const description = optionalString(metric.description);
  const unit = optionalString(metric.unit);
  const points = metricPoints(metric);
  return points.dataPoints.map((point, index) => {
    const attributes = attributesFromArray(point.attributes);
    const eventTime =
      unixNanoToIso(point.timeUnixNano) ??
      unixNanoToIso(point.startTimeUnixNano);
    return {
      type: "metric",
      source: "otel",
      source_event_id: stableSourceEventId("metric", {
        name,
        kind: points.kind,
        index,
        startTimeUnixNano: point.startTimeUnixNano,
        timeUnixNano: point.timeUnixNano,
        resourceIndex: context.resourceIndex,
        scopeIndex: context.scopeIndex,
        metricIndex,
        pointIndex: index,
        resource: context.resource,
        scope: context.scope,
        attributes,
        value: metricPointValue(points.kind, point),
      }),
      event_time: eventTime,
      severity: "info",
      app_id: resourceString(context.resource, "service.name"),
      machine_id:
        resourceString(context.resource, "host.id") ??
        resourceString(context.resource, "host.name"),
      environment: resourceString(context.resource, "deployment.environment"),
      message: name,
      attributes: compactObject({
        category: "otlp_metric",
        signal: "metrics",
        name,
        description,
        unit,
        resource: context.resource,
        scope: context.scope,
        metric_attributes: attributes,
        otel: compactObject({
          signal: "metrics",
          metric_kind: points.kind,
          aggregation_temporality: points.aggregationTemporality,
          is_monotonic: points.isMonotonic,
          start_time_unix_nano: stringFromUnknown(point.startTimeUnixNano),
          time_unix_nano: stringFromUnknown(point.timeUnixNano),
          flags: numberFromUnknown(point.flags),
        }),
      }),
      body: {
        metric: compactObject({
          name,
          description,
          unit,
          kind: points.kind,
          value: metricPointValue(points.kind, point),
        }),
      },
    };
  });
}

function metricPoints(metric: JsonObject): {
  kind: string;
  dataPoints: JsonObject[];
  aggregationTemporality?: string | number;
  isMonotonic?: boolean;
} {
  const metricKinds = [
    "gauge",
    "sum",
    "histogram",
    "exponentialHistogram",
    "summary",
  ];
  for (const kind of metricKinds) {
    if (!(kind in metric)) continue;
    const container = objectValue(metric[kind]);
    if (!container) throw new Error(`metric.${kind} must be an object`);
    return {
      kind,
      dataPoints: objectArray(
        container.dataPoints,
        `metric.${kind}.dataPoints`,
      ),
      aggregationTemporality: stringOrNumber(container.aggregationTemporality),
      isMonotonic:
        typeof container.isMonotonic === "boolean"
          ? container.isMonotonic
          : undefined,
    };
  }
  throw new Error(`metric must contain one of ${metricKinds.join(", ")}`);
}

function metricPointValue(kind: string, point: JsonObject): unknown {
  if (kind === "gauge" || kind === "sum") {
    return numberOrString(point.asDouble) ?? numberOrString(point.asInt);
  }
  if (kind === "histogram") {
    return compactObject({
      count: numberOrString(point.count),
      sum: numberOrString(point.sum),
      min: numberOrString(point.min),
      max: numberOrString(point.max),
      bucket_counts: primitiveArray(point.bucketCounts),
      explicit_bounds: primitiveArray(point.explicitBounds),
    });
  }
  if (kind === "exponentialHistogram") {
    return compactObject({
      count: numberOrString(point.count),
      sum: numberOrString(point.sum),
      min: numberOrString(point.min),
      max: numberOrString(point.max),
      scale: numberFromUnknown(point.scale),
      zero_count: numberOrString(point.zeroCount),
      positive: point.positive,
      negative: point.negative,
    });
  }
  if (kind === "summary") {
    return compactObject({
      count: numberOrString(point.count),
      sum: numberOrString(point.sum),
      quantile_values: primitiveArray(point.quantileValues),
    });
  }
  return point;
}

function attributesFromContainer(value: unknown): JsonObject {
  return attributesFromArray(objectValue(value)?.attributes);
}

function attributesFromArray(value: unknown): JsonObject {
  const result: JsonObject = {};
  for (const entry of objectArray(value, "attributes")) {
    const key = optionalString(entry.key);
    if (!key) continue;
    result[key] = otlpAnyValue(entry.value);
  }
  return result;
}

function scopeInfo(value: unknown): JsonObject {
  const scope = objectValue(value);
  if (!scope) return {};
  return compactObject({
    name: optionalString(scope.name),
    version: optionalString(scope.version),
    attributes: attributesFromArray(scope.attributes),
    dropped_attributes_count: numberFromUnknown(scope.droppedAttributesCount),
  });
}

function otlpAnyValue(value: unknown): unknown {
  const object = objectValue(value);
  if (!object) return undefined;
  if ("stringValue" in object)
    return (
      optionalString(object.stringValue) ??
      stringFromUnknown(object.stringValue)
    );
  if ("boolValue" in object) return object.boolValue === true;
  if ("intValue" in object) return numberOrString(object.intValue);
  if ("doubleValue" in object) return numberOrString(object.doubleValue);
  if ("bytesValue" in object) return optionalString(object.bytesValue);
  if ("arrayValue" in object)
    return objectArray(
      objectValue(object.arrayValue)?.values,
      "arrayValue.values",
    ).map(otlpAnyValue);
  if ("kvlistValue" in object)
    return attributesFromArray(objectValue(object.kvlistValue)?.values);
  return undefined;
}

function spanEvents(value: unknown): JsonObject[] {
  return objectArray(value, "span.events").map((event) =>
    compactObject({
      name: optionalString(event.name),
      time_unix_nano: stringFromUnknown(event.timeUnixNano),
      time: unixNanoToIso(event.timeUnixNano),
      attributes: attributesFromArray(event.attributes),
      dropped_attributes_count: numberFromUnknown(event.droppedAttributesCount),
    }),
  );
}

function spanLinks(value: unknown): JsonObject[] {
  return objectArray(value, "span.links").map((link) =>
    compactObject({
      trace_id: optionalString(link.traceId),
      span_id: optionalString(link.spanId),
      trace_state: optionalString(link.traceState),
      attributes: attributesFromArray(link.attributes),
      dropped_attributes_count: numberFromUnknown(link.droppedAttributesCount),
    }),
  );
}

function otlpSeverity(
  severityNumber: number | undefined,
  severityText: string | undefined,
): "debug" | "info" | "warn" | "error" | "fatal" {
  if (severityNumber !== undefined) {
    if (severityNumber >= 21) return "fatal";
    if (severityNumber >= 17) return "error";
    if (severityNumber >= 13) return "warn";
    if (severityNumber >= 1 && severityNumber <= 8) return "debug";
  }
  const text = severityText?.toLowerCase() ?? "";
  if (text.includes("fatal") || text.includes("panic")) return "fatal";
  if (text.includes("error") || text.includes("err")) return "error";
  if (text.includes("warn")) return "warn";
  if (text.includes("debug") || text.includes("trace")) return "debug";
  return "info";
}

function unixNanoToIso(value: unknown): string | undefined {
  const ns = bigintFromUnknown(value);
  if (ns === undefined) return undefined;
  const ms = ns / 1_000_000n;
  if (
    ms > BigInt(Number.MAX_SAFE_INTEGER) ||
    ms < BigInt(Number.MIN_SAFE_INTEGER)
  )
    return undefined;
  const date = new Date(Number(ms));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function durationMs(start: unknown, end: unknown): number | undefined {
  const startNs = bigintFromUnknown(start);
  const endNs = bigintFromUnknown(end);
  if (startNs === undefined || endNs === undefined || endNs < startNs)
    return undefined;
  return Number(endNs - startNs) / 1_000_000;
}

function requiredObjectArray(
  value: unknown,
  key: string,
  path: string,
): JsonObject[] {
  const object = objectValue(value);
  if (!object) throw new Error("OTLP payload must be an object");
  const array = object[key];
  if (!Array.isArray(array)) throw new Error(`${path} must be an array`);
  return array.map((item, index) => {
    const itemObject = objectValue(item);
    if (!itemObject) throw new Error(`${path}[${index}] must be an object`);
    return itemObject;
  });
}

function objectArray(value: unknown, path: string): JsonObject[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((item, index) => {
    const itemObject = objectValue(item);
    if (!itemObject) throw new Error(`${path}[${index}] must be an object`);
    return itemObject;
  });
}

function objectValue(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringFromUnknown(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  )
    return String(value);
  return undefined;
}

function resourceString(resource: JsonObject, key: string): string | undefined {
  return optionalString(resource[key]) ?? stringFromUnknown(resource[key]);
}

function stringOrNumber(value: unknown): string | number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return stringFromUnknown(value);
}

function numberOrString(value: unknown): number | string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : value;
  }
  return undefined;
}

function numberFromUnknown(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function bigintFromUnknown(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isFinite(value))
    return BigInt(Math.trunc(value));
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  return undefined;
}

function primitiveArray(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(
    (item) =>
      item === null || ["string", "number", "boolean"].includes(typeof item),
  );
}

function compactObject(input: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}

function stableSourceEventId(kind: string, value: unknown): string {
  return `otlp:${kind}:${createHash("sha256").update(stableJson(value)).digest("hex").slice(0, 32)}`;
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    const object = value as JsonObject;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
