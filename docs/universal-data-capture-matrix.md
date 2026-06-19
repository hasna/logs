# Universal Data Capture Matrix

Last updated: 2026-06-16

This matrix defines the data open-logs should eventually capture. It is intentionally broader than Sentry-style error monitoring. The purpose is to preserve enough structured and raw context for other agents to inspect real software behavior.

## Capture Principles

- Capture raw evidence first, then derive views.
- Preserve producer timestamps and original IDs.
- Attach machine, repo, app, process, run, source, and privacy metadata whenever available.
- Make high-cardinality raw payloads file-backed.
- Keep SQLite as the index and map.
- Redact before durable persistence.
- Prefer standard formats at boundaries: JSONL, W3C trace context, OpenTelemetry where feasible.
- Make every data category testable with a real scenario.

## Matrix

| Category | Examples | Raw store | SQLite metadata | Validation scenario |
| --- | --- | --- | --- | --- |
| Structured logs | app logs, Pino/Winston JSON logs, generic JSON logs, console messages | full log event plus redacted original structured payload | level, logger, message excerpt, source, service/app, trace/span/run IDs | emit logs from browser, Node, Bun, CLI, Pino, and Winston |
| Stdout/stderr | build output, tests, command output | raw stream lines and chunks | stream name, line number, command/run ID, severity heuristic | `logs run -- bun test` and `logs run -- tsc --noEmit` |
| Exceptions | uncaught errors, handled exceptions, promise rejections | exception body and stack | fingerprint, stack excerpt, source file, severity, issue ID | trigger browser and Node exceptions |
| Process lifecycle | start, exit, signal, crash, child process | process event payloads | PID, PPID, command, cwd, duration, exit code | run a command tree and kill a child process |
| Build/test lifecycle | compilation, test run, lint, typecheck, artifact output | command output and summaries | tool, package manager, status, duration, error counts | run passing and failing build/test commands |
| Repo context | git root, remote, SHA, branch, dirty files | optional snapshot payload | repo ID, SHA, branch, package name, dirty flag | capture events inside multiple repos |
| Machine context | host, OS, arch, timezone, resource basics | machine snapshot | machine ID, hostname, OS, arch | compare events across machines or simulated IDs |
| HTTP server | request start/end, route, status, latency | request event | method, route pattern, status, duration, trace ID | hit Node/Hono/Express/Fastify routes |
| HTTP client/fetch | outbound request, failure, latency | network event | method, host/path policy, status, duration | trigger successful and failed fetch calls |
| Browser navigation | page load, route changes, visibility | browser event | URL/path, session ID, app ID, timing | navigate a browser test app |
| Browser performance | web vitals, resource timing, long tasks | performance event | metric name, value, page/session | load heavy page and inspect metrics |
| User interaction | clicks, inputs metadata, route actions | replay/interaction event | element metadata, masked value policy, session | click through sample app with masking |
| Trace/span | W3C trace, spans, parent/child links | span event | trace ID, span ID, parent, op, status, duration | browser-to-server request waterfall |
| Metrics | counters, gauges, histograms, timings | metric event | metric name, tags, value, aggregation hints | emit counters and histograms from SDK |
| Profiles | CPU profiles, heap snapshots where safe | profile artifact | artifact path, process/run/span ID, duration | profile a CPU-heavy Node command |
| Artifacts | source maps, screenshots, reports, attachments | artifact files | artifact type, hash, app/release/run IDs | upload source map and link stack frame |
| Monitors | cron check-ins, uptime probes, scanner runs | monitor event | monitor ID, status, expected schedule, latency | missed cron and failing HTTP probe |
| Filesystem events | watched files, generated artifacts | event payload | path policy, repo/run ID, operation | build command creates output files |
| Agent sessions | agent start/end, task focus, plan updates | agent event | agent, task ID, session, run ID | run MCP tool and inspect agent context |
| Tool calls | shell, apply_patch, browser, test command | tool event | tool name, status, duration, task/run ID | capture a coding-agent task session |
| Model calls | provider/model metadata, latency, token counts when available | model event with redaction | provider, model, token counts, cost, duration | simulate or capture available model metadata |
| Sync events | segment sealed/uploaded/downloaded | sync event | cursor, segment ID, hash, remote URI | sync sealed segment to test target |
| Retention/repair | deletion, compaction, index rebuild | operation event | affected segment IDs, counts, bytes | delete SQLite and rebuild from segments |

## Sentry-Informed Field Checklist

These fields are required for data coverage parity. They are not Sentry product workflow requirements.

- Exceptions: exception type/value/mechanism, handled flag, full stack frames, fingerprint, breadcrumbs, tags, contexts, release/dist, environment, trace/span IDs, and original SDK event ID.
- Logs: severity, logger, message/body, structured attributes, source/runtime, trace/span/replay IDs, release/environment, SDK name/version, and high-cardinality dimensions in raw JSON.
- Spans: trace ID, span ID, parent span ID, operation/name/status, start/end/duration, route/request attributes, sampling metadata, service/project/environment/release, and links where available.
- Profiles: profile chunk/session IDs, sample timestamps, stack frames, thread IDs, function/file/line, runtime, process/run IDs, and trace/span/profile links.
- Replays: replay segment IDs, redaction policy, DOM/view snapshots where enabled, interaction events, console/network records, errors, trace links, tags, and browser/device context.
- Browser performance: LCP, CLS, FCP, TTFB, INP, score components, page-load/interaction transaction ID, route/page, browser/device, safe LCP element metadata, and trace/replay/profile links.
- Monitors: monitor config, schedule, check-in ID/status/runtime, missed/late/error states, thresholds, HTTP status/DNS/timeout/region data, uptime request spans, and issue links.
- Releases/artifacts: release version, dist, environment, commit associations, authors, artifact/debug IDs, source-map/debug-symbol hashes, build ID, upload time, validation state, and regression links.
- Metrics: name, kind, value, unit, timestamp, dimensions, trace/span links, sample rate, aggregation hints, and raw attributes before rollup.
- Agent data: task/run/session IDs, MCP calls, tool calls, model/provider metadata, token counts, latency, cost where available, context/provenance pointers, and prompt/output redaction policy.

## Minimum Viable Data Completeness

The first robust version must capture:

1. Raw logs and command output.
2. Exceptions and stack traces.
3. Machine, repo, process, and run identity.
4. Browser and Node runtime errors/logs.
5. Build/test/dev-server output.
6. Trace/span IDs when available.
7. Real-time stream events.
8. Redaction decisions.
9. Raw segment metadata and replayability.

## Evidence Rules

Every data category needs evidence:

- A fixture or real command that emits the data.
- A raw segment record containing the payload.
- A SQLite row pointing to that payload.
- A query that finds it by relevant metadata.
- A stream test if it should be real time.
- A replay/repair test if it is persisted.
- A privacy test if it can contain secrets or PII.
