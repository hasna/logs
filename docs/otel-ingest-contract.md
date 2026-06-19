# OpenTelemetry Ingest Contract

Status: first-pass JSON OTLP bridge, not full OpenTelemetry Collector parity.

Open-logs accepts OTLP JSON over HTTP and translates it into the shared universal event envelope. The existing universal ingest path then handles redaction, append-only raw segment persistence, SQLite `event_records` indexing, duplicate producer-ID handling, live stream publication, and first-pass compatibility projections.

## Endpoints

All endpoints live under the protected API namespace:

- `POST /api/otel/v1/traces`
- `POST /api/otel/v1/logs`
- `POST /api/otel/v1/metrics`

Requests must use `Content-Type: application/json`.

When `HASNA_LOGS_API_TOKEN` or `LOGS_API_TOKEN` is configured, requests must use `Authorization: Bearer <token>` or `X-Logs-Token: <token>`. Browser ingest tokens are rejected for OTLP writes because OTLP exporters are server-side producers, not scoped browser capture clients.

## Supported Payloads

The bridge accepts OTLP JSON shapes:

- Traces: `resourceSpans[].scopeSpans[].spans[]`
- Logs: `resourceLogs[].scopeLogs[].logRecords[]`
- Metrics: `resourceMetrics[].scopeMetrics[].metrics[]`

Metric datapoints are expanded into one universal `metric` event per datapoint. Supported first-pass metric containers are `gauge`, `sum`, `histogram`, `exponentialHistogram`, and `summary`.

## Mapping

| OTLP signal | Universal event type | Important indexed fields |
| --- | --- | --- |
| span | `span` | `source=otel`, `trace_id`, `span_id`, `parent_span_id`, `event_time`, `severity`, `app_id`, `machine_id`, `environment` |
| log record | `log` | `source=otel`, `trace_id`, `span_id`, `severity`, `event_time`, `app_id`, `machine_id`, `environment` |
| metric datapoint | `metric` | `source=otel`, `event_time`, `app_id`, `machine_id`, `environment` |

Resource attributes are preserved under `attributes.resource`. Scope metadata is preserved under `attributes.scope`. Original signal-specific attributes are preserved under `span_attributes`, `log_attributes`, or `metric_attributes`.

Resource identity is indexed opportunistically:

- `service.name` -> `app_id`
- `host.id` or `host.name` -> `machine_id`
- `deployment.environment` -> `environment`

`process.pid` stays in `attributes.resource` and is not promoted to top-level `process_id`, because a PID is not globally unique across machines, containers, or service restarts.

Span start/end timestamps become `started_at`, `ended_at`, and `duration_ms` attributes so the existing span/trace projections can be populated.

## Raw Evidence

The raw segment record is the redacted universal telemetry envelope produced from the OTLP payload, not the exact original OTLP request bytes. The envelope keeps the resource, scope, original signal fields, converted attributes, span events/links, log body, and metric datapoint value needed for reconstruction and indexing.

Redaction runs before raw segment append. Tests inject canary secrets through OTLP span/log payloads and verify they are absent from raw replay while redaction markers remain.

## Idempotency

The bridge supplies deterministic `source_event_id` values:

- Spans use `otlp:span:<trace_id>:<span_id>` when both IDs exist.
- Logs use stable hashes over OTLP resource, scope, structural record ordinal, severity, body, timestamps, and attributes.
- Metrics use stable hashes over OTLP resource, scope, metric/datapoint ordinal, attributes, timestamps, and metric values.

The universal ingest path derives a stable internal event ID from `source + source_event_id` when no explicit event ID exists, so exporter retries deduplicate instead of appending duplicate raw records.

This first-pass retry model is deterministic for the same OTLP JSON payload ordering. Arbitrary exporter rebatching or record reordering can produce different ordinal-based log or metric IDs until open-logs supports richer exporter-native identity or Collector-level conformance behavior.

## Known Gaps

- No protobuf OTLP request decoding yet.
- No gRPC OTLP receiver yet.
- No OpenTelemetry Collector config examples or conformance matrix yet.
- No semantic-convention-specific rollups beyond first-pass trace/span projections and raw metric datapoint events.
- No tail sampling, baggage/resource merge policy, exemplar-specific indexing, or profile signal support yet.
- No high-volume real collector/exporter lab has validated this endpoint against multiple language SDKs.
