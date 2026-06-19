# Structured Log Ingest Contract

Last updated: 2026-06-17

This document describes the first structured logging compatibility bridge for open-logs.

The bridge is intentionally a data-ingest bridge, not an AI workflow. Its job is to accept common JSON logging payloads from existing applications, preserve the original producer payload after redaction, normalize the record into the canonical log model, append it to raw filesystem segments, and index it in SQLite for search, correlation, stream delivery, and rebuild.

## Entry Points

- Library: `structuredLogToEntry`, `structuredLogPayloadToEntries`, `ingestStructuredLogBatch`, `parseStructuredJsonLines`, and `ingestStructuredJsonLines` in `src/lib/structured-logs.ts`.
- SDK: `LogsClient.pushStructuredLog`, `LogsClient.pushStructuredLogs`, `createPinoOpenLogsTransport`, and `createWinstonOpenLogsTransport` in `@hasna/logs-sdk`, with `./pino` and `./winston` subpath exports for transport-focused imports.
- HTTP API: `POST /api/logs/structured`.
- CLI: `logs import-jsonl <file>` for one-shot imports and `logs import-jsonl <file> --follow` for polling appended JSONL records.

All entry points feed the existing canonical `ingestLog` path, so they inherit:

- redaction before raw persistence;
- append-only raw JSONL segment storage;
- SQLite `logs`, `event_segments`, and `event_records` indexing;
- event stream publication;
- raw pointer reconstruction and rebuild behavior.

## Supported Formats

The initial supported formats are:

- `pino`: numeric Pino levels and `msg`/`time`/`name` fields.
- `winston`: string Winston levels and `message`/`timestamp` fields.
- `json`: generic structured JSON with `message`, `level` or `severity`, and common correlation keys.
- `auto`: default detector. Numeric `level` or `msg` implies Pino; string `level` plus `message` implies Winston; otherwise generic JSON.

Supported level mappings:

- Pino numeric levels: `10` and `20` -> `debug`, `30` -> `info`, `40` -> `warn`, `50` -> `error`, `60` -> `fatal`.
- Winston numeric levels: `0` -> `error`, `1` -> `warn`, `2` and `3` -> `info`, `4`, `5`, and `6` -> `debug`.
- String levels: `trace`, `debug`, `silly`, `verbose`, `http`, `info`, `notice`, `warn`, `warning`, `error`, `err`, `fatal`, `crit`, `critical`, and `panic`.

Missing levels default to `info`. Unknown explicit levels are rejected.

## HTTP Shape

`POST /api/logs/structured` accepts:

Single record:

```json
{
  "level": 50,
  "time": 1781596800000,
  "msg": "checkout failed",
  "name": "checkout-api",
  "traceId": "trace-1"
}
```

Batch array:

```json
[
  { "level": 30, "msg": "started" },
  { "level": 40, "msg": "slow request" }
]
```

Envelope:

```json
{
  "format": "winston",
  "service": "billing-worker",
  "environment": "test",
  "logs": [
    {
      "level": "warn",
      "timestamp": "2026-06-16T10:00:00.000Z",
      "message": "invoice retry scheduled"
    }
  ]
}
```

The route also accepts query overrides for `format`, `source`, `service`, `project_id`, `page_id`, `machine_id`, `repo_id`, `app_id`, `process_id`, `run_id`, `trace_id`, `span_id`, `parent_span_id`, `session_id`, `release_id`, `environment`, `agent`, and `url`.

When API token mode is enabled, the endpoint requires the trusted API token. Browser ingest tokens are not accepted for this server-side route.

## CLI Shape

Import JSONL:

```sh
logs import-jsonl ./app.log --format pino --environment development --json
```

The CLI accepts:

- `--format auto|pino|winston|json`
- `--source <source>`
- `--service <name>`
- `--project <name|id>`
- `--machine <id>`
- `--repo <id>`
- `--app <id>`
- `--process <id>`
- `--run <id>`
- `--environment <name>`
- `--release <id>`
- `--metadata <json>`
- `--follow`
- `--from-end`
- `--poll <ms>`
- `--idle-timeout <ms>`
- `--max-lines <n>`
- `--json`

Use `-` as the file path to read JSONL from stdin.

