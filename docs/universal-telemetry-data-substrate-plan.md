# Universal Telemetry Data Substrate Plan

Last updated: 2026-06-17

## Corrected Product Direction

Open-logs is not trying to clone Sentry's AI debugging workflows.

The goal is to become an open-source universal telemetry data substrate: collect, preserve, index, correlate, stream, and expose as much useful runtime and development data as possible so humans and other agents can reason from it.

Sentry remains a useful reference for telemetry categories, but the product center is different:

- Sentry is optimized around hosted debugging workflows.
- Open-logs should be optimized around data completeness, local-first capture, repository and machine context, build and process visibility, and agent access.

The app is "good" only when it reliably answers:

- What happened?
- Where did it happen?
- Which repo, app, process, command, machine, run, agent, session, trace, and file does it belong to?
- What raw data proves it?
- Can another agent retrieve the context without needing hidden state?
- Can we replay or repair the index from raw files?
- Does it still work under real concurrent terminal sessions, live streams, crashes, high-volume logs, and multiple apps?

## Product Thesis

Open-logs should become the local telemetry memory layer for software work.

It should capture data from:

- Apps in production-like and local development modes.
- Repositories and their git/package/build context.
- Machines and their operating environment.
- Processes, child processes, CLIs, test runners, and build tools.
- Browsers, servers, workers, queues, and framework runtimes.
- Logs, exceptions, traces, spans, metrics, profiles, replays, screenshots, artifacts, and attachments.
- Agents, MCP tools, shell commands, file edits, model calls, task IDs, and run metadata.
- Real-time sessions and historical raw files.

It should not require Sentry, a SaaS backend, or a central database to be useful locally.

## Current State

Useful existing pieces:

- SQLite schema, FTS, migrations, query helpers, and tests.
- REST API and MCP server.
- CLI for listing, tailing, pushing, exporting, watching, and managing projects/jobs/storage.
- Browser script that captures console warnings/errors and global errors.
- Playwright scanner for page console/errors/network failures.
- Dashboard with live tail, issues, performance, alerts, projects, and summaries.
- Basic issue grouping, alert rules, retention, performance snapshots, jobs, and PostgreSQL table sync.
- Core raw JSONL event segment store for log ingest, including segment manifests, byte offsets, byte lengths, per-record hashes, segment hashes, SQLite `event_segments`/`event_records` pointers, verifier, replay, and rebuild tests.
- Log ingest now preserves producer `id` and `timestamp` when supplied and uses producer IDs for idempotent retry of log events.
- `logs doctor segments`, `logs doctor rebuild-index`, and `logs doctor repair-segments` can verify raw segment integrity, rebuild SQLite event indexes from raw segments, and quarantine malformed complete lines or partial tails before rebuilding.
- Segment verification scans the raw segment directory, not only SQLite metadata, so it can report SQLite-unknown files and unindexed raw events.
- Segment repair has a first deterministic quarantine path: dry-run reports malformed/partial raw lines, `--apply` writes exact removed bytes plus a manifest under `quarantine/`, rewrites the segment with valid complete lines, and rebuilds SQLite metadata/projections from the repaired raw files.
- Rebuild can recover complete orphan raw events from disk even when the compatibility log row failed to insert, and it now uses the same event-store lock as append/repair so `doctor rebuild-index` does not mutate indexes under live writers.
- A process-level crash drill now proves a child producer can append a raw event and die before indexing, `logs doctor segments` reports the unindexed raw event, `logs doctor rebuild-index` reconstructs the event record and log projection from raw JSONL, a separate child can leave a partial raw tail, `logs doctor repair-segments --apply` quarantines that tail and restores verification, and a segment write-error path fails before inserting log or event rows.
- Rebuild now also clears and reconstructs first-pass SQLite compatibility projections from raw segments for `logs`, `issues`, `traces`, `spans`, `sessions`, `releases`, `artifacts`, `processes`, and `runs`. The recovery test deletes those derived tables plus `event_records`/`event_segments`, rebuilds from raw JSONL, and verifies log rows, issue grouping, trace/span links including authoritative earlier `started_at` after a placeholder, session details including authoritative earlier `started_at` after a log-seeded placeholder, out-of-order artifact-before-release enrichment, release/artifact metadata, process/run metadata from process/span events, and command-runner final status recovery from raw process-exit and lifecycle-summary evidence. Live universal ingest now uses the same placeholder-enrichment semantics for later, more specific events.
- Segment append has a lock-backed offset calculation path, a small passing concurrent CLI producer validation, a bounded multi-process batch ingest regression with forced segment rotation, raw-pointer reconstruction, rebuild locking, and rebuild-from-raw verification, plus a repeatable high-volume stress harness exposed as `bun run validate:stress`.
- Duplicate producer IDs are checked under the same event-store lock as raw append, and a concurrent CLI test proves duplicate retries do not create duplicate raw records.
- A shared redaction pass now runs before log, universal-event, and process/run raw persistence. A bounded cross-surface canary suite now injects secrets through log messages, URLs, headers/cookies, stack traces, metadata, replay-like payloads, agent/tool/model payloads, command args, stdout/stderr, child env output, and canary-bearing working directories, then verifies the canary is absent from raw replay, decoded process chunks, SQLite rows, event exports, legacy log exports, log/universal/agent/process event-stream payloads, default storage-sync table payloads, and `logs run` result objects.
- `/api/logs` now rejects non-JSON input, invalid JSON, unknown fields, invalid field types, oversized payloads, oversized batches, oversized messages, unauthenticated writes by default, and unauthenticated writes when `HASNA_LOGS_API_TOKEN` or `LOGS_API_TOKEN` is configured.
- All `/api/*` routes now share token enforcement by default. Requests require `Authorization: Bearer <token>` or `X-Logs-Token: <token>` when `HASNA_LOGS_API_TOKEN` or `LOGS_API_TOKEN` is configured; no-token loopback access requires explicit trusted local mode through `logs-serve --local-open`, `HASNA_LOGS_LOCAL_OPEN=1`, or `LOGS_LOCAL_OPEN=1`.
- Project, page, page-auth, retention, job, alert, and issue mutation routes now share JSON content-type checks, invalid JSON handling, payload byte limits, known-field rejection, and field type validation before SQLite mutation.
- Browser ingest tokens now provide scoped write-only browser capture in token-secured mode without exposing the full API token. Tokens are hashed at rest, project-bound, optionally origin-bound, accepted by `POST /api/logs` and restricted browser-safe `POST /api/events` writes, forced onto the token project, limited to `script`/`browser` sources, revocable, and excluded from default storage sync.
- `/api/logs/stream` now uses an ingest event bus with a bounded replay buffer, `Last-Event-ID`/`last_event_id` catch-up through SQLite, explicit SSE `overflow` events for buffer misses and unknown anchors, and periodic SQLite catch-up for cross-process writers.
- A first raw-backed event catalog read surface exists: `searchEvents`/`getEvent`/`exportEventsToJson`, `/api/events`, `logs events list|get|export`, and MCP `event_search`/`event_get`/`event_export` can read `event_records` and optionally reconstruct raw envelopes from segment pointers.
- A first raw-first universal event ingest surface exists for non-log events: `ingestUniversalEvent`, `POST /api/events`, `logs events push`, and MCP `event_push` accept a shared envelope for `log`, `exception`, `span`, `metric`, `profile`, `replay`, `monitor`, `release`, `build`, `process`, `agent`, `artifact`, `network`, `filesystem`, and `session` events.
- Universal event ingest preserves producer IDs/times when supplied, rejects unknown top-level fields, invalid event types, invalid severity/privacy values, and invalid timestamps, redacts top-level source/correlation fields plus `message`/`body`/`attributes` before raw segment append, indexes `event_records`, deduplicates existing event IDs under the event-store lock, derives a stable internal event ID from `source + source_event_id` when no canonical event ID is supplied, and writes first compatibility projections for traces, spans, sessions, releases, artifacts, process/runs, and exception issues.
- A first OTLP JSON bridge exists at `POST /api/otel/v1/traces`, `/api/otel/v1/logs`, and `/api/otel/v1/metrics`. It maps OTLP resource/scope spans, log records, and metric datapoints into the same universal event envelope with `source=otel`, preserves resource/scope attributes, indexes trace/span/service/environment/host identity where present, keeps non-global `process.pid` in resource metadata instead of top-level `process_id`, rejects browser ingest tokens, deduplicates exporter retries through deterministic resource/scope/ordinal-aware `source_event_id` values, rejects malformed nested signal arrays and metric containers, and relies on the universal ingest path for redaction, raw segment persistence, SQLite indexing, stream publication, and span/trace projections. The contract and known gaps are documented in [OpenTelemetry Ingest Contract](./otel-ingest-contract.md).
- A first structured logging bridge exists for Pino/Winston/generic JSON logs. `POST /api/logs/structured`, `logs import-jsonl <file>`, `logs import-jsonl <file> --follow`, `LogsClient.pushStructuredLog(s)`, SDK `createPinoOpenLogsTransport`, SDK `createWinstonOpenLogsTransport`, and `src/lib/structured-logs.ts` normalize common JSON logger records into canonical log entries, preserve the original structured payload under `metadata.structured_log.original` after redaction, assign `source=pino|winston|structured`, map common service/trace/span/release/environment fields, reject browser ingest tokens and browser/script source classification for the server-side route, preflight project/page references before raw append, and use deterministic IDs for hashed non-sensitive producer-ID retries plus batch/JSONL line-position/byte-offset fallback. Singleton no-producer-ID records remain unique so repeated identical log records are not collapsed. Follow mode polls appended JSONL records, incrementally decodes UTF-8 across read buffers, records byte offsets, detects truncation, and can stop deterministically with `--idle-timeout` or a hard `--max-lines` cap; it is not yet a full inode-aware log-rotation follower. The SDK exposes `@hasna/logs-sdk/pino` and `@hasna/logs-sdk/winston` subpaths, `scripts/logger-package-validation-lab.ts` now proves installed `pino@10.3.1` and `winston@3.19.0` can send through those helpers into live stream, raw segment, and SQLite indexing, and the SDK transport queue now has first bounded retry/backpressure/drop accounting with stable retry source prefixes, per-record retry exhaustion, transport-generated `_open_logs_event_id` stability across rebatching, opt-in redacted Node/Bun file spooling across collector restart with redacted send-context preservation, secret-bearing batch-prefix redaction, malformed-spool-line skipping with `spool_errors`, load-time overflow reporting, `onRetry`, `onDrop`, and `stats()`. The bridge feeds the existing raw segment plus SQLite `logs`/`event_records` path. The contract and known gaps are documented in [Structured Log Ingest Contract](./structured-log-ingest-contract.md).
- A first shared event-catalog live stream exists: `EventCatalogBus` receives indexed log, universal, and process lifecycle events, and `GET /api/events/stream` streams `event_records` entries with filters, `Last-Event-ID` resume, SQLite catch-up, explicit `overflow` events, optional raw envelope reconstruction, a safe metadata fallback when raw reconstruction fails, and an `event_name=event` generic SSE channel for consumers that should not track every event type name. The stream now catches up from SQLite by rowid on ticks, overflow, and before emitting each bus event, so a live in-process bus event cannot skip earlier cross-process SQLite-only writes.
- Dashboard live tail has moved off the legacy log stream: `Tail.tsx` now consumes `/api/events/stream?event_name=event`, deduplicates by `event_id`, keeps the latest 500 event catalog entries, renders `event_type`, severity, source, and message, sends the dashboard session token through fetch-backed SSE authorization headers, closes while paused, and resumes with an explicit `last_event_id` cursor.
- `logs watch` now has first-pass event-catalog consumers: local `logs watch --events` polls `event_records` by SQLite `rowid` with universal filters, and `logs watch --server <url>` consumes `/api/events/stream` with token support, overflow reporting, reconnect, `stream_read_error` retry after fetch/SSE read failures, and `Last-Event-ID` resume. `logs serve` now explicitly binds the imported server with `Bun.serve()`, while the standalone `logs-serve`/`src/server/index.ts` entrypoint remains the direct server path.
- MCP now has a first-pass bounded live-tail consumer: `event_watch` lets agents poll `event_records` with `last_event_id`, explicit missing-cursor markers, optional raw inclusion, and no-history default anchoring.
- MCP tool calls are now first-class raw universal `agent` events after a tool handler is reached. MCP tool execution records tool name, status, duration, safe argument shape/keys, result content summary, and handler-level errors without changing tool behavior. MCP `event_search`/`event_watch` hide internal MCP tool telemetry by default and expose `include_internal` for explicit inspection. MCP agent registration, heartbeat, and focus changes also emit durable `agent` events with session/focus metadata.
- `logs run` now has first-pass build/test/dev-server enrichment on top of raw stdout/stderr capture. It classifies runs as `command`, `build`, `test`, or `dev-server`; records tool, package manager, framework, and script hints; preserves newline/end-delimited raw stream segments with byte lengths, hashes, newline flags, invalid-UTF8 markers, and observed persistence sequence; buffers segment persistence until newline or stream end so redaction can see secrets split across read chunks; annotates each stream line with line category, severity, diagnostic codes, detected local URLs, and ports; stores aggregate output summaries in process/run metadata; records bounded per-run resource usage on Linux through procfs snapshots with unsupported-platform metadata elsewhere; emits a raw indexed `process.resource.peak_rss` metric event tied back to the run; records bounded Linux procfs descendant process-tree snapshots with PID/PPID/depth/name/state and no child command line payloads; emits a raw indexed `process` event with category `process_tree` tied back to the run; scans common output roots (`dist`, `build`, `out`, `.next`, `.nuxt`, and `coverage`) before and after a run; emits raw indexed `artifact` events for created/modified outputs with relative path, artifact type, size, SHA-256 content hash when bounded, change type, and no file contents; writes live SQLite `artifacts` rows and raw replay-compatible artifact projections; validates bounded source-map JSON metadata for changed `.map` artifacts, links source maps to generated JavaScript artifacts when possible, writes `source_maps` and `source_map_sources` rows with source paths and content hashes only, and rebuilds those rows from raw artifact events; scans common test-report roots and root-level JUnit report filenames for changed JUnit XML on test runs; rejects DTD/entity-bearing reports, caps file size/node/suite/case counts, parses only allowlisted JUnit suite/case attributes, stores aggregate report counts plus bounded failed/error/skipped case identities, writes live SQLite `test_reports` and `test_cases` rows with report/run/status indexes, `case_stored_count`, `truncated`, and raw replay-compatible projections, keeps external test-report SQLite metadata on an allowlist with `case_storage_policy=bounded_raw_cases`, and emits raw indexed `build` events with `category=test_report` without persisting `<system-out>`, `<system-err>`, failure/error bodies, properties, or full XML content; emits a raw indexed `build` lifecycle summary event for build/test/dev-server runs without overwriting process/run projections; records final status in process-exit raw events; forwards CLI SIGINT/SIGTERM to the child so interrupted dev-server runs can be finalized; redacts split sensitive command arguments such as `--password value` and `--db-password value`; and applies ASCII byte-level redaction before base64 storage for invalid-UTF8 segments.
- Dedicated test-report read surfaces now exist over the SQLite projections: `searchTestReports`/`getTestReport`, `GET /api/test-reports`, `GET /api/test-reports/:report_id`, `logs test-reports list|get`, and MCP `test_report_search`/`test_report_get`. They expose report, run, process, parser, parse-status, path, stored-case status, aggregate outcome, and minimum failure/error/skipped filters; can optionally include bounded `test_cases`; can find aggregate failed reports even when no case rows are stored; and continue to return metadata-only report/case rows without raw XML, system output, failure bodies, or raw-looking parse diagnostics. External projected cases are capped at 50 rows across at most 20 suites and mark `truncated` with `projected_case_limit=50`.
- The first external stream contract is documented in [Event Stream Contract](./event-stream-contract.md), covering API SSE, CLI watch, dashboard, MCP polling, overflow semantics, and remaining validation gaps.
- A first repeatable real-life validation lab now exists at `scripts/real-life-validation-lab.ts` and is exposed as `bun run validate:real-life`. It starts a real API server with an isolated data directory, creates a project through the CLI, runs `logs watch --server` as a live stream consumer, writes cross-process CLI log/span events, posts HTTP exception and metric batch events, runs `logs run --json -- bun test src/lib/parse-time.test.ts`, verifies the returned process resource summary and indexed resource metric event, verifies the returned process-tree summary and indexed process-tree event, runs an isolated artifact-producing `logs run --json -- bun -e ... build`, verifies generated JavaScript and source-map artifact classification, raw indexed artifact events, relative paths, content hashes, SQLite `artifacts` rows, one SQLite `source_maps` row, one SQLite `source_map_sources` row, source-map JavaScript linkage, and source-content omission from collector-owned raw/export/report/SQLite evidence, runs a real Bun test command with `--reporter=junit --reporter-outfile test-results/junit.xml`, verifies parsed JUnit report counts, relative report path, content hash, raw indexed `category=test_report` event, raw export membership, and live SQLite projection rows, queries that captured report through authenticated `GET /api/test-reports`, local `logs test-reports list|get`, and real MCP stdio `test_report_search`/`test_report_get`, verifies `Last-Event-ID` catch-up for a pre-existing post-anchor event and a live follow-up event, exports event records with raw envelopes and checks expected raw export membership, runs `logs doctor segments --json` with checked-record/raw-event/segment assertions, and writes a JSON report when `--keep` or `--data-dir` is used.
- A first repeatable high-volume ingest stress harness now exists at `scripts/high-volume-ingest-stress.ts` and is exposed as `bun run validate:stress`. Its default local run starts 10 independent producers, writes 5,000 mixed log/metric/span/exception/build/process/agent/network events into one isolated data directory, forces raw segment rotation, verifies every expected event ID and type count, checks no duplicate IDs, reconstructs every raw event from SQLite segment pointers before and after rebuild, runs SQLite integrity and foreign-key checks, runs `logs doctor segments --json`, runs `logs doctor rebuild-index --json`, and records aggregate writer throughput. The harness can be scaled with `--producers` and `--events` toward larger runs.
- A first repeatable stream load/resume validation harness now exists at `scripts/stream-load-validation.ts` and is exposed as `bun run validate:streams`. It starts a real token-secured API server with an isolated data directory, validates direct generic SSE live delivery with raw envelopes, validates `Last-Event-ID` buffer-miss recovery through SQLite with an explicit `buffer_miss_sqlite_catchup` marker, forces deterministic slow-subscriber pressure with validation-only stream hooks and verifies `subscriber_queue_overflow` plus SQLite gap recovery, validates bounded multi-consumer API SSE fanout with 8 simultaneous consumers receiving 80 burst events each, validates remote `logs watch --server`, validates local `logs watch --events`, validates real MCP `event_watch` over stdio including missing-cursor overflow, runs `logs doctor segments --json`, and writes a JSON report when retained.
- A first repeatable real-browser dashboard stream validation lab now exists at `scripts/dashboard-stream-validation-lab.ts` and is exposed as `bun run validate:dashboard-stream`. It builds the dashboard and root package, starts both the token-secured source API server and the packaged `dist/server/index.js` server against the same isolated data dir, opens Chromium at `/dashboard/` for each server path, verifies the live tail is blocked before token entry, verifies fetch-backed SSE sends `Authorization: Bearer <token>` after entering the dashboard session token, renders a live event, enters the dashboard paused state, writes a new event while paused, resumes with `last_event_id`, catches up the paused event, receives a post-resume live event, reconstructs raw events from SQLite pointers, and runs `logs doctor segments --json`.
- A first repeatable structured-log validation lab now exists at `scripts/structured-log-validation-lab.ts` and is exposed as `bun run validate:structured-logs`. It starts a real token-secured API server with an isolated data directory, creates a project through the CLI, runs remote `logs watch --server`, runs local `logs import-jsonl --follow` while appending representative Pino and Winston JSONL records, posts Pino and Winston payloads to `/api/logs/structured`, writes records through the SDK Pino and Winston transport helpers, verifies stream delivery for all six structured logs, runs `logs doctor segments --json`, reconstructs raw events from SQLite segment pointers, verifies canary redaction in raw and SQLite rows, and writes a JSON report when retained.
- A first repeatable installed logger package validation lab now exists at `scripts/logger-package-validation-lab.ts` and is exposed as `bun run validate:logger-packages`. It starts a real token-secured API server with an isolated data directory, creates a project through the CLI, runs remote `logs watch --server`, emits records through installed `pino@10.3.1` and `winston@3.19.0` using the SDK transport helpers, writes a real collector-down Pino record into the redacted SDK file spool, restarts the server, replays the spooled record with preserved transport metadata context, verifies stream delivery, records package versions, runs `logs doctor segments --json`, reconstructs raw events from SQLite segment pointers, verifies canary redaction in raw and SQLite rows, and writes a JSON report when retained.
- A first repeatable real-browser browser-spool validation lab now exists at `scripts/browser-spool-validation-lab.ts` and is exposed as `bun run validate:browser-spool`. It starts a token-secured API server with an isolated data directory, creates a project and origin-scoped browser token through real API routes, records the normalized `allowed_origins`, proves a wrong-origin browser-token write is rejected, serves a bundled Chromium app that imports the SDK, forces the first browser flush through a same-origin collector proxy to fail, proves the SDK persists a redacted `localStorage` spool, reloads the page, replays only the redacted spooled event through the real scoped browser-token `/api/events` path, reconstructs the raw event from SQLite segment pointers, checks storage cleanup, and runs `logs doctor segments --json`.
- A first repeatable browser-runtime validation lab now exists at `scripts/browser-runtime-validation-lab.ts` and is exposed as `bun run validate:browser-runtime`. It starts a token-secured API server with an isolated data directory, creates a project and origin-scoped browser token through real API routes, serves a bundled Chromium app that imports the SDK, captures browser console `debug`/`log`/`info`/`warn`/`error`, captures browser error and unhandled-rejection events, captures browser `fetch` HTTP 204 and 503 spans with canonical absolute URLs for relative app requests, captures a thrown fetch network error with error type, captures page-load and History API route-change spans, captures resource timing spans with `link`/`script`/`fetch` initiator metadata while deduping buffered observer replay entries and excluding collector resources, captures opt-in Web Vital metric events for FCP and LCP, proves opt-in browser-to-server `traceparent` propagation by linking browser client spans to same-origin and explicit cross-origin server request spans, proves a CORS-enabled explicit `tracePropagationTargets` origin receives `traceparent` and its preflight requests that header, proves an unlisted CORS-enabled origin with a custom preflight header does not receive `traceparent` and does not assign false trace state, proves browser `mode: "no-cors"` does not send or claim propagated `traceparent`, proves same-origin `blob:` fetch capture does not claim propagated trace context, verifies scoped browser-token `/api/events` writes into the token-owned project, reconstructs raw events from SQLite segment pointers, checks canary redaction in raw and SQLite rows, and runs `logs doctor segments --json`.
- The SDK now has first-pass universal event methods: `pushEvent`, `pushEvents`, `captureException`, `captureMetric`, `captureSpan`, `initUniversalLogs`, `instrumentFetchHandler`, `captureHttpRequest`, `captureNodeHttpRequest`, `createHonoTelemetryMiddleware`, `createExpressTelemetryMiddleware`, `createExpressErrorTelemetryMiddleware`, and `createFastifyTelemetryHooks` post to `/api/events` using the shared event envelope, default project/source/environment/release/app/session context, and trace/span correlation fields. `initUniversalLogs` now works in browser and Node/Bun runtimes; the browser path captures console `debug`/`log`/`info`/`warn`/`error`, browser `error` events, browser `unhandledrejection` events, and browser `fetch` HTTP spans plus thrown network failures while avoiding collector-request recursion and canonicalizing relative request URLs against `location.href`. Browser and Node/Bun fetch capture can opt into W3C `traceparent` propagation with `propagateTrace`; browser propagation defaults to same-origin HTTP(S) targets unless `tracePropagationTargets` is configured, preserves any existing effective traceparent header even when malformed, uppercase-value malformed, version-invalid, or duplicate array-form headers normalize to an invalid comma-joined value, suppresses browser propagation and trace derivation for `mode: "no-cors"` with `traceparent_suppressed: "no-cors"` and for non-HTTP(S) URLs such as `blob:` with `traceparent_suppressed: "non-http"`, origin-scopes absolute string `tracePropagationTargets` before path-prefix matching, and records propagated trace/span IDs on emitted client spans only when a valid lowercase W3C traceparent is available. Browser capture can opt into page-load/route-change spans with `captureNavigation`, bounded resource timing spans with `captureResourceTiming` and `maxResourceTimingEvents`, bounded Web Vital metrics with `captureWebVitals` and `maxWebVitalEvents`, and a bounded redacted `localStorage` spool with `browserSpool` or `browserSpoolKey`; Web Vital observers are disconnected and transient dedupe memory is cleared once the configured metric cap is reached. Browser capture preserves original in-memory events for the first same-page send, serializes overlapping flush attempts, requeues only redacted spool events after a failed live send, replays only redacted persisted events after reload, validates persisted records before redaction, clears corrupt or invalid-only persisted spools, and keeps failed flush batches queued. Browser-token SDK event sends omit server-forbidden identity fields so the token-scoped route owns project assignment. The Node/Bun path captures console logs, process start/beforeExit signals, fatal exceptions through `uncaughtExceptionMonitor` without suppressing the crash path, opt-in unhandled rejections, and generic `fetch` spans while avoiding collector-request recursion. The request adapters capture inbound HTTP server spans and exceptions for Fetch API style handlers, Hono-style middleware, generic Node HTTP request/response objects, Express-style middleware plus error middleware, Fastify-style hooks, and Node request/response error events.
- A shared local identity detector now upserts durable machine, repository, and app rows for local producers. `logs run`, local `logs events push`, and MCP `event_push` enrich indexed `event_records` with `machine_id`, `repo_id` where git metadata is available, `app_id` where package metadata is available, and environment defaults while preserving explicit caller-supplied identity overrides.
- Scoped browser ingest tokens can now write safe browser universal events to `POST /api/events` as well as legacy `POST /api/logs`; the server forces the token project, restricts source to `browser`/`script`, restricts event types to browser-safe categories, rejects server identity spoofing fields at the top level and inside `attributes`/`metadata`, maps browser producer IDs to project-scoped internal IDs, and redacts token metadata before raw persistence.
- The production server CORS default is no longer open to every origin; it permits localhost development origins and explicit `HASNA_LOGS_CORS_ORIGINS`/`LOGS_CORS_ORIGINS` allowlist entries.
- Default table sync now excludes `page_auth`, includes event/identity metadata tables, and the PostgreSQL log source schema accepts the expanded source taxonomy.

