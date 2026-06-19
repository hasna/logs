# Real-Life Telemetry Validation Plan

Last updated: 2026-06-19

This plan defines the evidence required before open-logs can be considered a robust universal telemetry data substrate.

The validation must use real concurrent sessions, not only unit tests. `tmux` is a good default, but any repeatable multi-terminal harness is acceptable.

## Required Validation Properties

For each scenario:

- Raw event payloads are written to append-only segment files.
- SQLite rows point to valid segment path, byte offset, byte length, and hash.
- Events include event time, ingest time, source, type, severity, privacy class, and identity metadata where available.
- Events can be queried through CLI/API/MCP.
- Live streams receive events or explicit overflow markers.
- Recovery can find unindexed raw records after simulated failure.
- Secrets and PII are redacted before raw persistence.

## Current Bounded Evidence

These runs are useful evidence, but they do not replace the larger targets below:

- `bun run validate:real-life -- --keep` retained `/tmp/open-logs-real-life-lab-NJZ95y/real-life-validation-report.json`, proving one isolated token-secured server, CLI project creation, remote CLI live watch, cross-process CLI log/span writes, HTTP exception/metric writes, one captured `logs run` test command with Linux procfs resource and process-tree summaries, one raw-backed indexed `process.resource.peak_rss` metric event mapped to that run, one raw-backed indexed process-tree event mapped to that run, one isolated artifact-producing build command with generated JavaScript and source-map outputs, two raw-backed indexed `artifact` events, two SQLite `artifacts` rows with relative paths and SHA-256 hashes, one SQLite `source_maps` row, one SQLite `source_map_sources` row, source-map JavaScript linkage, source content represented only by a hash in collector-owned evidence, source-map content canaries absent from retained collector-owned report/export/raw/SQLite evidence, forbidden source-map raw/projection container keys absent from retained scans, one real Bun JUnit reporter command captured through `logs run`, one raw-backed indexed `category=test_report` event with relative path, parsed JUnit counts, SHA-256 hash, one live SQLite `test_reports` projection row, zero SQLite `test_cases` rows for the passing report, authenticated API test-report list/get access, local CLI test-report list/get access, real MCP stdio test-report search/get access, event export with raw envelopes, `Last-Event-ID` catch-up for a pre-existing post-anchor event, a live follow-up event after catch-up, and `doctor segments` with 60 checked raw events and 0 unindexed raw events.
- `bun run validate:stress -- --keep` retained `/tmp/open-logs-high-volume-stress-AtCHHl/high-volume-ingest-stress-report.json`, proving 10 producer processes, 5,000 mixed event records, 81 segment rows/files, no missing expected IDs, no duplicate event IDs, full raw pointer reconstruction before and after rebuild, SQLite integrity and foreign-key checks, `doctor segments`, and `doctor rebuild-index`.
- `bun run validate:streams -- --keep` retained `/tmp/open-logs-stream-load-q2aFBk/stream-load-validation-report.json`, proving direct generic SSE delivery, `Last-Event-ID` buffer-miss SQLite catch-up with explicit `buffer_miss_sqlite_catchup`, forced slow-subscriber overflow with explicit `subscriber_queue_overflow`, bounded multi-consumer API SSE fanout with 8 consumers receiving 80 burst events each, remote `logs watch --server`, local `logs watch --events`, real MCP `event_watch` over stdio including raw envelopes and missing-cursor overflow, and `doctor segments` with 141 checked raw events and 0 unindexed raw events.
- `bun run validate:dashboard-stream -- --keep` retained `/tmp/open-logs-dashboard-stream-lab-SWSrG9/dashboard-stream-validation-report.json`, proving real Chromium sessions against the built dashboard served by both the token-secured source API server and `dist/server/index.js` from an extracted npm package, unauthenticated stream blocking, authorized fetch-backed SSE after dashboard token entry, rendered live event records, dashboard paused state with the paused event not rendered before resume, pause/resume reconnect with query `last_event_id`, catch-up of an event written while paused, post-resume live delivery, and `doctor segments` with 6 checked raw events and 0 unindexed raw events.
- `bun run validate:structured-logs -- --keep` retained `/tmp/open-logs-structured-log-lab-RiCUay/structured-log-validation-report.json`, proving one isolated token-secured server, CLI project creation, remote `logs watch --server`, local `logs import-jsonl --follow` ingestion of appended representative Pino and Winston JSONL records, HTTP `POST /api/logs/structured` ingestion of Pino and Winston payloads, SDK Pino and Winston transport-helper writes, live stream delivery of all six structured log messages, 6 raw-backed log event records, source counts `pino=3` and `winston=3`, raw reconstruction for all 6 events, canary redaction in raw and SQLite rows, and `doctor segments` with 0 unindexed raw events.
- `bun run validate:logger-packages -- --keep` retained `/tmp/open-logs-logger-package-lab-1l5gy5/logger-package-validation-report.json`, proving one isolated token-secured server, CLI project creation, remote `logs watch --server`, installed `pino@10.3.1` and `winston@3.19.0` using SDK transport helpers, live stream delivery of both live logger package messages, a real Pino collector-down SDK file-spool write, server restart replay of the spooled record with preserved transport metadata context, 3 raw-backed log event records, source counts `pino=2` and `winston=1`, raw reconstruction for all 3 events, `spooled_context_rows=1`, package-version evidence in the report, redacted local spool evidence, canary redaction in raw and SQLite rows, and `doctor segments` with 0 unindexed raw events. The SDK structured transport queue also has focused retry/drop regressions proving transient failures retain batches with stable source prefixes, exhausted retries are enforced per record when no durable spool is configured, transport-generated `_open_logs_event_id` values keep retry IDs stable across rebatching after drops, `maxQueueSize` bounds memory, queue pressure does not drop the active in-flight batch, opt-in Node/Bun file spooling can preserve redacted records and redacted send context across collector restart, live in-memory sends still preserve the original record before any restart, secret-bearing batch prefixes are redacted, malformed/unsupported spool lines are counted while valid records still replay, and load-time spool overflow reports dropped records. Remaining logger work is broader version-matrix coverage, high-volume import validation, browser structured-logger durable spool behavior, production spool hardening, and full inode-aware file rotation tests.
- `bun run validate:browser-spool -- --keep` retained `/tmp/open-logs-browser-spool-lab-WMXMd4/browser-spool-validation-report.json`, proving one isolated token-secured server, API-created project, API-created browser ingest token with normalized `allowed_origins`, wrong-origin rejection with HTTP 401, real Chromium page, failed browser flush through a same-origin proxy, explicit browser-token headers on browser sends, redacted SDK `localStorage` spool persistence after the collector outage, reload replay of only the redacted spooled browser event, browser-token scoped `/api/events` write into the token-owned project, raw JSONL segment persistence, SQLite `event_records` pointer reconstruction, storage cleanup after replay, and `doctor segments` with 1 checked raw event and 0 unindexed raw events.
- `bun run validate:browser-runtime -- --keep` retained `/tmp/open-logs-browser-runtime-lab-2tkApL/browser-runtime-validation-report.json`, proving one isolated token-secured server, API-created project, API-created browser ingest token with normalized `allowed_origins`, real Chromium page configured with the relative SDK collector URL `/collector`, explicit browser-token headers on browser runtime sends, browser console `debug`/`log`/`info`/`warn`/`error` capture, synthetic browser error and unhandled-rejection capture, browser `fetch` HTTP 204 and 503 span capture with canonical absolute URLs for relative app requests and opt-in same-origin `traceparent` propagation, explicit CORS-enabled cross-origin target coverage where the listed second origin observed a valid `traceparent`, its preflight requested `traceparent`, and the browser span linked to a raw-backed server request span, unlisted CORS-enabled cross-origin target coverage where the server observed `traceparent=null`, the preflight requested `x-open-logs-lab` and not `traceparent`, and exactly one browser span had no trace ID, fallback `span_...` shape, and no traceparent propagation/existing/suppression state, real browser `mode: "no-cors"` fetch coverage where the app server observed `traceparent=null` and the browser span recorded `traceparent_suppressed: "no-cors"` without a trace ID, same-origin `blob:` fetch coverage where the browser span recorded `traceparent_suppressed: "non-http"` without a trace ID, thrown fetch network-error capture with error type, page-load and History API `pushState` navigation spans, browser resource timing spans for stylesheet, script, fetch, failed-fetch, failed-network, listed cross-origin-fetch, unlisted cross-origin-fetch, and no-cors resources with `link`/`script`/`fetch` initiator metadata, duplicate buffered resource timing entries excluded, opt-in browser Web Vital metric events for FCP and LCP with `operation=browser.web_vital`, no collector self-fetch or collector resource-timing span in the flushed runtime events, browser-token scoped `/api/events` writes into the token-owned project, 26 raw-backed browser event records, 3 raw-backed server request span records, 3 browser-server trace links where server `parent_span_id` equals the browser client span ID, 1 raw segment, SQLite `event_records` pointer reconstruction, canary redaction in raw and SQLite rows, retained report redaction of proxy message summaries, and `doctor segments` with 29 checked raw events and 0 unindexed raw events.
- `bun test src/lib/sdk-client.test.ts` now includes focused browser universal-event coverage: opt-in `localStorage` persistence after collector failure, redacted disk payloads, same-page original in-memory sends before failure, post-failure retry redaction, serialized overlapping flushes without queued-event loss, failed in-flight batch preservation at queue capacity, reload replay of redacted events, validation before persisted-record redaction, corrupt and invalid-only spool cleanup without replay, browser console `debug`/`log`/`info`/`warn`/`error` capture, browser fetch span/network capture with relative URL canonicalization, relative collector recursion prevention, browser runtime opt-out flags, browser-token identity stripping for `/api/events`, and browser listener cleanup on stop.