Follow mode polls a file by byte offset, decodes UTF-8 incrementally across read buffers, ingests newline-terminated JSONL records as they appear, includes `byte_offset` in position metadata, and treats `--max-lines` as a hard cap even when a poll reads a burst of already-available records. On deterministic shutdown it attempts one final non-empty trailing JSON object even without a newline. It detects truncation and resumes from byte offset `0`, but it is not yet a complete log-rotation/inode-following implementation.

## SDK Transport Helpers

The SDK exposes first-pass dependency-light helpers for app integration:

- `LogsClient.pushStructuredLog(record, options)` posts a single producer record to `/api/logs/structured` using server-side API authentication headers and the client default project/machine/repo/app/process/run context.
- `LogsClient.pushStructuredLogs(records, options)` posts a structured batch and can attach metadata plus a `sourceEventPrefix` for transport-generated batches.
- `createPinoOpenLogsTransport(options)` returns a writable-like object for Pino JSON line output. It parses newline-delimited JSON records, batches them, posts them to `/api/logs/structured?format=pino`, and exposes `flush()`/`stop()` for shutdown.
- `createWinstonOpenLogsTransport(options)` returns a Winston-compatible object-mode writable transport with `log(info, callback)`, legacy `log(level, message, meta, callback)` normalization, minimal event-emitter methods, batching, `flush()`, and `close()`/`stop()`.

The SDK package also exports `@hasna/logs-sdk/pino` and `@hasna/logs-sdk/winston`, each defaulting to the matching helper. These helpers intentionally avoid hard dependencies on Pino or Winston. The current lab validates installed `pino@10.3.1` and `winston@3.19.0` against the helpers, but this is not yet a broad logger-version matrix.

The transport queue has a first bounded reliability policy:

- `maxQueueSize` bounds queued records, drops the oldest non-active queued record when full, and preserves the active in-flight batch; if every queued record is active, the incoming record is dropped.
- `maxRetries`, `retryBaseDelayMs`, and `retryMaxDelayMs` control retry behavior after failed structured-log posts.
- Failed batches keep the same `sourceEventPrefix` across retries so retry deduplication remains stable.
- `onRetry` reports retry attempts, pending queue size, and next delay.
- `onDrop` reports `queue_full` and `retries_exhausted` drops with the dropped record and attempt count.
- `stats()` returns pending, in-flight, enqueued, sent, dropped, retry, failed-batch, queue-size, and file-spool counters.

Node/Bun producers can opt into a first durable file spool with `spoolDirectory` or `spoolFile`. When enabled:

- the bounded queue is mirrored to a JSONL spool file after SDK-side redaction of likely secrets;
- when the current process is alive, the transport still sends the original in-memory record; after restart, only the redacted spooled copy is available for replay;
- redacted send context, including project/service/environment/release/agent/log URL and metadata, is persisted with each spooled record so restart replay does not silently switch to the new transport's context;
- secret-bearing `sourceEventPrefix` values are redacted before SDK batch-prefix assignment, so the persisted `batch_prefix` does not carry raw secrets;
- queued records are loaded synchronously when a new transport starts with the same project/format spool path;
- malformed or unsupported spool lines are skipped, counted in `stats().spool_errors`, and do not block replay of valid persisted records;
- spool files larger than `maxQueueSize` keep the newest loadable records and report the older load-time drops through `onDrop`, `stats().dropped`, and `stats().spool_dropped`;
- `_open_logs_event_id` and assigned `sourceEventPrefix` are persisted before sending, so a crash after a collector receive but before local cleanup can replay idempotently;
- exhausted retry budgets preserve spooled records and return/raise the current flush error instead of permanently dropping them; later interval or explicit flush attempts retry from the spool;
- successful sends or queue-full drops atomically rewrite or remove the spool file.

This is still a bounded SDK spool, not a complete offline telemetry system. It does not yet provide browser `localStorage`/IndexedDB spooling for structured logger transports, fsync-backed durability guarantees, cross-process spool locking, compression, encryption at rest, or production drop-alert policy.

## Normalization

The bridge maps:

