# Sentry Capability Audit 2026

Last checked: 2026-06-16

Purpose: define the current Sentry data and observability surface area so `@hasna/logs` can collect equivalent or richer raw data across apps, repositories, machines, CI jobs, and developer agents.

This audit uses current public Sentry documentation and changelog pages. Sentry is a reference catalog of telemetry categories, not the organizing product architecture for open-logs.

## Executive Summary

Replacing the need for Sentry as a data source means collecting these data classes:

- Error monitoring, issue grouping, stack traces, ownership, releases, regressions, and source maps.
- Distributed tracing, span search, performance insights, and automated performance issue detection.
- Structured logs that correlate with errors, traces, and spans.
- Session replay for browser and mobile, including console/network/DOM context.
- Profiling, metrics, uptime monitors, cron monitors, alerts, dashboards, and usage controls.
- Agent and automation telemetry as data: MCP access, coding-agent setup context, model/tool-call metadata, token/cost/latency fields, and run lineage. Open-logs should collect this evidence for agents; it should not clone Sentry's automated debugging workflows.
- Integration quality: one-command setup for frameworks like Next.js, source map uploads, OpenTelemetry support, logging library integrations, and CI release automation.

The current `@hasna/logs` codebase is still much smaller than Sentry, but it now has more than SQLite-only logs: raw JSONL event segments with SQLite pointers for supported paths, first-pass raw repair/quarantine for malformed lines and partial tails, first-pass SQLite projection rebuild from raw files for supported event classes, bounded multi-process segment write-lock validation with forced rotation, rebuild locking, and rebuild-from-raw proof, bounded process-level crash/write-error recovery drills, bounded cross-surface redaction canary validation, a first universal event envelope and ingest endpoint, SDK helpers for generic events/exceptions/metrics/spans, browser universal auto-capture, Node/Bun console/process/fetch auto-capture, fetch-native inbound request spans, Hono-style middleware spans, generic Node HTTP capture, Express-style middleware, Fastify-style hooks, scoped browser-token writes to safe universal event types, event catalog search/export/read APIs, MCP event tools, first-pass MCP tool-call and agent-session telemetry, enriched `logs run` build/test/dev-server output summaries with raw stream segments, a first event-catalog SSE stream, dashboard live-tail consumption of that stream, first-pass local machine/repo/app identity attribution for CLI/run/MCP producers, configured-token API auth, scoped browser write tokens, scanner-based page capture, performance snapshots, issues, alerts, and metadata table sync. It still does not have full framework adapter coverage, automatic durable identity attribution across all SDK/browser/server/framework/CI/remote-agent sources, complete model/provider/token/cost/file-edit telemetry, complete trace/span/session/replay/profile/source-map capture, raw segment sync, high-volume stream proof, complete hardening, or multi-machine validation needed for the universal telemetry data-substrate claim.

The first identity attribution pass intentionally captures useful evidence for agents, but it also stores sensitive local context such as hostnames, repository paths, remote URLs, branch/SHA state, package names, versions, and package paths. Matching Sentry's data-management posture requires explicit open-source defaults for opt-out, redaction, retention, and sync controls before this expands to all producers.

## 2026 Notes That Matter

- Logs are no longer an add-on idea in Sentry. Logs are generally available and are positioned with real-time streaming, log-based alerts, dashboards, and trace/issue context.
- Sentry announced Application Metrics general availability on May 5, 2026. The important data requirement for open-logs is high-cardinality metric events that keep trace linkage and raw dimensions instead of only pre-aggregated counters.
- Sentry supports OpenTelemetry traces and logs through OTLP. Current Sentry material says OTLP metric ingestion is not yet supported, while Sentry SDKs provide their own metrics capabilities.
- Sentry Session Replay is generally available for web and mobile; replay details can include user interactions, console messages, network requests, errors, trace linkage, tags, and Chromium memory data.
- Sentry profiling captures function-level call stack data across several backend, frontend, mobile, and server runtimes.
- Sentry's current Next.js setup flow configures browser, server, and edge runtime files and can enable error monitoring, logs, session replay, and tracing.
- Sentry has AI-assisted product surfaces, but open-logs should only treat them as evidence that agent/model/tool telemetry matters.
- Sentry is metered across errors, logs, spans/traces, replays, profiling, monitors, attachments, and AI features. Open-logs can compete by keeping the local path predictable and storage-visible.
- Self-hosted Sentry exists, but the operational model is much heavier than this project should be. Open-logs should keep a single-machine default: one daemon, SQLite, files, and optional central sync.