Blocking gaps:

- Raw filesystem segments now cover log/process paths, the first universal event endpoint, first JSON OTLP bridge, first structured Pino/Winston/JSON log bridge including JSONL follow mode, SDK dependency-light logger transport helpers, pinned installed `pino@10.3.1`/`winston@3.19.0` package validation, first bounded in-memory SDK structured-transport retry/drop accounting, SDK universal event helpers, browser universal auto-capture for console/errors/rejections/fetch plus opt-in navigation/resource timing/Web Vitals and redacted `localStorage` spool, Node/Bun runtime auto-capture, fetch-native inbound request adapters, Hono-style middleware, generic Node HTTP request/response capture, Express-style middleware, Fastify-style hooks, scoped browser universal event writes, first command-runner artifact metadata and source-map validation metadata events, and first command-runner JUnit test-report metadata events, but production adapters for deeper framework-specific events, broad logger version matrices, platform log imports, OTLP protobuf/gRPC, OpenTelemetry Collector compatibility, profiles, replays, artifact payload upload/source-map symbolication, and agent/tool events still need to emit through that contract by default.
- Producer `timestamp` and `id` preservation is tested for log ingest and first universal event ingest; every source wrapper still must preserve source IDs and event time.
- The universal event envelope exists for the new event endpoint, but older routes and SDKs are not fully normalized onto it yet.
- Durable machine/repo/app/process/run identity catalog tables exist, and first-pass local machine/repo/app discovery now enriches `logs run`, local `logs events push`, and MCP `event_push`; required attribution is still incomplete for SDK/browser/server/framework sources, remote collectors, CI/build agents, child processes, process trees, and run/session lineage.
- Identity metadata currently stores sensitive local context including hostname, OS details, repository root path, remote URL, branch/SHA/dirty state, app/package name, version, and package path. Before broader default capture, open-source defaults need explicit opt-outs, redaction rules for remote URLs and paths, retention policy, and sync controls for these catalog tables.
- Trace/span/session/release/artifact/source-map/process/test-report compatibility projections and first-pass raw replay rebuild exist, but metrics rollups, profiles, replay payloads, attachments, artifact payload storage, source-map symbolication, alerts, dashboard summaries, and richer projection semantics are not implemented yet.
- Process/build/test/dev-server capture has an enriched first-pass `logs run` path with heuristic run classification, raw stream segment events, stream-line categories, compiler/test/dev-server signal extraction, abort finalization, lifecycle summary events, bounded Linux procfs resource summaries with a raw indexed peak-RSS metric, bounded Linux procfs descendant process-tree snapshots, common-output-root artifact discovery, bounded source-map validation projections, bounded JUnit XML test-report metadata discovery, and dedicated SQLite report/case projection rows, but it still lacks portable child process capture, persistent child-process identity rows, cgroup/container accounting, deeper CPU and memory timelines, env allowlists, broad parser-specific test-report coverage beyond common JUnit suite/case attributes, full passing-case matrices, framework-specific dev-server readiness checks, file-watcher semantics, source-map symbolication, and high-volume validation of segment ordering under noisy concurrent output.
- The SDK has first-pass universal event helpers plus browser console/error/rejection/fetch capture, browser redacted `localStorage` spooling, Node/Bun, Fetch API handler, Hono-style, generic Node HTTP, Express-style, Fastify-style request capture, and dependency-light Pino/Winston structured transport helpers. The server/CLI have first OTLP JSON, structured JSON logging, JSONL follow bridges, and pinned installed Pino/Winston package validation. There is still no robust framework adapter suite for Next.js, Vite, workers, broad logger version matrix, full log-rotation tailing, OTLP protobuf/gRPC, or collector/exporter conformance.
- First-pass MCP tool-call and MCP agent-session telemetry exists as raw universal `agent` events with safe argument/result summaries, but MCP schema-validation failures before handler execution, model/provider calls, token/cost fields, file edits, prompt/output capture policy, task/handoff lineage, retry semantics, and external agent SDK integrations are still missing.
- First API SSE streams exist for legacy logs and event catalog records, dashboard live tail uses the generic event-catalog stream with explicit resume and token-capable fetch-backed SSE, CLI watch has local/API event-catalog modes, MCP has bounded cursor polling, and the stream contract is documented. A bounded stream load harness now proves direct SSE delivery, buffer-miss SQLite catch-up, explicit slow-subscriber overflow, 8-consumer API SSE fanout over an 80-event burst, remote CLI watch, local CLI watch, and real MCP cursor polling. A real-browser dashboard lab now proves manual token entry, authorized fetch-backed SSE, pause/resume cursor reconnect through query `last_event_id`, and raw-backed event persistence on both source-server and extracted npm package server paths. Still missing: broader dashboard onboarding/session UX beyond manual token entry, long-running reconnect-after-drop validation, larger high-rate multi-consumer stream load, slow-client soak, and multi-machine stream validation.
- Remote `logs watch --server` has a secured live API integration test for token-authenticated one-shot stream delivery after `Last-Event-ID`, the short real-life lab proves cross-process CLI writes reach a live remote CLI stream plus remote catch-up for a pre-existing post-anchor event, and `bun run validate:streams` now proves bounded direct/CLI/MCP stream cursor behavior plus bounded API fanout. A focused regression also starts a remote watcher before the server exists and proves `stream_read_error` retry reaches a later live event. Long-running reconnect after broken connections, larger high-rate stream fanout, and long-running behavior still need larger harnesses.
- Raw replay, verification, SQLite rebuild, deterministic malformed-line/partial-tail quarantine, CLI doctor commands, and bounded process-level crash/write-error drills exist for raw segments and first-pass compatibility projections; full collector restart during high-volume ingest, realistic disk-full handling, and high-volume repair validation are not implemented yet.
- Segment locking, duplicate producer ID handling, and SQLite busy handling now have small concurrent CLI validation, a bounded 10-process/120-event batch validation, and a retained 10-producer/5,000-event mixed stress run that forces 81 raw segments and proves full raw pointer reconstruction before and after rebuild. True million-event, high-rate, long-running, and noisy real-session validation still need to happen.
- Redaction is still a first pass, but bounded cross-surface canary validation now covers log, universal-event, process/run, export, stream, and default sync-table payloads. Browser replay/input masking, adapter-specific redaction, generated policy controls, and exhaustive dogfood grep are still missing.
- The REST API has a first validation/security pass for current mutation routes and browser write tokens, but framework/browser SDK validation, replay/input masking, adapter-specific rules, and generated-token onboarding are still missing.
- Sync still does not replicate raw segment files or sealed manifests, so remote sync is not yet a complete substrate replication mechanism.
- The first event-catalog read and stream surfaces exist for API, CLI reads/watch, MCP reads/watch, and the dashboard live tail, but existing log-oriented summaries/diagnostics, exports beyond JSON, and many higher-level workflows still need to move from `logs`-table assumptions to the event catalog.
- Bounded high-volume validation exists through the retained 10-producer/5,000-event stress run, but there is still no million-event, high-rate, multi-hour, crash-during-stress, or one-week soak.
- Repo-wide TypeScript now passes; repo-wide Biome lint/format still fails on existing diagnostics.