- `msg`, `message`, or `body` to canonical `message`;
- `time`, `timestamp`, `@timestamp`, `datetime`, or `date` to canonical `timestamp`;
- `name`, `logger`, `logger.name`, `service`, or `service.name` to canonical `service`;
- `trace_id`, `traceId`, `trace.id`, `otel.trace_id`, and `dd.trace_id` to canonical `trace_id`;
- `span_id`, `spanId`, `span.id`, `otel.span_id`, and `dd.span_id` to canonical `span_id`;
- `stack`, `err.stack`, `error.stack`, or `exception.stacktrace` to canonical `stack_trace`;
- `hostname`, `host.id`, or `host.name` to `machine_id`;
- explicit `app_id` or service identity to `app_id`;
- `release_id`, `release`, or `version` to `release_id`;
- `environment`, `env`, or `deployment.environment` to `environment`;
- `url`, `request.url`, or `req.url` to canonical `url`.

The original structured record is preserved under `metadata.structured_log.original` after redaction. The bridge also stores format, source, redacted producer event ID when present, JSONL position, raw level, raw time, logger name, PID, and hostname under `metadata.structured_log`.

## Idempotency

The bridge derives deterministic IDs before calling canonical log ingest.

If the producer provides `id`, `event_id`, `eventId`, `source_event_id`, `log_id`, or `logId`, and that producer ID does not trigger redaction policy, `source_event_id` is:

```text
structured:<format>:producer:<hash-of-redacted-producer-id>
```

Producer IDs are not embedded verbatim in `source_event_id`. If the producer ID itself triggers redaction policy, it is not used as a singleton deterministic ID; batch or JSONL position context can still produce a position-scoped fallback ID.

The SDK Pino and Winston transport helpers also assign a private `_open_logs_event_id` to queued records that do not already carry a producer ID. The server treats that field like a producer ID, so retry attempts keep the same `source_event_id` even when an older record exhausts retries and the surviving record moves to a different batch position. Records that already contain a producer ID are sent unchanged.

If no usable producer ID exists and position context exists, `source_event_id` is a hash of a redacted identity payload containing:

- format;
- timestamp;
- level;
- message;
- service/logger identity;
- redacted original record;
- position metadata.

For JSONL imports, position metadata includes the logical imported-entry index, line number, source file or `stdin` marker, and byte offset when available from follow mode. This lets identical repeated lines in the same file become distinct events while retrying the same file preserves the same IDs. Batched HTTP/library payloads use array index as position context for the same reason.

Singleton records without a usable producer ID do not get deterministic fallback IDs, because repeated identical singleton records are valid log events and must not collapse into one row. Known limitation: without a usable producer event ID, arbitrary rebatching, file-path changes, or line reordering can change deterministic fallback IDs.

## Validation And Limits

The HTTP route rejects:

- non-JSON content types;
- invalid JSON;
- payloads over `HASNA_LOGS_MAX_PAYLOAD_BYTES` or the default 1 MiB;
- batches over `HASNA_LOGS_MAX_BATCH_SIZE` or the default 1,000 records;
- messages over `HASNA_LOGS_MAX_MESSAGE_CHARS` or the default 262,144 characters;
- non-object records;
- records with no `msg`, `message`, `body`, `err.message`, or `error.message`;
- unknown explicit levels;
- unsupported source overrides;
- `browser` or `script` source classification on the server-side structured route;
- missing `project_id` or `page_id` references before raw append;
- browser ingest tokens.

The CLI importer rejects invalid JSONL lines, invalid formats, missing `project_id` or `page_id` references, and the same record-level validation failures.

## Evidence

Focused coverage added with this bridge:

- `src/lib/structured-logs.test.ts`
  - Pino mapping into raw-backed canonical logs.
  - Winston envelope mapping.
  - redaction of preserved original payloads before raw persistence.
  - retry-stable IDs.
  - repeated identical JSONL line preservation through line positions.
  - repeated singleton no-producer-ID records are not collapsed.
  - producer IDs that trigger redaction do not leak through raw `source_event_id`.
  - invalid project/page references fail before raw append.
  - malformed record rejection.
- `src/server/server.test.ts`
  - `POST /api/logs/structured` Pino and Winston ingest through the real server route stack.
  - malformed request rejection before ingest.
  - missing-project preflight with no unindexed raw record.
  - browser/script source-spoof rejection.
  - browser-token rejection for server-side structured logs.