## Concrete Data Fields To Preserve

Sentry parity at the data layer means open-logs should ingest the evidence below, not just display similar product pages:

| Area | Required raw and indexed data |
| --- | --- |
| Errors and exceptions | Exception type, value, mechanism, handled/unhandled flag, full stack frames, source files, breadcrumbs, tags, contexts, user/session when configured, release/dist, environment, trace/span IDs, and original SDK event IDs. |
| Logs | Message/body, severity, structured attributes, logger name, source/runtime, trace/span/replay IDs, release/environment, SDK name/version, and high-cardinality dimensions in raw form. |
| Traces and spans | Trace ID, span ID, parent span ID, operation/name/status, start/end/duration, route/request attributes, sampling rate/weight, span links where available, and service/project/environment/release dimensions. |
| Profiles | Profile session/chunk IDs, sample timestamps, stack frames, thread IDs, function/file/line, runtime, process/run IDs, and trace/span/profile links. |
| Session replay | Replay segment IDs, timestamps, privacy/redaction policy, DOM or view snapshots where enabled, interaction events, console records, network records, errors, trace links, tags, and browser/device/runtime context. |
| Web vitals and browser performance | LCP, CLS, FCP, TTFB, INP, score components, page-load or interaction transaction IDs, route/page, browser/device, LCP element metadata when safe, and trace/replay/profile links. |
| Crons and uptime | Monitor config, schedule, check-in ID/status/runtime, missed/late/error states, thresholds, URL/method/header/body policy, status/DNS/timeout/region data, uptime request spans, and issue links. |
| Releases and deploys | Release version, dist, environment, project/app mapping, commit associations, authors, artifact IDs, deploy timestamps, release health sessions, crash-free users/sessions when available, and regression links. |
| Metrics | Metric name, kind, value, unit, timestamp, dimensions, trace/span links, client sample rate, aggregation hints, and raw high-cardinality attributes before rollup. |
| Issue grouping | Fingerprint, grouping algorithm/config version, stack evidence, custom grouping rules, merge/unmerge history, issue status, regression status, ownership, and review state. |
| Source maps and symbols | Artifact bundle metadata, debug IDs, release/dist/build IDs, source-map/debug-symbol file references, content hashes, upload time, validation state, and retention/usage state. |
| SDK and framework integrations | SDK name/version, runtime/platform, framework adapter, route or component name, auto-instrumentation origin, build ID, bundle/artifact IDs, and deployment/build log lineage. |
| Agent telemetry | Agent/session/task/run IDs, MCP tool calls, shell/tool invocations, model/provider metadata, token counts, latency, cost where available, context/provenance pointers, and redaction policy for prompts or outputs. |

## Caveats To Account For

The current Sentry surface includes limitations that should shape open-logs differently:

- OTLP ingest is open beta in current Sentry docs and supports traces/logs, not OTLP metrics. Open-logs should not make metrics depend on OTLP-only support.
- Some correlation is sampling-dependent. Open-logs should preserve unsampled local raw events by default and record sampling decisions explicitly.
- Replay is bounded by product retention and recording limits in Sentry. Open-logs should make replay segment retention explicit and local-file-backed.
- Web Vitals dashboards focus on initial page-load and interaction data; open-logs should preserve route/navigation context separately when apps can emit it.
- Profiling support varies by runtime. Open-logs should store profile artifacts in a runtime-neutral way and index the runtime/profile format.
- Uptime response verification and some trace behaviors are gated or early-adopter in Sentry. Open-logs should store raw monitor results and root spans without depending on hosted product state.
- Source maps now emphasize debug IDs and artifact bundles. Open-logs should keep debug ID, release/dist, and build ID support from the start.
- Logs search in Sentry has message/full-JSON limits. Open-logs should preserve full raw JSON and index selected fields deliberately.