## Non-goals

- Do not build an AI debugging product first.
- Do not make summaries, automated root cause analysis, or "autofix" the source of value.
- Do not treat Sentry feature parity as the main roadmap.
- Do not store all raw telemetry in SQLite.
- Do not depend on remote sync for local usefulness.
- Do not capture sensitive data casually; broad capture requires stricter redaction and opt-in policies.

## Core Architecture

Current shape:

```text
SDK/API -> SQLite logs table -> query/dashboard/MCP
```

Target shape:

```text
sources
  -> validate
  -> enrich with machine/repo/app/process/run/source identity
  -> classify and redact
  -> append raw event to filesystem segment
  -> write SQLite metadata pointer and indexes
  -> publish to real-time event bus
  -> update replayable projections
  -> expose through CLI/API/dashboard/MCP/export/sync
```

The raw segment is the durable source of truth.

SQLite stores:

- Metadata.
- Pointers into raw files.
- Identity mappings.
- Correlation IDs.
- Search excerpts.
- Indexes.
- Projection offsets.
- Sync cursors.
- Derived issue/alert/summary state that can be rebuilt.

## Universal Event Envelope

Every event should share one envelope:

```json
{
  "schema_version": 1,
  "event_id": "01J...",
  "source_event_id": "optional original id",
  "event_time": "2026-06-16T10:00:00.000Z",
  "ingest_time": "2026-06-16T10:00:01.000Z",
  "type": "log|exception|span|metric|profile|replay|monitor|release|build|process|agent|artifact|network|filesystem|session",
  "severity": "debug|info|warn|error|fatal",
  "privacy": "public|internal|sensitive|secret|pii",
  "source": "browser|node|bun|next|vite|cli|build|test|mcp|agent|scanner|otel|system|pino|winston|structured",
  "machine_id": "machine_...",
  "repo_id": "repo_...",
  "app_id": "app_...",
  "process_id": "proc_...",
  "run_id": "run_...",
  "session_id": "session_...",
  "trace_id": "optional",
  "span_id": "optional",
  "parent_span_id": "optional",
  "release_id": "optional",
  "environment": "development|test|ci|preview|production",
  "message": "human readable summary",
  "body": {},
  "attributes": {}
}
```

Required rules:

- Preserve producer `event_time`.
- Preserve source IDs when producers provide them.
- Generate event IDs when missing.
- Never discard raw payloads unless a privacy rule rejects them.
- Redact before writing raw segments.
- Keep enough indexed metadata for fast search without loading every raw event.

## Data Surfaces To Capture

Minimum universal surfaces:

- Console output: browser console, Node console, stdout, stderr, build logs, test logs.
- Exceptions: uncaught, handled, rejected promises, process crashes, build/test failures.
- Process lifecycle: start, stop, exit code, signal, PID, parent PID, command, cwd, duration.
- Repo context: root, remote, branch, SHA, dirty state, package manager, app/package metadata.
- Machine context: stable machine ID, hostname, OS, arch, CPU/memory basics, timezone.
- Runtime context: Node/Bun/browser version, framework, environment, dev server port/URL.
- HTTP/network: request lifecycle, status, method, URL route pattern, latency, failed requests.
- Browser context: page URL, navigation, resource timing, web vitals, clicks/inputs metadata when safe, user/session IDs when configured.
- Trace/span data: W3C trace context, parent/child spans, operation, status, duration.
- Metrics: counters, gauges, histograms, timings, process/resource metrics.
- Artifacts: source maps, screenshots, profiles, replay segments, build artifacts, attachments.
- Agents: MCP calls, tool calls, shell commands, file edits, task IDs, model/provider metadata when available, token/cost/latency fields when available.
- Monitors: cron check-ins, uptime probes, scanner runs, scheduled jobs.
- Sync metadata: segment manifests, sealed state, upload/download cursors, remote URI, hash.

See [Universal Data Capture Matrix](./universal-data-capture-matrix.md) for the full matrix.

## Phased Roadmap

### Phase 0: Verification and docs reset

Goals:

- Make the docs reflect this corrected direction.
- Make `bun test`, `tsc --noEmit`, `bun run lint`, and build checks reliable.
- Fix contract drift such as `logs diagnose`.
- Keep generated local data out of the repo.
- Document current env vars and data paths.

Done when:

- The planning docs no longer frame built-in AI debugging as the objective.
- Verification commands and known failures are tracked.
- The repo has a trustworthy baseline before storage changes.

### Phase 1: Raw filesystem event store

Goals:

- Add append-only JSONL segment writer.
- Add segment manifests, hashes, byte offsets, byte lengths, and rotation.
- Add crash recovery from partial lines.
- Add replay tooling that rebuilds SQLite metadata from segments.
- Keep current `/api/logs` and CLI behavior compatible through an adapter.

Done when:

- A log can be reconstructed exactly from raw segment path, offset, and length.
- SQLite can be deleted and rebuilt from raw segments for the supported event subset.
- Batch ingest preserves producer timestamps and IDs.

### Phase 2: SQLite metadata catalog

Goals:

- Add catalog tables for segments, records, machines, repos, apps, processes, runs, sources, traces, spans, sessions, releases, artifacts, projection offsets, and sync cursors.
- Add indexes for time, source, severity, type, repo, app, process, run, machine, trace, span, session, and text search.
- Add schema migration ledger and compatibility checks.

Done when:

- Queries can filter by identity and correlation dimensions.
- Raw payload access is on-demand through segment pointers.
- Derived projections are explicitly rebuildable.

### Phase 3: Universal identity

Goals:

- Generate and persist machine ID.
- Detect repo root, remote, branch, SHA, dirty state, package metadata, and package manager.
- Track process/run identity for every local capture source.
- Track CI and dev-server metadata.