- `src/cli/import-jsonl.test.ts`
  - `logs import-jsonl` ingestion and retry-stable IDs against an isolated data directory.
  - `logs import-jsonl --follow` ingestion of an appended Pino JSONL line before idle timeout.
  - `logs import-jsonl --follow --max-lines` hard-cap behavior when multiple records are already readable.
  - UTF-8 preservation when a multibyte character is split across the follow-mode read buffer boundary.
  - invalid format rejection.
- `src/lib/sdk-client.test.ts`
  - `LogsClient.pushStructuredLog` posts to `/api/logs/structured` with server-side auth headers and default project/machine/repo/app/process/run context.
  - `createPinoOpenLogsTransport` parses Pino JSON lines, batches records, sends transport-scoped source event prefixes, and exposes explicit flush/stop.
  - `createWinstonOpenLogsTransport` accepts Winston-style `log(info, callback)`, normalizes Winston legacy-wrapper calls, exposes a stream-compatible object-mode writable surface, emits `logged`, batches metadata, and exposes explicit flush/close.
  - Pino `stop()` and Winston `close()` initiate final queued flushes for records not already sent by interval or explicit `flush()`.
  - transient structured transport failures retain queued batches and retry with the same source prefix.
  - transport-generated `_open_logs_event_id` values keep retry IDs stable when records are rebatch-positioned after drops.
  - exhausted retries report `retries_exhausted` drops through `onDrop` and `stats()`.
  - `maxQueueSize` bounds memory and reports `queue_full` drops through `onDrop` and `stats()`.
  - queue pressure preserves the active in-flight batch before dropping older non-active queued records or, when all queued records are active, the incoming record.
  - Node/Bun `spoolDirectory` persists a redacted structured transport record plus redacted send context across a failed flush, reloads it in a restarted transport, and replays it with the same `_open_logs_event_id`, `sourceEventPrefix`, service/environment/release, and metadata context.
  - malformed or unsupported structured transport spool lines, including invalid `format` or unsupported server-side `source` context, are counted in `spool_errors` and skipped while valid records still replay.
  - load-time spool overflow keeps the newest `maxQueueSize` records and reports older drops through `onDrop`, `stats().dropped`, and `stats().spool_dropped`.
- `scripts/structured-log-validation-lab.ts`
  - real token-secured server, remote `logs watch --server`, local `logs import-jsonl --follow`, HTTP `POST /api/logs/structured`, SDK Pino/Winston transport helper writes, doctor verification, raw reconstruction, and canary redaction checks.
- `scripts/logger-package-validation-lab.ts`
  - real token-secured server, remote `logs watch --server`, installed `pino@10.3.1`, installed `winston@3.19.0`, SDK transport helpers, collector-down SDK file spool persistence, server restart replay with preserved transport metadata context, doctor verification, raw reconstruction, package-version evidence, and canary redaction checks.

Verified commands for this slice:

- `bun test src/lib/structured-logs.test.ts src/cli/import-jsonl.test.ts`
- `bun test src/lib/sdk-client.test.ts src/lib/structured-logs.test.ts src/cli/import-jsonl.test.ts`
- `bun test src/server/server.test.ts -t "POST /api/logs/structured"`
- `bun run validate:structured-logs -- --keep`
- `bun run validate:logger-packages -- --keep`
- `./node_modules/.bin/tsc --noEmit --pretty false`
- `cd sdk && bun run build`
- built `sdk/dist/index.js`, `sdk/dist/pino.js`, and `sdk/dist/winston.js` import smoke
- `bunx biome check src/lib/sdk-client.test.ts src/lib/structured-logs.test.ts src/lib/structured-logs.ts`

## Remaining Gaps

This bridge is not the full structured logging roadmap.

Still missing:

- broader Pino and Winston version-matrix validation beyond the current pinned `pino@10.3.1` and `winston@3.19.0` lab;
- browser durable retry/spool support for structured logger transports across tab closes and long collector outages;
- fsync-backed, encrypted, compressed, cross-process-safe, production-tuned spool behavior;
- production tuning guidance for queue sizes, retry delays, and drop/alert policies;
- logfmt/plain text parser imports;
- journald/syslog/platform log imports;
- Docker/Kubernetes log stream importers;
- collector/exporter compatibility;
- richer framework-specific metadata extraction;
- high-volume JSONL import benchmarks;
- full inode-aware rotation-following file tailer mode;
- long-running real app dogfood with framework-owned logger initialization and shutdown paths.