## Capability Matrix

| Sentry capability | Current Sentry behavior | Replacement requirement for open-logs |
| --- | --- | --- |
| Error monitoring | Captures unhandled exceptions and groups similar events into issues. Sentry connects errors to traces, replays, source maps, suspect commits, owners, and releases. | Add a first-class exception event type, deterministic and AI-assisted grouping, stack frame normalization, issue lifecycle, ownership rules, regressions, and release awareness. |
| Issue grouping and triage | Sentry has mature issue grouping and has recently shipped enhanced AI issue grouping. | Implement stable fingerprinting first, then pluggable grouping rules, stack-aware grouping, regression detection, merge/split, ignore/resolution states, and review queues. |
| Source maps and symbolication | Sentry supports build-time source map uploads, debug IDs, artifact validation, and readable stack traces for minified JavaScript. | Build an artifact store for source maps/debug files, integrate with Vite/Next/build wrappers, map stack frames locally, and preserve build/release metadata. |
| Distributed tracing and APM | Tracing captures spans across frontend, backend, services, queues, databases, caches, crons, AI calls, and mobile app flows. | Define trace/span tables and raw span events, support W3C trace context, auto-instrument Node/Next/fetch/http/db calls, and expose trace waterfalls. |
| Performance insights | Sentry creates opinionated frontend, backend, mobile, and AI insights from tracing data and detects performance issues. | Add projections for web vitals, endpoint latency, database/query latency, slow requests, N+1 style patterns, queue delays, cold starts, and AI token/latency/cost. |
| Structured logs | Sentry Logs became generally available in 2025. Logs can stream in real time, alert on structured fields/messages, drive dashboards, and appear scoped to spans, traces, and errors. | Make raw log files the primary store, SQLite the metadata/index layer, and every log record trace-correlatable with structured attributes. |
| Session replay | Web replay records DOM/event timelines, console messages, network requests, and interactions; mobile replay captures view hierarchy/screenshots. Replays connect to errors and performance issues. | Start with browser event replay: DOM mutation snapshots or lighter interaction timelines, console/network capture, replay-to-error linking, privacy masking, sampling, and local storage. Mobile can be a later phase. |
| Profiling | Sentry profiling shows function-level call stacks in production across supported backend, frontend, mobile, and server platforms. | Add Node profiling first through V8/inspector/profile capture, then browser profiling where feasible, with profile artifacts stored in files and indexed in SQLite. |
| Metrics | Sentry Application Metrics is GA as of May 5, 2026, with high-cardinality, trace-connected metric events rather than only predefined aggregates. | Add raw metric event types, dimensions, exemplars, rollups, dashboards, alerts, and retention policies separate from log/event retention. |
| Cron and uptime monitoring | Sentry has cron monitors for scheduled jobs and uptime monitors for HTTP checks, with billing per additional monitor. | Keep scan jobs, add durable monitor definitions, check-in events, missed/late/error states, HTTP uptime probes, alert rules, and monitor ownership. |
| Alerts and dashboards | Sentry supports alerts over issues, metrics, monitors, logs, and dashboards. | Replace current synchronous alert checks with projection-backed rules, rate limits, channels, ack/silence states, dashboard definitions, and saved searches. |
| Releases and deploys | Sentry releases track versions, commits, authors, crash-free users/sessions, regressions, and deploy notifications. | Add releases, deploys, environments, git metadata, CI metadata, artifact bundles, release health, and regression comparisons. |
| Framework setup | Sentry's Next.js wizard configures client, server, and edge runtimes and can enable errors, logs, replay, and tracing. | Provide `logs init` and framework packages: `@hasna/logs/next`, Node middleware, browser snippet, Vite/Next plugins, and generated config files. |
| OpenTelemetry | Sentry supports OTLP for traces and logs, direct SDK export, collector export, and routing from sources such as CloudWatch, Kafka, Nginx, and syslog; OTLP metric ingestion is not currently supported. | Treat OpenTelemetry ingestion/export as a primary compatibility layer, not an afterthought. Support OTLP-compatible envelopes, collector/file import, and export bridges while preserving raw payloads locally. |
| AI and agents | Sentry has AI product surfaces and agent integrations. The relevant replacement target is not automated debugging; it is the underlying telemetry about agent runs, tools, model calls, context, and decisions. | Make MCP native and data-first: expose log/search/trace/replay/issue tools, agent session tracking, model/tool metadata, token/cost metrics, prompts where permitted, provenance, and run lineage so external agents can reason over local evidence. |
| Privacy and security | Sentry includes data management, scrubbing, PII controls, replay masking, auth, org/project roles, and usage quotas. | Add auth before wider use, redact before storage, encrypt secrets with generated keys, mark sensitive fields, implement retention, and keep local-first defaults. |
| Pricing and usage | Sentry meters logs, spans, replays, profiling, monitors, attachments, and Seer. | Open-logs should make local storage cheap and visible: usage stats per app/repo/machine, segment sizes, retention impact, and optional remote sync cost controls. |
| Self-hosting | Sentry is self-hostable but operationally heavy, using multiple services in the self-hosted stack. | Keep open-logs intentionally smaller: single local daemon plus SQLite and files by default; optional central collector later. |