Done when:

- Every captured event from local commands and apps can be attributed to machine, repo, process, and run when those dimensions exist.

### Phase 4: Process, CLI, build, and test capture

Goals:

- Add `logs run -- <cmd>`.
- Capture stdout/stderr as structured line events and raw stream segments.
- Capture exit status, duration, signal, output classification, lifecycle summaries, resource usage where available, child process tree, test summaries, and build errors.
- Support bun, npm, pnpm, node, vite, next, tsc, eslint, test runners, and arbitrary commands.

Done when:

- Running real build/test/dev commands produces searchable and reconstructable raw telemetry.
- Live tail shows output in real time.
- Failed runs have enough context for an agent to inspect without rerunning.

### Phase 5: Runtime and framework capture

Goals:

- Build SDKs/adapters for browser, Node, Bun, Next.js, Vite, Hono/Express/Fastify, workers, and generic HTTP/fetch.
- Capture errors, logs, requests, route context, fetch failures, web vitals, resource timing, and framework metadata.
- Add retry and buffering for browser capture.

Current implementation slice:

- `initUniversalLogs` now dispatches to browser or Node/Bun runtime capture from the same SDK entrypoint.
- Browser capture queues console `debug`/`log`/`info`/`warn`/`error`, browser `error` events, browser `unhandledrejection` events, browser `fetch` HTTP spans, and browser thrown fetch network errors as universal events. Browser fetch telemetry skips collector-recursion requests and canonicalizes relative app request URLs against `location.href`.
- Browser capture can opt into page-load and route-change spans with `captureNavigation`, wrapping History API `pushState`/`replaceState` and listening for `popstate`/`hashchange`. It can also opt into bounded Performance Resource Timing spans with `captureResourceTiming` and `maxResourceTimingEvents`, preserving initiator, timing, transfer size, body size, response status, URL, and collector-resource exclusion metadata. `captureWebVitals` emits bounded browser `metric` events for FCP, LCP, CLS, FID, and INP candidates with Web Vital name, value, unit, rating, entry metadata, and `operation=browser.web_vital`; once `maxWebVitalEvents` is reached, it stops processing, disconnects registered Web Vital observers, and clears transient dedupe memory. `propagateTrace` injects or preserves W3C `traceparent` headers for captured fetches, never overwrites an existing effective traceparent header even when malformed, uppercase-value malformed, version-invalid, or duplicate array-form headers normalize to an invalid comma-joined value, suppresses browser `mode: "no-cors"` propagation with `traceparent_suppressed: "no-cors"`, suppresses browser non-HTTP(S) propagation such as `blob:` with `traceparent_suppressed: "non-http"`, records trace/span IDs on emitted client spans when a valid lowercase W3C traceparent is present, defaults browser propagation to same-origin HTTP(S) requests, and supports explicit `tracePropagationTargets` with exact-origin matching for absolute string targets.
- Browser capture can opt into a bounded redacted `localStorage` spool with `browserSpool` or `browserSpoolKey`; failed flushes keep batches queued, same-page first sends preserve original in-memory event detail, post-failure retries use the redacted spool event, overlapping flushes are serialized, reload replay uses only redacted persisted events, persisted records are validated before redaction, and corrupt or invalid-only persisted browser spools are removed instead of replayed.
- Node/Bun capture queues console debug/log/info/warn/error, process start/beforeExit, fatal exceptions through `uncaughtExceptionMonitor`, opt-in unhandled rejections, and generic `fetch` success/failure spans as universal events with process/run context.
- Collector self-fetches are ignored by fetch instrumentation so SDK flushes do not recursively generate spans.
- `instrumentFetchHandler` and `captureHttpRequest` wrap Fetch API style request handlers, preserve W3C `traceparent` correlation, capture route/path/status/duration as `http.server` spans, emit exception events on thrown handlers, avoid query-string capture by default, and only include allowlisted request/response headers.
- `createHonoTelemetryMiddleware` provides a first Hono-style structural middleware adapter without adding a hard package dependency; route resolution happens after `next()` so Hono's matched endpoint route is captured instead of the middleware mount path.
- `captureNodeHttpRequest`, `createExpressTelemetryMiddleware`, `createExpressErrorTelemetryMiddleware`, and `createFastifyTelemetryHooks` provide first structural Node HTTP, Express-style, and Fastify-style adapters without hard framework dependencies. They capture status after response finish, resolve framework route templates where available, preserve W3C `traceparent`, emit request exception events when captures finish with errors, observe request/response errors through Node's non-consuming `errorMonitor` when available, capture request aborts as `499` closed-response spans, clean up structural event listeners after finish/stop, avoid query-string capture by default, and only include allowlisted request/response headers.
- The standalone SDK build now emits declaration files, including `sdk/dist/index.d.ts`, so package consumers can see the request-adapter APIs.

Done when:

- A sample browser app, Node server, fetch-native route handler, Hono app, Next app, and Vite app all emit correlated telemetry into the same local collector.

### Phase 6: Agent and MCP telemetry

Goals:

- Capture MCP calls, tool calls, shell commands, task IDs, file edits, agent session state, run IDs, model/provider metadata where available, token/cost/latency fields where available, and errors/retries.
- Expose agent-friendly MCP tools for search, context retrieval, run inspection, and live tail.

Done when:

- Another agent can inspect a task/run/session and retrieve the relevant logs, commands, files, errors, and raw evidence.

### Phase 7: Real-time stream

Goals:

- Add ingest event bus.
- Add resumable SSE or WebSocket streams.
- Add bounded buffers, overflow markers, SQLite catch-up fallback, and backpressure semantics.
- Use the same stream from dashboard, CLI watch, MCP, and SDK consumers.

Done when:

- A stream can disconnect and reconnect with `Last-Event-ID`.
- High-volume input does not silently corrupt or lose indexed data.
- Slow clients get explicit overflow information.

### Phase 8: Privacy, security, and open-source defaults

Goals:

- Add generated local secret.
- Replace static encryption defaults.
- Add API tokens outside explicit trusted-local mode.
- Restrict CORS.
- Add privacy classification and redaction before raw segment write.
- Add env allowlists, path/token scrubbing, replay/input masking, and sensitive-data sync policies.

Current implementation slice:

- The server locks `/api/*` by default. It requires `Authorization: Bearer <token>` or `X-Logs-Token: <token>` when `HASNA_LOGS_API_TOKEN` or `LOGS_API_TOKEN` is set, and no-token loopback access requires explicit trusted local mode through `logs-serve --local-open`, `HASNA_LOGS_LOCAL_OPEN=1`, or `LOGS_LOCAL_OPEN=1`.
- Page-auth credentials use AES-GCM with either `HASNA_LOGS_SECRET_KEY`/`LOGS_SECRET_KEY` or a generated per-data-dir `page-auth.key` stored with `0600` permissions; the previous reusable hardcoded fallback key is gone.
- `POST /api/logs` and restricted `POST /api/events` browser-safe event writes accept hashed, project-bound browser ingest tokens via `X-Logs-Browser-Token` or `X-Logs-Write-Token`; browser tokens cannot read, export, stream, or call admin routes.
- `/api/logs` validates content type, JSON parseability, allowed fields, enum values, optional string types, metadata shape, payload bytes, batch length, and message length before ingest.
- Successful log ingest publishes to an in-process event bus after raw/SQLite persistence. `/api/logs/stream` subscribes to that bus and uses SQLite as the catch-up fallback for `Last-Event-ID`, buffer misses, and cross-process database writes.
- Project, page, page-auth, retention, job, alert, and issue mutation routes use the shared JSON object parser and route-specific validators for content type, invalid JSON, payload bytes, known fields, required fields, field types, URLs, enums, and numeric bounds.
- The served browser script reads `data-browser-token`/`data-write-token` and sends the scoped token on flush; SDK browser capture supports the same write token without sending it on read/admin methods.
- Production CORS permits localhost origins by default and supports explicit comma-separated origin allowlists via `HASNA_LOGS_CORS_ORIGINS` or `LOGS_CORS_ORIGINS`.
- Tests prove rejected HTTP payloads do not insert SQLite rows, protected API reads/exports/streams/admin routes reject missing tokens, browser tokens can write only scoped browser logs plus restricted browser-safe universal events and cannot read/admin, revoked/wrong-origin browser tokens fail, nested identity spoofing and cross-project producer-ID reuse are rejected or remapped, CORS origin resolution rejects unconfigured remote origins, and an HTTP redaction canary is absent from both SQLite response data and raw segment records.

Done when:

- The app can safely run against real developer repos without casually storing secrets.
- Sync never includes sensitive data by default.

### Phase 9: Retention, sync, and operations

Goals:

- Add segment retention, compression, compaction, backup, restore, repair, and sync.
- Replace mutable table-copy sync with sealed segment replication plus metadata cursors.
- Add storage usage reports by app, repo, machine, type, and privacy class.

Done when:

- A local store can be backed up, repaired, compacted, and optionally synced across machines.

### Phase 10: Real-life validation lab

Goals:

- Build repeatable validation scenarios using tmux or equivalent concurrent sessions.
- Run collector, live stream, CLI commands, build/test/dev-server commands, browser apps, Node servers, high-volume logs, crash/restart cases, and sync/replay checks.
- Record evidence through `todos record-verification` or equivalent.

Done when:

- Real concurrent sessions prove that raw files plus SQLite metadata reconstruct all expected events.
- Stream resume, crash recovery, high-volume ingest, redaction, and query correctness are demonstrated.

### Phase 11: Adversarial acceptance gate

Goals:

- Run two independent adversarial reviews against implementation and validation evidence.
- Any serious gap creates follow-up tasks.

Done when:

- Both reviewers agree that the app captures the necessary data categories, preserves raw evidence, indexes and correlates correctly, streams reliably, survives realistic failures, and protects sensitive data.

## Latest Verification Evidence

Latest local evidence captured on 2026-06-19:

- `bun test src/lib/event-bus.test.ts src/server/server.test.ts`: 40 passing tests covering event-bus filters, bounded replay membership, subscriber overflow markers, live SSE delivery, `Last-Event-ID` SQLite catch-up, and unknown-anchor overflow events.
- `bun test src/lib/events.test.ts src/server/server.test.ts src/cli/events.test.ts src/mcp/index.test.ts`: 43 passing tests covering event-catalog search, raw envelope reconstruction, API event reads/exports, CLI `logs events`, and MCP event tool registration.
- `bun test src/lib/universal-ingest.test.ts src/server/server.test.ts src/cli/events.test.ts src/mcp/index.test.ts src/lib/events.test.ts`: 51 passing tests covering first universal raw-first event ingest, non-log span persistence, redaction before raw append including top-level source event IDs, duplicate event ID and source event ID idempotency, exception issue projection, `POST /api/events` single/batch validation, invalid batch prevalidation, CLI `logs events push`, and MCP event tool registration.
- `bun test src/server/server.test.ts src/lib/event-bus.test.ts src/lib/command-runner.test.ts src/lib/universal-ingest.test.ts src/lib/ingest.test.ts src/lib/events.test.ts`: 72 passing tests covering catalog bus filters/overflow/replay membership, log/universal/process publication into the catalog bus, `/api/events/stream` live non-log delivery, SQLite-only first matching event catch-up, `Last-Event-ID` event-record catch-up, optional raw inclusion, and unknown-anchor overflow.
- `bun test src/server/server.test.ts src/cli/events.test.ts src/lib/event-bus.test.ts src/mcp/index.test.ts`: 84 passing tests and 435 expectations covering generic event-channel SSE, dashboard-compatible payloads, token-protected event streams, local event-catalog watch JSON output, local `--last-event-id` watch catch-up, explicit local and API missing-cursor markers with usable anchors, secured remote `logs watch --server` stream delivery, remote `stream_read_error` retry after an initial connection failure, and MCP `event_watch` cursor polling.
- `bun test src/mcp/index.test.ts`: 8 passing tests and 52 expectations covering MCP tool registration, `event_watch` cursor polling with explicit missing-cursor markers, identity-safe `event_push`, durable MCP tool-call telemetry, handler-level failed MCP tool telemetry, safe argument summaries that do not persist a canary argument value by default, default exclusion of internal MCP tool telemetry from MCP search/watch, explicit `include_internal` inspection, and durable MCP agent registration/heartbeat/focus events.
- `bun test src/lib/command-runner.test.ts src/cli/run.test.ts`: 14 passing tests and 286 expectations covering process lifecycle capture, raw-backed stdout/stderr rows, raw process stream segments including invalid UTF-8 bytes, observed stdout/stderr persistence-order metadata, split-argument command redaction including prefixed secret flags, invalid-byte and cross-read output segment redaction before base64 storage, abort-finalized dev-server runs, local machine/repo/app attribution, unknown-project handling, stream-line build/test/dev-server classification, diagnostic code extraction, local URL/port extraction, raw indexed `build` lifecycle summary events, raw-backed build artifact metadata events without file contents, artifact path redaction before returned summaries and process/run metadata, live SQLite `artifacts` rows, raw replay recovery for artifact projections, bounded JUnit XML test-report metadata events without report body/stdout/stderr/failure body persistence, test-report path and parsed-attribute redaction, unsafe DTD/entity rejection, and rebuild recovery of command-runner final status plus lifecycle test-report metadata from raw process-exit and lifecycle-summary evidence.
- `bun test src/lib/redaction-canary.test.ts`: 1 passing test and 46 expectations covering a cross-surface canary grep over raw replay, decoded process chunks, SQLite rows, event catalog exports, legacy log JSON/CSV exports, log/universal/agent/process event stream payloads, default storage-sync table payloads, command-run results, redacted command arrays, and redacted working directories.
- `bun test src/lib/redaction-canary.test.ts src/lib/ingest.test.ts src/lib/universal-ingest.test.ts src/lib/command-runner.test.ts src/lib/events.test.ts src/lib/storage-sync.test.ts src/cli/storage.test.ts`: 32 passing tests and 281 expectations covering redaction, event exports, command output redaction, event-stream redaction, redacted command result fields, and default sync-table safety.
- `bun test src/db/index.test.ts src/lib/universal-ingest.test.ts src/lib/event-store.test.ts src/lib/command-runner.test.ts src/cli/storage.test.ts`: 37 passing tests and 478 expectations covering raw segment verification, tamper detection, orphan raw event recovery, index rebuild, rebuild lock exclusion, segment rotation/sealing, first-pass compatibility projection rebuild for `logs`, `issues`, `traces`, `spans`, `sessions`, `releases`, `artifacts`, `test_reports`, `test_cases`, `processes`, and `runs`, session and trace earliest-`started_at` enrichment, span-only process/run rebuild parity, command-runner final status recovery from raw process-exit and lifecycle-summary events, command-runner build artifact discovery with live SQLite `artifacts` rows and raw replay recovery, bounded JUnit XML report metadata events with live SQLite `test_reports`/`test_cases` rows and raw replay recovery, live universal-ingest/rebuild parity for external test-report `build` events without synthetic `runs` or `processes` rows, external test-report metadata allowlisting that keeps caller-provided failure/system-out/raw-XML fields out of SQLite/Postgres-syncable metadata before and after rebuild, storage status visibility for projection sync tables, and live universal-ingest placeholder enrichment for artifact-before-release, trace-detail, and session-detail ordering.
- `bun test src/lib/test-reports.test.ts src/server/server.test.ts src/cli/events.test.ts src/mcp/index.test.ts src/lib/universal-ingest.test.ts src/lib/command-runner.test.ts`: 102 passing tests and 774 expectations covering test-report query helpers, API routes, CLI commands, MCP tools, bounded external case projection, aggregate failed-report filters, and parse-diagnostic redaction before query responses can expose raw-looking XML/system-output/failure payloads.
- `bun test src/lib/event-store.test.ts src/cli/doctor.test.ts`: 18 passing tests and 1677 expectations covering raw segment verification/rebuild, rebuild lock exclusion, bounded multi-process segment rotation/rebuild proof, bounded process-level crash/write-error recovery, plus `logs doctor repair-segments` dry-run/apply behavior, exact-byte quarantine files, quarantine manifests, segment rewrite, rebuild, repeated-apply idempotence, and post-repair verification.
- `bun run validate:stress -- --keep`: passes and retains `/tmp/open-logs-high-volume-stress-AtCHHl/high-volume-ingest-stress-report.json` with 10 producers, 5,000 mixed event records, 81 segment rows/files, 0 missing expected IDs, 0 duplicate event IDs, full raw pointer reconstruction for 5,000 events before rebuild and 5,000 events after rebuild, SQLite `integrity_check` ok, 0 foreign-key violations, `doctor segments` checking 5,000 records/raw events with 0 unindexed raw events, `doctor rebuild-index` reindexing 5,000 events and 81 segments with 0 skipped events, and 113.52 aggregate events/sec with active segment hashing disabled for the stress path.
- `bun run validate:real-life -- --keep`: passes and retains `/tmp/open-logs-real-life-lab-NJZ95y/real-life-validation-report.json` with 60 event records, 60 checked raw events, 1 raw segment, 0 unindexed raw events, one raw-backed test-report event `run_fdf3381f6be6d15e42dcd6d8-test-report-5b5a9b71227bc214`, one SQLite `test_reports` row, zero SQLite `test_cases` rows for the passing report, real authenticated API test-report list/get query counts of 1/0 cases, real local CLI test-report list/get query counts of 1/0 cases, real MCP stdio test-report search/get query counts of 1/0 cases, two raw-backed artifact events, two SQLite `artifacts` rows, one SQLite `source_maps` row, one SQLite `source_map_sources` row, source-map JavaScript linkage from `dist/real-life-lab.js.map` to `dist/real-life-lab.js`, hashed-only source evidence for `src/real-life-lab.ts`, source-content canaries absent from collector-owned report/export/raw/SQLite evidence, and retained forbidden scans with no `raw_json`, `sourcesContent`, `mappings`, `sections`, or `redaction` source-map projection leakage.
- `bun run validate:streams -- --keep`: passes and retains `/tmp/open-logs-stream-load-q2aFBk/stream-load-validation-report.json` with 141 event records, 1 raw segment, direct generic SSE delivery of 30/30 expected events with raw envelopes, `Last-Event-ID` buffer-miss SQLite catch-up delivery of 7/7 post-anchor events with `buffer_miss_sqlite_catchup`, slow-subscriber recovery delivery of 14/14 burst events with `subscriber_queue_overflow`, bounded multi-consumer API SSE fanout delivering 80/80 burst events to each of 8 consumers for 640/640 expected deliveries with no overflow, remote CLI watch delivery of 1/1 post-cursor event without replaying its anchor, local CLI watch delivery of 1/1 post-cursor event without replaying its anchor, MCP stdio `event_watch` delivery of 2/2 post-cursor events with raw envelopes and `anchor_replayed: false`, MCP missing-cursor `last_event_id_unknown`, no duplicate observed event IDs in stream scenarios, and `doctor segments` reporting 141 checked raw events with 0 unindexed raw events.
- `bun run validate:dashboard-stream -- --keep`: passes and retains `/tmp/open-logs-dashboard-stream-lab-f1Ji0B/dashboard-stream-validation-report.json` with one built dashboard served by the source API server and then by `dist/server/index.js` from an extracted npm package whose tarball includes `dashboard/dist/*`, Chromium stream request evidence for each server path showing one unauthenticated blocked request, one authorized request after token entry, and one authorized reconnect request with query `last_event_id`, rendered first/paused/post-resume metric events for each path, 6 raw-backed dashboard validation events, 1 segment, 6 checked raw events, and 0 unindexed raw events.
- `bun test src/lib/otlp-ingest.test.ts`: 6 passing tests and 39 expectations covering first-pass OTLP JSON trace/log/metric translation, resource/scope preservation, trace/span/service/environment/host indexing, non-promotion of `process.pid` to global `process_id`, span/trace projections, histogram/gauge datapoints, resource/scope/ordinal-aware retry deduplication, cross-service and same-resource log duplicate-collision regressions, signal-shape, nested-array, and metric-container rejection, and redaction before raw replay for OTLP canaries.
- `bun test src/server/server.test.ts -t "POST /api/otel"`: 3 passing tests and 17 expectations covering the `/api/otel/v1/traces`, `/api/otel/v1/logs`, and `/api/otel/v1/metrics` HTTP routes, event-catalog visibility, malformed top-level and nested payload rejection, and browser-token rejection for OTLP writes.
- `bunx biome check src/lib/otlp-ingest.ts src/lib/otlp-ingest.test.ts src/server/routes/otel.ts`: passes for the new OTLP bridge implementation, focused tests, and route file.
- `./node_modules/.bin/tsc --noEmit --pretty false`: passes after adding the OTLP JSON ingest bridge.
- `bun test src/lib/structured-logs.test.ts src/cli/import-jsonl.test.ts`: 12 passing tests and 62 expectations covering Pino and Winston structured JSON normalization, preserved original payload redaction, raw-backed event indexing, retry-stable IDs, transport-generated `_open_logs_event_id` stability when retry batch positions change, repeated identical JSONL line preservation through line-position fallback, repeated singleton no-producer-ID preservation, producer-ID redaction before raw persistence, invalid project preflight before append, malformed record rejection, CLI invalid-format rejection, one-shot CLI JSONL import, `logs import-jsonl --follow` ingestion of appended JSONL before idle timeout, hard `--max-lines` behavior for already-readable burst files, `byte_offset` position metadata, and UTF-8 preservation across the follow-mode read buffer boundary.
- `bun test src/server/server.test.ts -t "POST /api/logs/structured"`: 3 passing tests and 19 expectations covering structured log HTTP ingest for Pino and Winston payloads, malformed request rejection before ingest, browser/script source-spoof rejection, missing-project preflight without unindexed raw records, and browser-token rejection for server-side structured logs.
- `bunx biome check src/lib/structured-log-follow.ts src/lib/structured-logs.ts src/cli/import-jsonl.test.ts scripts/structured-log-validation-lab.ts`: passes for the structured-log follow importer, focused CLI tests, and validation lab script.
- `./node_modules/.bin/tsc --noEmit --pretty false`: passes after adding the structured logging bridge and JSONL follow validation lab.
- `bun test src/lib/sdk-client.test.ts`: 53 passing tests and 412 expectations after adding `LogsClient.pushStructuredLog(s)`, dependency-light Pino and Winston structured transport helpers, Winston stream-compatible writes, Winston legacy-wrapper normalization, final flush-on-stop/close regressions, bounded retry/drop queue regressions, in-flight batch protection under queue pressure, per-record retry exhaustion, stable transport-generated retry event IDs across rebatching, opt-in redacted Node/Bun file spool replay after restart while preserving the live in-memory send path, redacted send-context preservation, secret-bearing batch-prefix redaction, malformed/unsupported spool-line skipping with `spool_errors`, load-time overflow drop reporting, opt-in browser universal-event `localStorage` spooling across reload with redaction and invalid-record skipping, post-failure browser retry redaction, corrupt/invalid-only browser spool cleanup, overlapping browser flush serialization, failed in-flight browser batch preservation at queue capacity, browser console-level capture, browser fetch span/network capture with relative URL canonicalization, opt-in browser navigation/resource timing/Web Vitals capture including capped Web Vital observer shutdown under a flood, opt-in browser and Node/Bun fetch traceparent propagation, valid, invalid, uppercase-value-invalid, version-invalid, duplicate effective existing, browser no-cors-suppressed, same-origin non-HTTP/blob-suppressed, and absolute target exact-origin traceparent behavior, browser same-origin default propagation, browser relative collector recursion prevention, browser runtime opt-out flags, browser-token identity stripping for `/api/events`, browser listener cleanup on stop, and `@hasna/logs-sdk/pino` plus `@hasna/logs-sdk/winston` package subpath build outputs.
- `bun test src/server/server.test.ts -t "allows scoped browser ingest tokens"`: 1 passing test and 47 expectations covering browser-token project forcing for `/api/logs` and `/api/events`, SDK `LogsClient` browser-token event writes against the real Hono route without server-forbidden identity fields, invalid browser event source/type rejection, nested and top-level identity-spoof rejection, origin enforcement, token redaction, and project-scoped browser producer IDs.
- `bun test src/lib/sdk-client.test.ts src/lib/structured-logs.test.ts src/cli/import-jsonl.test.ts`: 49 passing tests and 278 expectations covering SDK structured sends, Pino/Winston transport helper payloads, Winston legacy-wrapper and stream-write behavior, bounded retry/drop queue behavior, in-flight batch protection under queue pressure, per-record retry exhaustion, stable transport-generated retry event IDs across rebatching, redacted file-spool replay after restart, redacted send-context preservation, secret-bearing batch-prefix redaction, malformed/unsupported spool-line skipping, load-time overflow drop reporting, live-path original record preservation, final transport shutdown flushes, structured mapper behavior, JSONL import, and JSONL follow mode.
- `bun run validate:structured-logs -- --keep`: passes and retains `/tmp/open-logs-structured-log-lab-RiCUay/structured-log-validation-report.json` with one token-secured server, remote `logs watch --server`, local `logs import-jsonl --follow`, HTTP `/api/logs/structured`, SDK Pino/Winston transport helper writes, 6 live streamed structured log messages, 6 logs, 6 event records, 1 event segment, source counts `pino=3` and `winston=3`, 6 raw event reconstructions, no canary leak in raw or SQLite rows, and `doctor segments` reporting checked raw events with 0 unindexed raw events.
- `bun run validate:logger-packages -- --keep`: passes and retains `/tmp/open-logs-logger-package-lab-1l5gy5/logger-package-validation-report.json` with one token-secured server, remote `logs watch --server`, installed `pino@10.3.1`, installed `winston@3.19.0`, SDK Pino/Winston transport helper writes, a real Pino collector-down file-spool write, server restart replay of that spooled record with preserved transport metadata context, 2 live streamed structured log messages, 3 logs, 3 event records, 1 event segment, source counts `pino=2` and `winston=1`, 3 raw event reconstructions, `spooled_context_rows=1`, no canary leak in raw or SQLite rows, redacted local spool evidence, and `doctor segments` reporting checked raw events with 0 unindexed raw events.
- `bun run validate:browser-spool -- --keep`: passes and retains `/tmp/open-logs-browser-spool-lab-WMXMd4/browser-spool-validation-report.json` with one token-secured server, API-created project, API-created browser token with normalized `allowed_origins`, wrong-origin rejection with HTTP 401, real Chromium app bundle, first browser proxy send returning 503 with the live canary-bearing event and explicit browser-token header, redacted `localStorage` spool evidence without the canary, reload replay returning 201 with `[REDACTED]`, without the canary, and with explicit browser-token header, browser-token project assignment, 1 raw-backed browser `event_records` row, raw segment reconstruction, localStorage cleanup after replay, and `doctor segments` reporting 1 checked raw event with 0 unindexed raw events.
- `bun run validate:browser-runtime -- --keep`: passes and retains `/tmp/open-logs-browser-runtime-lab-2tkApL/browser-runtime-validation-report.json` with one token-secured server, API-created project, API-created browser token with normalized `allowed_origins`, real Chromium app bundle configured with the relative SDK collector URL `/collector`, one scoped browser-token `/api/events` write carrying 26 browser runtime events, console `debug`/`log`/`info`/`warn`/`error` event coverage, browser error and unhandled-rejection exception coverage, browser fetch span coverage for HTTP 204 and 503 with absolute URLs and propagated `traceparent` on same-origin fetches, explicit CORS-enabled cross-origin target coverage where the listed second origin observed a valid `traceparent`, its preflight requested `traceparent`, and the browser span linked to a raw-backed server request span, unlisted CORS-enabled cross-origin target coverage where the server observed `traceparent=null`, the preflight requested `x-open-logs-lab` and not `traceparent`, and exactly one browser span had no trace ID, fallback `span_...` shape, and no traceparent propagation/existing/suppression state, real no-cors fetch coverage where the app server observed `traceparent=null` and the browser span recorded `traceparent_suppressed: "no-cors"` without a trace ID, same-origin blob fetch coverage where the browser span recorded `traceparent_suppressed: "non-http"` without a trace ID, thrown fetch network-error coverage with `TypeError`, page-load and History API `pushState` navigation span coverage, resource timing span coverage for `link`/`script`/`fetch` initiators, duplicate buffered resource timing entries excluded, Web Vital metric coverage for FCP and LCP with `operation=browser.web_vital`, three raw-backed Node server request spans for `/ok`, `/fail`, and `/cross-origin`, three browser-server trace links where server `parent_span_id` equals the browser client span ID, no collector self-fetch or collector resource-timing span in the flushed runtime events, 26 browser `event_records`, 3 server `event_records`, 29 total event records, 1 raw segment, no canary leak in the retained report/raw/SQLite rows, raw redaction markers present, and `doctor segments` reporting 29 checked raw events with 0 unindexed raw events.
- `bun test src/server/server.test.ts -t "GET /api/events/stream"`: 9 passing tests covering event-catalog SSE live delivery, generic `event_name=event`, `Last-Event-ID` catch-up, SQLite-only polling, rowid catch-up before later bus events, deterministic slow-subscriber overflow recovery, log catalog events, process lifecycle events, and unknown-anchor overflow.
- `bun test src/lib/event-store.test.ts src/cli/doctor.test.ts src/lib/command-runner.test.ts`: 25 passing tests and 1795 expectations covering raw segment repair, bounded process-level crash/write-error recovery, plus command-runner raw writer regressions, including repair rebuilding a raw event before a producer's late `indexRawEvent` call.
- `bun test src/lib/event-bus.test.ts src/server/server.test.ts src/lib/browser-script.test.ts src/lib/ingest.test.ts src/lib/event-store.test.ts src/lib/command-runner.test.ts src/lib/storage-sync.test.ts src/cli/storage.test.ts`: 73 passing tests across the server, event bus, browser script, raw store, redaction, command runner, and storage sync slices.
- `bun test`: 354 passing tests and 4001 expectations across 40 files as of 2026-06-19 after the MCP HTTP stdio/default-port regression coverage, security-default hardening, packaged dashboard validation, and the prior raw/event/SDK/browser/process/test-report validation slices.
- `bun run build`: passes for Bun CLI, MCP, server, package entrypoint, and storage entrypoint.
- `bun run build:dashboard`: passes after dashboard live tail moved to fetch-backed `/api/events/stream?event_name=event` with token-capable authorization headers, explicit resume, and event catalog entries. Vite still reports the existing large-chunk warning.
- `cd sdk && bun run build`: passes for the standalone SDK package, including Pino/Winston subpath JavaScript and declaration outputs.
- built `sdk/dist/index.js`, `sdk/dist/pino.js`, and `sdk/dist/winston.js` import smoke: passes.
- `bunx biome check scripts/browser-spool-validation-lab.ts src/lib/sdk-client.test.ts`: passes for the real-browser validation lab and focused SDK client regressions covering browser spool replay/cleanup, post-failure retry redaction, overlapping flush serialization, and browser-token identity stripping. At that earlier slice, broader Biome checks over SDK source hit pre-cleanup whole-file formatting/import/lint diagnostics; current repo-wide lint passes.
- `bunx biome check scripts/browser-runtime-validation-lab.ts src/lib/sdk-client.test.ts`: passes for the real-browser runtime validation lab and focused SDK client regressions covering browser console/error/rejection/fetch runtime capture, opt-in navigation/resource timing/Web Vitals capture, opt-in traceparent propagation, relative URL canonicalization, relative collector recursion prevention, fetch capture opt-out, and browser-token identity stripping.
- `./node_modules/.bin/tsc --noEmit --pretty false`: passes repo-wide after adding the structured logging bridge and prior typed SQLite named-binding, server-side Bun SQLite binding, scanner performance timing, and stale external CLI command fixes.
- `bun test src/lib/command-runner.test.ts src/cli/events.test.ts src/mcp/index.test.ts`: 16 passing tests and 123 expectations proving `logs run`, local `logs events push`, and MCP `event_push` persist machine/app identity and catalog rows, with repository identity asserted when git metadata is available. Regressions also prove invalid CLI/MCP event payloads do not mutate identity tables, unknown project IDs do not reach FK-backed app identity upserts or log persistence, and explicit CLI/MCP machine/repo/app identity skips local machine/repo/app discovery side effects.
- `bun test src/lib/sdk-client.test.ts src/server/server.test.ts`: 110 passing tests and 680 expectations covering SDK universal event payloads, one-item event batches, non-2xx response errors, browser auto-capture queue/flush, browser `localStorage` spool replay/cleanup, post-failure browser retry redaction, overlapping browser flush serialization, failed in-flight browser batch preservation at queue capacity, browser console/error/rejection/fetch runtime capture, opt-in browser navigation/resource timing/Web Vitals capture with capped observer shutdown, opt-in browser/Node fetch traceparent propagation and valid/invalid/uppercase-value-invalid/version-invalid/duplicate/no-cors-suppressed/non-HTTP-blob-suppressed/absolute-target-origin traceparent behavior, browser relative fetch URL canonicalization, browser relative collector recursion prevention, browser runtime opt-out flags, SDK browser-token identity stripping against the real `/api/events` route, Node/Bun console/process/fetch auto-capture, fetch-native inbound request spans, Hono-style middleware spans, generic Node HTTP capture, Express-style middleware route resolution, Express-style error middleware, non-consuming Node request/response `errorMonitor` capture, request-aborted `499` spans, listener cleanup assertions, Fastify-style hooks, malformed Node host fallback, delimiter-bearing Host rejection, request exception telemetry, non-mutating fatal exception monitor registration, exact fetch restoration, collector self-fetch recursion avoidance, lookalike collector host capture, exception/metric/span helper shapes, scoped browser-token writes to `/api/events`, top-level and nested identity-spoof rejection, raw token metadata redaction, and project-scoped browser producer IDs.
- `bun test src/lib/sdk-client.test.ts`: 53 passing tests and 412 expectations for SDK event methods, browser/Node runtime auto-capture, browser spool/retry behavior, browser console/error/rejection/fetch runtime capture, opt-in browser navigation/resource timing/Web Vitals capture with capped observer shutdown, opt-in browser/Node fetch traceparent propagation and valid/invalid/uppercase-value-invalid/version-invalid/duplicate/no-cors-suppressed/non-HTTP-blob-suppressed/absolute-target-origin traceparent behavior, browser relative collector recursion prevention, Fetch/Hono request adapters, generic Node HTTP capture, Express-style middleware and error middleware, Fastify-style hooks, request error telemetry, non-consuming request/response error monitoring, request-aborted `499` spans, listener cleanup, malformed host fallback, delimiter-bearing Host rejection, and adapter privacy behavior.
- Focused typecheck filter for changed event-bus/ingest/stream/server-test files produces no diagnostics.
- Focused typecheck filter for changed event-catalog/API/CLI/MCP files produces no diagnostics.
- Focused typecheck filter for changed universal-ingest/event API/CLI/MCP files produces no diagnostics.
- Focused typecheck filter for changed catalog bus, ingest, universal-ingest, command-runner, event route, and server test files produces no diagnostics.
- `bunx biome check src/lib/command-runner.ts src/lib/command-runner.test.ts src/lib/redaction.ts src/cli/index.ts`: passes for the touched process/build telemetry files.
- `bunx biome check src/lib/event-store.ts src/lib/event-store.test.ts src/lib/universal-ingest.ts src/lib/universal-ingest.test.ts src/lib/command-runner.ts src/lib/command-runner.test.ts`: passes for the touched raw replay/projection recovery, live universal-ingest projection, and command-runner status recovery files.
- `bunx biome check src/db/pg-migrations.ts src/lib/test-report-projections.ts src/lib/command-runner.ts src/lib/command-runner.test.ts src/lib/event-store.ts src/lib/universal-ingest.ts src/lib/universal-ingest.test.ts scripts/real-life-validation-lab.ts` and `./node_modules/.bin/tsc --noEmit --pretty false`: pass for the command-runner test-report metadata, dedicated SQLite projection, external-ingest metadata allowlist, replay, and validation-lab slice.
- Root `tsconfig.json` is now scoped to `src/**/*.ts` and `src/**/*.tsx`; dashboard browser typing is checked by `bun run build:dashboard`.
- Repo-wide `bun run lint` now passes across `src/` as of 2026-06-19.

