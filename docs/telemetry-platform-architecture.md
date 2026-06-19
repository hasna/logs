# Telemetry Platform Architecture

Last updated: 2026-06-16

## Design Goals

- Local-first telemetry for every app, repo, process, build, and agent on a machine.
- Raw append-only files for durable event payloads.
- SQLite for metadata, mapping, indexing, correlation, and projection state.
- Real-time streams that work across CLI, dashboard, MCP, and SDKs.
- Universal data capture for agents and humans: logs, exceptions, traces, spans, metrics, profiles, replays, builds, processes, repos, machines, tool calls, and model/run metadata where available.
- Optional multi-machine sync without making the local developer workflow dependent on a cloud service.

## Non-goals For The Core

- Do not make PostgreSQL the primary local data store.
- Do not require a central service for local ingest.
- Do not store all large payloads directly in SQLite.
- Do not make hosted observability UI parity the first milestone.
- Do not build automated AI debugging workflows before the data substrate is robust.
- Do not sync secrets or replay payloads by default.

## Storage Layout

Default data directory:

```text
~/.hasna/logs/
  logs.db
  segments/
    machine_<id>/
      repo_<id>/
        app_<id>/
          2026/
            06/
              16/
                events-000001.jsonl
                events-000001.jsonl.idx
                events-000001.jsonl.zst
  artifacts/
    sourcemaps/
    profiles/
    replays/
    attachments/
  sync/
    cursors/
    manifests/
  config.json
```

Segment rules:

- Write newline-delimited JSON initially.
- Append only.
- Rotate by size and time.
- Store each record as one envelope line.
- Record byte offset and byte length in SQLite.
- Hash each record and segment.
- Compression happens after a segment is sealed.
- Sealed segments are immutable and safe to sync.

## SQLite Responsibilities

SQLite stores:

- Stable identities: machines, repos, apps, processes, runs, releases, environments.
- Segment catalog: path, sealed state, hash, compression, min/max event time, source scope.
- Event index: event ID, event time, ingest time, type, severity, source IDs, trace/span/session IDs, segment pointer, searchable excerpt.
- Search indexes: FTS over message, exception, stack frames, service, route, command, and selected attributes.
- Correlation maps: error to issue, event to trace, event to replay, run to process, release to repo.
- Projection offsets: durable cursors for issue grouping, alert evaluation, metrics rollups, sync, dashboards.
- Config and policies: retention, redaction, auth, sync, source-map mapping.

SQLite does not store:

- Full raw log bodies at scale.
- Replay payloads.
- Source maps.
- Profiles.
- Large attachments.
- Full command stdout/stderr blobs beyond searchable excerpts.

## Ingest Flow

1. SDK, CLI, MCP, scanner, or build wrapper sends an event envelope.
2. Collector validates schema, size, auth, and source policy.
3. Collector enriches missing machine/repo/process/run/app metadata.
4. Redaction runs before durable storage.
5. Event is appended to the active raw segment.
6. SQLite transaction inserts or upserts segment metadata and event index row.
7. In-memory event bus publishes the indexed event.
8. Async projections update issues, metrics, alerts, dashboards, and sync cursors.

Failure behavior:

- If append succeeds but SQLite insert fails, recovery scans unindexed segment records.
- If SQLite insert succeeds but publish fails, live stream may miss an event but persisted search remains correct.
- If process dies mid-line, recovery truncates to last valid newline or marks the segment damaged.

## Event Types

Core event types:

- `log`: structured log, console output, stdout/stderr line.
- `exception`: uncaught exception, handled exception, build/test failure.
- `span`: trace span with start/end, parent, operation, status.
- `metric`: counter, gauge, distribution, timing.
- `profile`: pointer to CPU/profile artifact.
- `replay`: pointer to replay segment or interaction event.
- `monitor`: cron check-in, uptime check, scanner result.
- `release`: build, deploy, source map, artifact, commit association.
- `agent`: MCP agent activity, tool call, model call, token usage, session state.
- `process`: process start, exit, signal, command, cwd, child process relation.
- `artifact`: source map, screenshot, profile, test report, build output, attachment.
- `network`: inbound request, outbound request, fetch failure, resource timing.
- `filesystem`: generated file, watched change, artifact write, path metadata.