## Scenario 1: Basic Collector Dogfood

Sessions:

- Pane 1: start `logs daemon` with isolated `HASNA_LOGS_DATA_DIR`.
- Pane 2: run `logs watch` or equivalent real-time stream.
- Pane 3: run `logs run -- bun test`.
- Pane 4: query the run by `run_id`.

Expected evidence:

- One run record.
- One process record.
- Stdout/stderr events linked to the run.
- Exit code, duration, cwd, command, repo SHA, branch, and dirty state.
- Raw segment records reconstruct the CLI output.

## Scenario 2: Build And Dev Server

Sessions:

- Pane 1: collector.
- Pane 2: live stream.
- Pane 3: `logs run -- bun run build`.
- Pane 4: `logs run -- npm run dev` or `logs run -- bun run dev`.
- Pane 5: browser or curl traffic against the dev server.

Expected evidence:

- Build logs, errors, warnings, and artifact paths if generated.
- Dev-server start, port, URL, process ID, child process tree, and shutdown.
- HTTP request events linked to the dev-server run.

## Scenario 3: Browser Runtime

Run a real browser app that emits:

- `console.log`, `console.warn`, `console.error`.
- Unhandled exception.
- Unhandled promise rejection.
- Failed fetch.
- Navigation or route change.
- Web vitals or resource timing event.
- Redacted input/interactions if replay-like capture is enabled.