## Created Todo Plan

This work is tracked in the local `todos` plan:

- Plan: `Universal telemetry data substrate`
- Plan id: `7c944b3a-c57f-4f77-8691-98b2ccb359eb`

Core tasks include:

- Correct docs toward universal telemetry data substrate.
- Stabilize repository verification gates.
- Define universal telemetry envelope and data taxonomy.
- Implement append-only raw event segment store.
- Build SQLite metadata catalog and correlation indexes.
- Implement validate-enrich-redact ingest pipeline.
- Capture machine, repo, app, process, and run identity.
- Capture process, CLI, build, test, and dev-server telemetry.
- Completed process/build subtasks: `c500f19e-3afc-4d5c-860f-41dcbcd104cd` covers bounded `logs run` common-output-root artifact metadata, raw artifact events, SQLite `artifacts` rows, real-life validation evidence, and adversarial acceptance; `f0c7b922-8586-4a6f-940d-ff57a2480a41` covers bounded `logs run` JUnit XML test-report metadata, raw `category=test_report` events, live/rebuild parity, real-life JUnit reporter validation evidence, and adversarial acceptance; `6bd3dc63-2dd3-4c67-99e6-ef19014c5715` covers dedicated SQLite `test_reports`/`test_cases` projections, Postgres sync/migration parity, external-ingest metadata allowlisting, real-life validation evidence, and adversarial acceptance; `b4af4347-f7b0-431a-aa2e-3fe6f23d9b56` covers dedicated API/CLI/MCP query surfaces over those projections with bounded case inclusion, aggregate failed-report filters, parse-diagnostic redaction, retained real-life API/CLI/MCP query validation, and adversarial acceptance from Pasteur and Harvey; `c1ca72d9` covers bounded source-map validation projections for build artifacts, live/rebuild parity, source-content omission from collector-owned evidence, source-map identity/path/scalar/raw-container hardening, retained real-life source-map projection validation, and adversarial acceptance from Mill and Peirce. The parent process/build telemetry track remains open for artifact payloads, source-map symbolication, broad parser-specific reports, full passing-case matrices, framework build adapters, portable child process capture, and broader validation.
- Capture browser, server, and framework telemetry universally.
- Add OpenTelemetry and structured logging compatibility. First JSON OTLP bridge, structured logging bridge, JSONL follow mode, dependency-light SDK Pino/Winston transport helpers, pinned installed logger-package validation, bounded SDK transport retry/drop accounting, and first opt-in Node/Bun redacted file spool replay are implemented; remaining scope includes OTLP protobuf/gRPC, collector/exporter conformance, broad logger version matrices, browser and production-grade spool policy, and real exporter/app validation labs.
- Capture agent, MCP, tool-call, and model-run telemetry.
- Implement real-time event bus and resumable streams.
- Build query, export, dashboard, and MCP surfaces over the event catalog.
- Implement retention, rotation, replay, repair, and sync.
- Rebuild universal compatibility projections from raw event segments.
- Harden privacy, security, and open-source defaults.
- Create real-life telemetry validation lab.
- Pass adversarial robustness gate for universal telemetry.