## Data Completeness Standard

The platform is not complete because a UI can show a log line. It is complete for a data category only when:

- The raw payload is durably persisted or explicitly rejected by policy.
- SQLite records where the raw payload lives.
- The event has event time, ingest time, source, type, severity, and privacy metadata.
- The event is tied to machine, repo, app, process, and run identity when those dimensions exist.
- The event can be queried by its important dimensions.
- Real-time consumers can observe it if the source is live.
- The index can be rebuilt from raw files.
- Redaction behavior is tested for that data category.

## Query Model

Fast paths:

- Recent tail by event time and rowid.
- Filter by repo/app/machine/run/source/severity/type.
- Trace lookup by trace ID.
- Issue lookup by issue ID.
- Run context by run ID.
- Release context by release ID.
- Text search through FTS and selected attribute indexes.

Raw payload access:

- Query returns indexed fields by default.
- Full event payload is loaded from segment pointer on demand.
- Export reads from raw segments and joins metadata as needed.

## Real-time Model

The collector owns an event bus:

- Ingest publishes indexed events to subscribers.
- SSE and CLI watch subscribe to the same bus.
- Each stream has a bounded buffer.
- `Last-Event-ID` resumes from buffer when possible.
- If the buffer no longer has the event, stream falls back to SQLite catch-up from event time and event ID.
- Backpressure is explicit: slow clients receive summarized overflow markers and can catch up through search.

## Projections

Projections are replayable workers:

- Issue grouping.
- Alert evaluation.
- Metrics rollups.
- Dashboard materializations.
- Trace summaries.
- Release health.
- Retention planning.
- Sync manifests.

Each projection stores its cursor in `projection_offsets`.

Projection rule:

- The raw segment plus SQLite event index is the source of truth.
- Derived tables can be dropped and rebuilt.

## Security Model

Minimum required controls:

- API token for `/api/*` by default, with no-token loopback access only when explicitly started in local trusted mode.
- CORS allowlist.
- Payload size limits.
- Generated local secret on first run.
- AEAD encryption for stored secrets.
- Redaction before raw file write.
- Field classification: public, internal, secret, pii.
- Replay masking by default.
- Sensitive data excluded from sync by default.

## Sync Model

Sync should replicate immutable data first:

- Sealed segment manifests.
- Segment files.
- SQLite metadata deltas.
- Projection states only when useful and safe.

Avoid:

- Whole-table `SELECT *` sync.
- Syncing `page_auth` or secrets by default.
- Updating remote rows without source identity and conflict rules.

Required sync metadata:

- `source_machine_id`
- `segment_id`
- `segment_hash`
- `sealed_at`
- `uploaded_at`
- `remote_uri`
- `cursor`
- `last_error`

## Sentry Replacement Mapping

| Sentry concept | open-logs architecture object |
| --- | --- |
| Project | `apps` plus `repos` and environments |
| Event | raw event envelope plus `events` index row |
| Issue | projection over exception/log/span events |
| Trace | `spans` projection and trace index |
| Replay | replay artifacts plus replay event index |
| Release | `releases`, `deploys`, source maps, git metadata |
| Source maps | artifact store plus frame mapping indexes |
| Logs | raw segment records plus `log_records` compatibility view |
| Cron monitor | monitor definitions plus check-in events |
| Uptime monitor | HTTP probe definitions plus monitor events |
| Alerts | projection rules over event, issue, metric, and monitor data |
| Discover/dashboard | saved queries and materialized dashboard panels |
| Seer/MCP | local MCP tools plus AI summaries over local telemetry |

## Architectural Decision

The platform should keep the current CLI, REST, MCP, and dashboard surfaces as clients of the new event store. The central change is underneath them:

Current:

```text
SDK/API -> SQLite logs table -> queries/dashboard/MCP
```

Target:

```text
SDK/API/CLI/build/agent
  -> validate/enrich/redact
  -> append raw segment
  -> SQLite metadata/index
  -> event bus
  -> projections
  -> CLI/dashboard/MCP/sync
```