Expected evidence:

- Browser events linked to app, repo, session, page URL, and trace/session IDs where available.
- Buffered browser events flush after collector outage, including opt-in reload persistence through the SDK `localStorage` spool.
- Secrets in messages, URLs, headers, and inputs are redacted in raw segments and SQLite.

Current status:

- The bounded `validate:browser-spool` lab proves the collector-outage, redacted localStorage, reload replay, raw segment, SQLite pointer, allowed-origin enforcement, and browser-token project-scoping path for one Chromium console warning event.
- The bounded `validate:browser-runtime` lab proves real Chromium capture for console `debug`/`log`/`info`/`warn`/`error`, browser errors, unhandled promise rejections, successful and failed browser fetch spans, thrown fetch network errors, page-load and History API route-change spans, resource timing spans with initiator and transfer metadata, opt-in Web Vital metric events for FCP and LCP, opt-in browser-server trace propagation for same-origin fetches, explicit CORS-enabled cross-origin trace target propagation with a recorded `traceparent` preflight, unlisted CORS-enabled target suppression with a custom-header preflight that omits `traceparent`, no-cors trace suppression when Chromium does not send `traceparent`, non-HTTP/blob trace suppression when no W3C request header can be sent, scoped browser-token writes, raw JSONL plus SQLite indexing, canary redaction, and segment verification.
- Focused SDK regressions now also prove opt-in browser and Node/Bun trace propagation preserves existing effective `traceparent` headers, including malformed values, uppercase-value malformed values, W3C-invalid `ff` version values, duplicate array-form headers that normalize to invalid comma-joined values, browser no-cors suppression, same-origin non-HTTP/blob suppression, and exact-origin matching for absolute string propagation targets without assigning false telemetry trace IDs.
- Remaining browser runtime work includes broader Web Vitals under user interaction such as CLS/FID/INP in real apps, replay/input masking, browser structured-logger durable spooling, byte-bounded/quota-aware IndexedDB storage, blocked-storage/private-mode behavior, longer collector outages, cross-browser validation, a broader cross-origin policy matrix beyond one listed target and one unlisted target, broader non-HTTP scheme validation beyond `blob:`, SPA router adapter coverage beyond raw History API events, and broader framework-specific trace propagation beyond raw fetch/server spans.

## Scenario 4: Server And Framework Runtime

Run representative apps:

- Node HTTP server.
- Hono, generic Node HTTP, Express-style middleware, and Fastify-style hooks.
- Pino and Winston structured logger producers.
- Vite app.
- Next.js client/server/edge where available.

Trigger:

- Successful request.
- 404 or validation error.
- Server exception.
- Outbound fetch success and failure.
- Slow route.

Expected evidence:

- Inbound request spans/events.
- Outbound fetch events.
- Structured application logs imported or posted with original JSON payloads preserved after redaction.
- Server exception linked to request/run/process.
- Trace/span correlation across browser and server if trace context is present.

## Scenario 5: High Volume And Concurrent Producers

Start 10 producers writing mixed event types and sizes.

Targets:

- At least 1 million events in an isolated local run.
- At least one high-rate burst around 10k events/sec if the machine can support it.
- Dashboard stream, CLI stream, and MCP query active during ingest.

Expected evidence:

- No missing indexed events.
- No duplicate `event_id` unless intentionally retried and deduped.
- Every indexed pointer reconstructs exact raw JSON.
- Slow clients receive explicit overflow markers.
- Catch-up query fills gaps after reconnect.

Current status:

- Bounded ingest stress has passed at 5,000 mixed events, not the 1 million event target.
- Bounded stream validation has passed for one real server, direct SSE, 8-consumer API SSE fanout over an 80-event burst, real-browser dashboard token auth plus pause/resume cursor reconnect, remote CLI, local CLI, and MCP cursor consumers, but not for larger high-rate dashboard fanout or long-running reconnect loops.

## Scenario 6: Crash And Recovery

Inject failures:

- Append succeeds, SQLite insert fails.
- SQLite insert succeeds, publish fails.
- Collector exits during segment append.
- Partial JSONL line.
- Malformed JSONL line.
- Disk-full or write error simulation if feasible.
- Collector restart during high-volume input.

Expected evidence:

- Recovery scanner finds unindexed valid records.
- Partial lines are truncated or quarantined.
- Corrupt segments are reported, not silently skipped.
- Segment verifier reports counts, hashes, and repair actions.

## Scenario 7: Redaction And Sync Safety

Inject canary secrets into:

- Message.
- Metadata.
- URL.
- Header/cookie-like fields.
- Stack trace.
- Stdout/stderr.
- Env vars.
- Replay/input-like fields.
- Agent/tool/model-call payloads.