## Highest-priority Replacement Gaps

These are the gaps that block replacement across real apps:

1. Correlated errors, logs, traces, releases, and source maps.
2. Complete durable raw event store with SQLite metadata pointers for every ingest path.
3. Next.js and Node SDK parity across browser, server, and edge runtimes.
4. Issue grouping, regression detection, ownership, and triage workflow.
5. Live event, log, and trace views with resume/backpressure across API, dashboard, CLI, and MCP consumers.
6. Source map/debug artifact storage and stack frame mapping.
7. Alert routing and integrations for Slack, GitHub, Linear/Jira, and webhooks.
8. Privacy controls: redaction before persistence, replay masking, secret encryption, and sync policy.
9. Session replay or at least an interaction timeline connected to errors.
10. Agent telemetry as data: model calls, tool calls, token usage, latency, run context, MCP queries, and task lineage.

## Pricing, Retention, And Limits To Beat

As checked on 2026-06-16:

- Sentry pricing is event/category based, including errors, logs, spans, replays, profile hours, monitors, attachments, and Seer.
- Sentry docs list 5GB of included logs on all plans and additional log usage at $0.50/GB.
- Sentry docs list one included cron monitor and one included uptime monitor, then per-monitor PAYG pricing.
- Sentry retention varies by data type and plan. The current retention table lists logs, spans/transactions, profiles, crons, and many other telemetry categories with default retention periods rather than indefinite storage.
- Open-logs should make storage cost explicit: segment size by app/repo/machine, retention simulator, compression status, and sync budget controls.

## Sentry Features To Explicitly Match

### Must-have Sentry-equivalent data coverage

- Capture uncaught browser, Node, Next.js server, Next.js edge, CLI, worker, and build errors.
- Preserve producer event time, ingest time, event ID, source event ID, machine ID, repo ID, app ID, release, environment, process ID, run ID, trace ID, span ID, and parent span ID.
- Store raw events in append-only segment files under a real logs directory.
- Store SQLite metadata for file path, offset, byte length, hash, type, severity, timestamps, app/repo/machine/source, trace/span IDs, searchable excerpts, issue IDs, and projection state.
- Search logs, errors, spans, traces, releases, machines, builds, and sessions together.
- Correlate logs with errors, spans, traces, sessions, replays, source maps, deployments, and build output.
- Provide live tail with resume, buffering, and backpressure.
- Provide MCP tools for agents to query recent failures, diagnose a run, inspect context, and register activity.
- Provide a setup path that is as easy as Sentry's framework wizard for the apps this team builds.

### Differentiators over Sentry

- Local-first by default: no network dependency for ingest, search, or live tail.
- Raw files are first-class, replayable, compressible, rsync-able, and inspectable.
- Designed for developer machines and repositories, not only production services.
- Captures build output and agent/tool activity as first-class telemetry.
- Allows private telemetry and source maps to remain on the machine unless explicitly synced.
- Can index all repositories on a machine and preserve repo/run/process lineage.

## Integration Priority

Initial integrations should be intentionally narrow:

1. Next.js, Node.js, browser JavaScript, Vite, Bun, and generic command/build capture.
2. GitHub and GitLab for commit, release, owner, and PR context.
3. Slack and webhook alerts first, then Linear/Jira and PagerDuty/Opsgenie.
4. OpenTelemetry import/export to avoid trapping apps in a private telemetry format.
5. Logging libraries: Pino, Winston, console, Bunyan-compatible emitters, and raw stdout/stderr.

## Sources

- Sentry docs home: https://docs.sentry.io/
- Product walkthroughs: https://docs.sentry.io/product/
- Pricing and billing: https://docs.sentry.io/pricing/
- Data retention periods: https://docs.sentry.io/security-legal-pii/security/data-retention-periods/
- Logs GA changelog: https://sentry.io/changelog/logs-are-generally-available/
- Performance monitoring: https://docs.sentry.io/product/sentry-basics/performance-monitoring/
- Trace Explorer: https://docs.sentry.io/product/explore/trace-explorer/
- Session Replay for web: https://docs.sentry.io/product/explore/session-replay/web/
- Session Replay for mobile: https://docs.sentry.io/product/explore/session-replay/mobile/
- Replay details: https://docs.sentry.io/product/explore/session-replay/replay-details/
- Profiling: https://docs.sentry.io/product/explore/profiling/
- Monitors: https://docs.sentry.io/product/monitors-and-alerts/monitors/
- Cron monitoring: https://docs.sentry.io/product/monitors-and-alerts/monitors/crons/
- Uptime monitoring: https://docs.sentry.io/product/monitors-and-alerts/monitors/uptime-monitoring/
- Releases: https://docs.sentry.io/product/releases/
- Issues: https://docs.sentry.io/product/issues/
- Grouping and fingerprints: https://docs.sentry.io/product/issues/grouping-and-fingerprints/
- Next.js SDK: https://docs.sentry.io/platforms/javascript/guides/nextjs/
- JavaScript source maps: https://docs.sentry.io/platforms/javascript/sourcemaps/
- Next.js source maps: https://docs.sentry.io/platforms/javascript/guides/nextjs/sourcemaps/troubleshooting_js/
- AI in Sentry: https://docs.sentry.io/product/ai-in-sentry/
- AI agent monitoring: https://docs.sentry.io/platforms/javascript/guides/nextjs/ai-agent-monitoring/
- Application metrics: https://docs.sentry.io/product/explore/metrics/
- Application Metrics GA announcement: https://sentry.io/about/press-releases/sentry-launches-application-metrics/
- OTLP concepts: https://docs.sentry.io/concepts/otlp/
- Drains: https://docs.sentry.io/product/drains/
- OpenTelemetry support: https://sentry.io/solutions/opentelemetry/
- Platforms and SDKs: https://docs.sentry.io/platforms/
- Official Sentry SDK list: https://github.com/getsentry/sentry#official-sentry-sdks
- Sentry MCP: https://docs.sentry.io/product/sentry-mcp/
- Self-hosted Sentry: https://develop.sentry.dev/self-hosted/
- Self-hosted data flow: https://develop.sentry.dev/self-hosted/data-flow/
- Enhanced issue grouping changelog: https://sentry.io/changelog/enhanced-issue-grouping/
- AI-detected issues changelog: https://sentry.io/changelog/ai-detected-issues-now-generally-available/