Then inspect:

- Raw segments.
- SQLite.
- Export output.
- Stream payloads.
- Sync manifests and remote payloads if sync is enabled.

Expected evidence:

- No unredacted canary appears outside explicitly allowed secure storage.
- Sensitive categories are excluded from sync by default.
- Redaction decisions are themselves visible as metadata.

## Scenario 8: Multi-machine Or Simulated Multi-machine Sync

Simulate two machines with separate data dirs and different `machine_id`s.

Produce:

- Same project names.
- Overlapping app names.
- Overlapping producer event IDs.
- Different segment files.

Expected evidence:

- No ID collisions.
- Source machine identity is preserved.
- Sync resumes from cursors.
- Sealed segment hashes verify.
- Secrets, auth credentials, prompts, env values, and replay payloads are excluded by default.

## Scenario 9: Projection Rebuild

Create issues, summaries, alerts, metrics, traces, and dashboard data.

Then:

- Snapshot projection counts.
- Delete derived projection tables.
- Rebuild from raw segments and metadata.

Expected evidence:

- Counts match.
- Issue fingerprints match.
- Trace links match.
- Alert state is either rebuilt exactly or documented as intentionally non-replayable.

## Scenario 10: One-week Dogfood

Open-logs should capture its own work for at least one week:

- Tests.
- Builds.
- Typechecks.
- Lints.
- Dev server sessions.
- Dashboard browser sessions.
- MCP activity.
- Agent task work.
- Crashes and recovery drills.

Expected evidence:

- A weekly report of captured runs and failures.
- Known gaps filed as `todos` tasks.
- Storage usage and retention report.
- Segment verifier report.
- Adversarial review signoff or explicitly listed blockers.

## Current Unit-Level Evidence

These checks are useful prerequisites, not substitutes for the real concurrent-session lab above:

- `bun test src/server/server.test.ts` proves `/api/logs` rejects malformed, oversized, unauthenticated, and schema-invalid HTTP payloads before persistence.
- The same suite proves configured token mode protects API reads, exports, streams, and project/job/perf routes, and proves CORS origin resolution rejects unconfigured remote origins.
- The same suite proves project, page, page-auth, retention, job, alert, and issue mutation routes reject malformed, oversized, unknown-field, and invalid-type payloads before mutation for the tested cases.
- The same suite proves browser ingest tokens are created only through authenticated project routes, stored without raw token material, scoped to the token project and allowed origin, denied for reads/admin, limited to browser/script sources, and revoked correctly.
- The same server suite proves an HTTP canary secret is absent from SQLite response data and raw segment records.
- The event-bus/server suites prove first-pass API SSE live delivery, `Last-Event-ID` catch-up from SQLite, unknown-anchor overflow events, bounded replay membership, and subscriber overflow markers.
- The event-catalog/API/CLI/MCP suites prove first-pass search/get/export over `event_records`, raw envelope reconstruction from segment pointers, `/api/events`, `logs events`, and MCP event tool registration.
- The test-report query suites and real-life validation lab prove first-pass API/CLI/MCP access to projected `test_reports` and bounded `test_cases`: `GET /api/test-reports`, `GET /api/test-reports/:report_id`, `logs test-reports list|get`, and MCP `test_report_search`/`test_report_get` can read stored failed-case rows and aggregate failed reports with no stored cases through outcome/minimum-count filters. The projection tests also prove externally supplied case lists are capped at 50 rows across at most 20 suites, mark `truncated`, and keep only allowlisted metadata. The retained real-life lab now exercises the API, CLI, and MCP query surfaces against a live captured JUnit report and verifies those surfaces omit raw XML/system output/failure bodies.
- The event-catalog stream suite proves first-pass `/api/events/stream` behavior for live non-log universal events, log catalog events, process lifecycle events, filters, `Last-Event-ID` catch-up from `event_records`, SQLite-only first matching event catch-up, optional raw envelope inclusion, unknown-anchor overflow events, and bounded catalog bus replay membership. It now also proves a bus event cannot skip earlier SQLite-only rows: the stream catches up by rowid before emitting a later live bus event.
- The event-catalog stream and CLI suites prove first-pass generic SSE event-channel support (`event_name=event`), local `logs watch --events` event catalog output, local `--last-event-id` watch catch-up, and explicit local missing-cursor markers.
- The CLI suite proves secured remote `logs watch --server` one-shot stream delivery from a live API process after `Last-Event-ID`.
- The real-life validation lab script exists at `scripts/real-life-validation-lab.ts` and is exposed through `bun run validate:real-life`. A retained local run on 2026-06-18 with `bun run validate:real-life -- --keep` produced `/tmp/open-logs-real-life-lab-NJZ95y/real-life-validation-report.json`: it started a real API server with a token-secured isolated data dir, created a project through the CLI, ran `logs watch --server` during a mixed event burst, captured cross-process CLI log/span events plus HTTP exception and metric batch events in the live stream, ran `logs run --json -- bun test src/lib/parse-time.test.ts`, verified the returned resource summary and indexed `run_d6a7f4550cae25365aa83017-resource` raw-backed metric, verified the returned process-tree summary and indexed `run_d6a7f4550cae25365aa83017-process-tree` raw-backed process event, ran an isolated artifact-producing build command, verified generated JavaScript and source-map outputs as raw-backed artifact events `run_75baf9217f2f96e3b60094f3-artifact-d867c0645af6143e` and `run_75baf9217f2f96e3b60094f3-artifact-ae2e775acb59b51b`, verified two SQLite `artifacts` rows with relative paths and content hashes, verified one SQLite `source_maps` row linking `dist/real-life-lab.js.map` to `dist/real-life-lab.js` with source-count metadata and content hash `4341d2cf41bb03d28fc241208ff24f34cdd68d89532deb42bfb2d7936c09b98f`, verified one SQLite `source_map_sources` row with `src/real-life-lab.ts`, source storage policy `paths_and_hashes_only`, and content hash `97b2f6ee733f16d77928c06410fa38ab621fd553f3afaef323cb04ed00cde4ba`, verified source-map content canaries are absent from collector-owned report/export/raw/SQLite evidence, verified retained forbidden scans found no `raw_json`, `sourcesContent`, `mappings`, `sections`, or `redaction` source-map projection leakage, ran a real Bun test command with `--reporter=junit --reporter-outfile test-results/junit.xml`, verified the returned JUnit report summary and indexed `run_fdf3381f6be6d15e42dcd6d8-test-report-5b5a9b71227bc214` raw-backed `category=test_report` event with relative path, content hash `c4d42b84ef3748f404d445cd7cc1f10a4b0efe85fba7889afa8142b84955af9a`, parsed `tests=1`, `failures=0`, and `errors=0`, verified a live SQLite `test_reports` projection row mapping that report to the event and run, verified parser metadata and JUnit counts in the projection, verified `test_cases=0` for the passing report's bounded case policy, queried that captured report through authenticated `GET /api/test-reports` and `GET /api/test-reports/:report_id`, local `logs test-reports list|get`, and real MCP stdio `test_report_search`/`test_report_get`, verified each list/get path found exactly the report and returned zero bounded case rows, verified those query responses omitted raw XML/system output/failure bodies, verified `Last-Event-ID` catch-up for a pre-existing post-anchor event without replaying the anchor, verified a live follow-up event after the catch-up cursor, exported 60 raw-backed event records, verified every expected lab event has a matching raw envelope in the export, and `logs doctor segments --json` reported 60 checked records, 60 checked raw events, 1 segment, 0 unindexed raw events, and no errors. This is Scenario 1/stream/process/API/resource-metric/process-tree/artifact-metadata/source-map-validation/JUnit-metadata/JUnit-projection/API-query/CLI-query/MCP-query evidence, not Scenario 5/6/10 high-volume, crash-restart, browser, source-map symbolication, broad test-report dialect, full passing-case matrix, or one-week dogfood evidence.
- The high-volume ingest stress script exists at `scripts/high-volume-ingest-stress.ts` and is exposed through `bun run validate:stress`. A retained local run on 2026-06-16 with `bun run validate:stress -- --keep` produced `/tmp/open-logs-high-volume-stress-AtCHHl/high-volume-ingest-stress-report.json`: it ran 10 independent producers, ingested 5,000 mixed log/metric/span/exception/build/process/agent/network events into one isolated data dir, forced 81 raw segment rows/files, verified every expected event ID and type count, found 0 duplicate event IDs, reconstructed every raw event from SQLite pointers before and after `logs doctor rebuild-index`, ran SQLite integrity and foreign-key checks, and `logs doctor segments --json` reported 5,000 checked records, 5,000 checked raw events, 81 checked segments, 0 unindexed raw events, and no errors. This is bounded Scenario 5 evidence, not a million-event, 10k/sec, multi-hour, crash-during-stress, or one-week dogfood proof.
- The stream load/resume validation script exists at `scripts/stream-load-validation.ts` and is exposed through `bun run validate:streams`. A retained local run on 2026-06-18 with `bun run validate:streams -- --keep` produced `/tmp/open-logs-stream-load-q2aFBk/stream-load-validation-report.json`: it started a token-secured real API server, delivered 30/30 direct generic SSE events with raw envelopes, delivered 7/7 post-anchor events after a `Last-Event-ID` buffer miss with explicit `buffer_miss_sqlite_catchup`, delivered 14/14 forced slow-subscriber burst events with explicit `subscriber_queue_overflow`, delivered 80/80 fanout burst events to each of 8 API SSE consumers for 640/640 expected deliveries with no overflow, delivered remote and local CLI watch post-cursor events without replaying anchors, validated MCP stdio `event_watch` with 2/2 post-cursor raw envelopes and explicit missing-cursor overflow, and `logs doctor segments --json` reported 141 checked records, 141 checked raw events, 1 segment, 0 unindexed raw events, and no errors. This is bounded stream evidence, not larger high-rate fanout, multi-machine, or long-running reconnect-after-drop proof.
- The dashboard stream validation script exists at `scripts/dashboard-stream-validation-lab.ts` and is exposed through `bun run validate:dashboard-stream`. A retained local run on 2026-06-19 with `bun run validate:dashboard-stream -- --keep` produced `/tmp/open-logs-dashboard-stream-lab-SWSrG9/dashboard-stream-validation-report.json`: it built the dashboard and root package, packed and extracted the npm tarball, verified the package includes `dashboard/dist/*` and `dist/server/index.js`, served the dashboard from the real token-secured source API server, repeated the same checks from the extracted package's `dist/server/index.js` while running from `/tmp/open-logs-dashboard-stream-lab-SWSrG9/packaged-runtime-cwd`, opened Chromium at `/dashboard/` for both server paths, verified one unauthenticated stream request was blocked per path, verified the next stream sent `Authorization: Bearer <token>` after entering the dashboard token, rendered the first live event, entered dashboard paused state, verified a second event written while paused was not rendered before resume, resumed with query `last_event_id` (`dashboard-stream-lab-1781865483715-first` for source and `dashboard-stream-lab-1781865483715-packaged-first` for packaged), rendered the paused catch-up event, rendered a post-resume live event, reconstructed all six raw events from SQLite segment pointers, and `logs doctor segments --json` reported 6 checked records, 6 checked raw events, 1 segment, 0 unindexed raw events, and no errors. This is bounded browser dashboard stream evidence, not generated-token onboarding, reconnect-after-drop soak, proxy/browser fanout, multi-machine, or long-running dogfood proof.
- The MCP suite proves `event_watch` cursor polling over `event_records`, including explicit missing-cursor markers.
- The MCP suite proves first-pass MCP tool-call telemetry and agent-session telemetry as raw universal `agent` events. Covered cases include completed tool calls, handler-level failed tool calls, safe argument summaries that do not persist a canary argument value by default, default exclusion of internal MCP tool telemetry from MCP search/watch, explicit `include_internal` inspection, and durable agent registration, heartbeat, and focus events. Schema-validation failures before MCP handler execution are not captured yet.
- The identity-focused CLI/MCP suite proves first-pass local machine/app attribution for `logs run`, local `logs events push`, and MCP `event_push`, plus repository attribution when git metadata is available. It also proves invalid CLI/MCP event payloads do not mutate identity tables, unknown project IDs do not reach FK-backed app identity upserts or log persistence, and explicit CLI/MCP machine/repo/app identity skips local discovery. This is local producer evidence only; SDK/browser/server adapters, CI, remote collectors, and multi-machine paths still need real-life attribution tests. Identity catalog rows include sensitive host/path/remote/package metadata, so broader validation must include opt-out, redaction, retention, and sync-control checks.
- The command-runner suite proves first-pass build/test/dev-server enrichment for `logs run`: raw stdout/stderr lines remain reconstructable, newline/end-delimited raw stream segments preserve byte-level payloads with byte/hash/newline/invalid-UTF8/observed-persistence-order metadata, raw segment persistence buffers until newline or stream end so redaction can see secrets split across read chunks, stream records include run kind, tool/package manager hints, line categories, TypeScript-style diagnostic codes, local server URLs/ports, split sensitive command arguments including prefixed flags are redacted, valid text segments are redacted before base64 storage, invalid-UTF8 segments get ASCII byte-level redaction before base64 storage, interrupted dev-server runs can be finalized through abort/SIGTERM, process/run metadata carries bounded resource usage and process-tree summaries, raw indexed `process.resource.peak_rss` metric events preserve run mapping, raw indexed process-tree events preserve run mapping without command/cwd payloads, a Linux regression captures a real spawned child process in the peak tree, build/test/dev-server runs emit raw indexed `build` lifecycle summary events with aggregate output counts, JUnit XML report parsing captures aggregate counts plus bounded failed/error/skipped case identities without `<system-out>`, `<system-err>`, failure/error bodies, properties, or full XML content, test-report canaries in paths/names/classes/files are redacted before raw/SQLite/result persistence, unsafe DTD/entity reports are rejected, and rebuild recovers command-runner final status plus lifecycle test-report metadata from raw process-exit and lifecycle-summary evidence.
- A temporary real CLI capture also proves the same path outside the in-memory test database: `logs run --json -- bun -e ... test` produced a failed test run with 3 lines, 2 raw stream segments, 105 captured bytes, 1 compiler diagnostic, 1 detected local dev-server port, event-catalog `process` segment rows, and an event-catalog `build` summary row tied to machine/repo/app/process/run IDs.
- The event-store, universal-ingest, and command-runner suites prove first-pass projection recovery from raw JSONL and live projection parity: after deleting `event_records`, `event_segments`, `issues`, `logs`, `spans`, `traces`, `sessions`, `artifacts`, `releases`, `processes`, and `runs`, `rebuildEventStoreIndex` reconstructs the indexed events plus log rows, issue grouping, trace/span links including authoritative earlier `started_at` after a placeholder, session details including authoritative earlier `started_at` after a log-seeded placeholder, out-of-order artifact-before-release enrichment, release/artifact metadata, process/run metadata from process and span events, and command-runner final status from raw process-exit and lifecycle-summary evidence. Separate live universal-ingest regressions prove later release/trace/session events enrich placeholders created by earlier artifact/network events. This is unit-level recovery evidence; Scenario 9 still needs real database snapshots, high-volume data, corrupt-line drills, alert/dashboard summary decisions, and crash-injection validation.
- The event-store, doctor CLI, and command-runner suites prove first-pass raw segment repair: malformed complete JSONL lines and partial tails are reported, dry-run plans repairs without writing quarantine files, `--apply` writes exact removed bytes plus a manifest under `quarantine/`, rewrites the segment with valid complete lines, rebuilds indexes/projections, returns the verifier to `ok`, and tolerates the interleaving where repair rebuilds an appended raw event before a producer's late `indexRawEvent` call. The doctor CLI suite also includes a bounded process-level crash drill: a child producer appends raw evidence and exits before indexing, doctor reports the unindexed raw event, rebuild reconstructs the event record and log projection, another child leaves a partial raw tail, repair quarantines it, and an ENOTDIR segment write-error fails before inserting log/event rows. This is stronger than isolated unit coverage; Scenario 6 still needs realistic collector restart during active ingestion, disk-full drills, and high-volume restart validation.
- The doctor CLI suite now includes a bounded multi-process write-lock regression: 10 independent Bun producers ingest 120 total SDK log events into one data directory with tiny raw segments, forcing multiple rotations. The test proves every worker exits cleanly, `doctor segments` sees all raw records with no unindexed events, every SQLite pointer has a unique non-overlapping byte range, every pointer reconstructs and hashes the exact raw JSONL record, and `doctor rebuild-index` reconstructs the same 120 events from raw segments. The event-store suite also proves rebuild refuses to run while the shared event-store lock is held. This is stronger than the original small parallel CLI push proof, but it is still not a substitute for Scenario 5 high-rate bursts, Scenario 6 crash/restart drills, or Scenario 9 large database recovery.
- The dashboard production build and `validate:dashboard-stream` prove the live tail compiles after moving from `/api/logs/stream` to fetch-backed `/api/events/stream?event_name=event`, renders generic event catalog records instead of log rows, sends dashboard session tokens through authorization headers, and reconnects with an explicit query cursor after pause/resume in real Chromium sessions on both source-server and extracted npm package server paths.
- The universal-ingest/API/CLI/MCP suites prove first-pass raw-first non-log event ingest through library, `POST /api/events`, `logs events push`, and MCP `event_push`; covered cases include span persistence, redaction before raw append, top-level `source_event_id` canary redaction, event ID and source event ID idempotency, exception issue projection, batch ingest, invalid batch prevalidation, payload validation, and query through the event catalog.
- The OTLP ingest suite proves first-pass OTLP JSON translation for traces, logs, and metrics through `ingestOtlpTraces`, `ingestOtlpLogs`, `ingestOtlpMetrics`, and `/api/otel/v1/*`. Covered cases include resource/scope preservation, trace/span/service/environment/host indexing, preserving `process.pid` without promoting it to global `process_id`, span/trace projections, severity mapping, gauge and histogram datapoints, deterministic resource/scope/ordinal-aware retry deduplication, cross-service and same-resource duplicate-collision regressions, malformed signal-shape, nested-array, and metric-container rejection, browser-token rejection for OTLP writes, and redaction before raw replay for OTLP canaries. This is unit/API evidence only; real OpenTelemetry exporters, protobuf/gRPC, collector config, high-volume collector runs, and multi-language SDK validation are still missing.
- The SDK/client and server suites prove first-pass SDK universal event methods post to `/api/events`, preserve default project/source/environment/release/app/session context, shape exception/metric/span payloads with trace correlation fields, reject non-2xx SDK event responses, flush browser universal auto-capture queues, capture Node/Bun console/process/fetch telemetry through the same universal event path, capture fetch-native inbound request spans, Hono-style middleware spans, generic Node HTTP request/response spans, Express-style middleware spans after downstream route resolution, Express-style error middleware spans/exceptions, non-consuming Node request/response error monitoring through `errorMonitor`, request-aborted `499` spans, and Fastify-style hook spans, emit request exception telemetry while rethrowing handler failures or when Node captures finish with errors, safely fall back from malformed Node `Host`/scheme input without unhandled telemetry rejection, reject delimiter-bearing `Host` values before URL synthesis, use non-mutating fatal exception monitoring, restore fetch exactly on stop, avoid collector self-fetch recursion without suppressing lookalike collector hosts, and allow scoped browser ingest tokens to write only browser-safe universal event types to their own project. They also cover browser-token SDK sends against the real route without server-forbidden identity fields, top-level and nested identity-spoof rejection, project-scoped browser producer IDs, query-string/privacy behavior, listener cleanup, allowlisted request/response headers, and raw token metadata redaction.
- The redaction canary suite proves a bounded cross-surface grep: injected canaries through log messages, URLs, headers/cookies, stack traces, metadata, replay-like payloads, agent/tool/model payloads, command args, stdout/stderr, child env output, and canary-bearing working directories do not appear in raw replay, decoded process chunks, SQLite rows, event catalog exports, legacy log JSON/CSV exports, log/universal/agent/process event stream payloads, default storage-sync table payloads, or `logs run` result objects. This is not a substitute for Scenario 7's real browser replay/input masking and dogfood-wide grep.
- The browser script suite proves the served script supports `data-browser-token`/`data-write-token` and sends `X-Logs-Browser-Token` on flush.
- The broader targeted suite proves the current raw log/process/redaction/storage-sync slice still passes after API and browser-token hardening.
- Focused `bun test src/cli/doctor.test.ts` passes with 7 tests and 1593 expectations after adding the bounded process-level crash/write-error recovery drill.
- Focused `bun test src/lib/event-store.test.ts src/cli/doctor.test.ts src/lib/command-runner.test.ts` passes with 25 tests and 1795 expectations after adding the bounded process-level crash/write-error recovery drill.
- Focused `bun test src/lib/redaction-canary.test.ts` passes with 1 test and 46 expectations after adding command-stream and working-directory coverage to the bounded cross-surface canary validation suite.
- Focused `bun test src/lib/redaction-canary.test.ts src/lib/ingest.test.ts src/lib/universal-ingest.test.ts src/lib/command-runner.test.ts src/lib/events.test.ts src/lib/storage-sync.test.ts src/cli/storage.test.ts` passes with 32 tests and 281 expectations after adding command-stream and working-directory coverage to the bounded cross-surface canary validation suite.
- Focused `bun test src/server/server.test.ts src/cli/events.test.ts src/cli/entrypoints.test.ts` passes with 62 tests and 282 expectations after adding the rowid catch-up-before-bus stream regression and the `logs serve` binding fix.
- `bun run validate:real-life -- --keep` passes and retains `/tmp/open-logs-real-life-lab-NJZ95y/real-life-validation-report.json` with 60 event records, 60 raw checked events, 1 segment, 0 unindexed raw events, 13 mixed live stream events, 1 remote catch-up event, 1 remote live follow-up event, export verification for every expected lab event's raw envelope including `run_d6a7f4550cae25365aa83017-resource`, `run_d6a7f4550cae25365aa83017-process-tree`, `run_75baf9217f2f96e3b60094f3-artifact-d867c0645af6143e`, `run_75baf9217f2f96e3b60094f3-artifact-ae2e775acb59b51b`, and `run_fdf3381f6be6d15e42dcd6d8-test-report-5b5a9b71227bc214`, a captured `bun test src/lib/parse-time.test.ts` run whose `resource_usage` summary reports Linux procfs sampling with peak RSS, virtual memory, thread, and CPU tick fields and whose `process_tree` summary reports one Linux procfs sample, a captured isolated build run whose `artifacts` summary reports generated JavaScript plus source-map files with relative paths, SHA-256 content hashes, raw indexed artifact events, two SQLite `artifacts` rows, one SQLite `source_maps` row, one SQLite `source_map_sources` row, source-map JavaScript linkage, source content represented only by hashes in collector-owned evidence, and retained source-map canary/forbidden scans with no leaks, a captured real Bun JUnit reporter run whose `test_reports` summary reports `test-results/junit.xml`, parser `junit-xml-v1`, `tests=1`, `failures=0`, `errors=0`, content hash `c4d42b84ef3748f404d445cd7cc1f10a4b0efe85fba7889afa8142b84955af9a`, raw indexed test-report event, one SQLite `test_reports` projection row, zero SQLite `test_cases` rows for the passing report, and `test_report_queries` counts proving API, CLI, and MCP list/get access to that captured report.
- `bun run validate:stress -- --keep` passes and retains `/tmp/open-logs-high-volume-stress-AtCHHl/high-volume-ingest-stress-report.json` with 10 producers, 5,000 mixed event records, 81 segment rows/files, 0 missing expected IDs, 0 duplicate event IDs, all raw pointers reconstructed before and after rebuild, SQLite `integrity_check` ok, 0 foreign-key violations, `doctor segments` checking all 5,000 records/raw events with 0 unindexed raw events, `doctor rebuild-index` reindexing 5,000 events and 81 segments with 0 skipped events, and 113.52 aggregate events/sec.
- `bun run validate:streams -- --keep` passes and retains `/tmp/open-logs-stream-load-q2aFBk/stream-load-validation-report.json` with 141 event records, 141 checked raw events, 1 segment, 0 unindexed raw events, 30 direct SSE events with raw envelopes, 7 SQLite catch-up events with explicit `buffer_miss_sqlite_catchup`, 14 slow-subscriber recovery events with explicit `subscriber_queue_overflow`, 8-consumer API SSE fanout over 80 burst events with 640/640 expected deliveries, remote and local CLI watch cursor checks, MCP stdio raw-envelope cursor checks, and explicit MCP missing-cursor overflow.
- `bun run validate:dashboard-stream -- --keep` passes and retains `/tmp/open-logs-dashboard-stream-lab-SWSrG9/dashboard-stream-validation-report.json` with real Chromium dashboard runs against source and extracted npm package servers, stream request evidence for blocked unauthenticated SSE and authorized token SSE on both paths, query-cursor reconnect evidence with `last_event_id=dashboard-stream-lab-1781865483715-first` and `last_event_id=dashboard-stream-lab-1781865483715-packaged-first`, 6 raw-backed dashboard stream events, 6 checked raw events, 1 segment, and 0 unindexed raw events.
- Full `bun test` passes with 354 tests and 4001 expectations, `bun run lint` passes across `src/`, `./node_modules/.bin/tsc --noEmit --pretty false` passes, `bun run build:all` passes with the existing Vite dashboard chunk-size warning, `cd sdk && bun run build` passes, and `npm pack --dry-run --json` for `@hasna/logs@0.3.27` includes `dist/server/index.js` plus `dashboard/dist/index.html` as of 2026-06-19.
- Root `tsconfig.json` is now scoped to `src/**/*.ts` and `src/**/*.tsx`; the browser dashboard remains type-checked by `dashboard/tsconfig.app.json` through `bun run build:dashboard`.
- Repository-wide `./node_modules/.bin/tsc --noEmit --pretty false` and `bun run lint` both pass as of 2026-06-19.
