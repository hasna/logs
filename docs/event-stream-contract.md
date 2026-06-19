# Event Stream Contract

Last updated: 2026-06-16

This contract defines the first shared real-time telemetry surface for open-logs consumers.

The stream source of truth is the raw-backed `event_records` catalog. Consumers should treat legacy log streams as compatibility paths only.

## API SSE

Endpoint:

```text
GET /api/events/stream
```

Useful query parameters:

- `event_name=event`: emit all catalog entries under the stable SSE event name `event`. The payload still contains the concrete `event_type`.
- `type` or `event_type`: comma-separated event types.
- `source`: comma-separated sources.
- `severity` or `level`: comma-separated severities.
- `project_id`, `page_id`, `machine_id`, `repo_id`, `app_id`, `process_id`, `run_id`, `trace_id`, `span_id`, `session_id`, `release_id`, `environment`: correlation filters.
- `include_raw=true`: include reconstructed raw segment envelopes when available.
- `last_event_id`: resume after a catalog event id. The `Last-Event-ID` header is also supported.

Default event naming:

- Without `event_name=event`, the SSE event name is the concrete event type, such as `log`, `span`, `metric`, or `process`.
- With `event_name=event`, every catalog entry is emitted as `event: event`. This is the recommended mode for generic agents and dashboards.

Every event frame includes:

```text
id: <event_id>
event: <event_type or event>
data: <EventCatalogEntry JSON>
```

Overflow frames use:

```text
event: overflow
data: {"type":"overflow","reason":"...","dropped":0,"last_event_id":"...","requested_last_event_id":"...","created_at":"..."}
```

Known overflow reasons include:

- `buffer_miss_sqlite_catchup`
- `last_event_id_unknown`
- `sqlite_catchup_truncated`
- `subscriber_queue_overflow`
- `raw_event_unreadable`

Consumers must treat overflow as explicit evidence that the stream was not perfectly continuous. They should retry from `last_event_id` when present, or query `event_records` directly when they need a complete audit. For `last_event_id_unknown`, `last_event_id` is the server-selected usable anchor cursor and `requested_last_event_id` is the bad cursor the client supplied.

Validation-only controls:

- When `HASNA_LOGS_STREAM_TEST_HOOKS=1`, `/api/events/stream` accepts `debug_subscriber_queue=<n>` and `debug_write_delay_ms=<n>` to force deterministic backpressure in repeatable validation labs.
- These controls are not part of the production consumer contract. They exist to prove that slow subscribers get explicit overflow markers and SQLite catch-up instead of silent gaps.

## CLI Consumers

Local event catalog watch:

```bash
logs watch --events --type log,metric --format json
```

Remote API stream watch:

```bash
logs watch --server http://127.0.0.1:3460 --type metric --last-event-id <event_id> --format json
```

Token-secured remote watch:

```bash
logs watch --server http://127.0.0.1:3460 --token "$HASNA_LOGS_API_TOKEN" --type metric --format json
```

Local watch uses SQLite `rowid` as the cursor and prints `last_event_id_unknown` to stderr when a requested cursor is missing. Remote watch uses `/api/events/stream?event_name=event` and sends both `last_event_id` and `Last-Event-ID` on reconnect.

## Dashboard Consumer

Dashboard live tail consumes:

```text
/api/events/stream?event_name=event
```

It uses a fetch-backed SSE reader instead of native `EventSource` so token-secured dashboards can send `Authorization: Bearer <token>` without putting tokens in URLs. The dashboard token control stores the token in browser session storage, shared dashboard API calls attach the same header, the live tail stores the last seen event id, closes the stream while paused, and reconnects with `last_event_id` on resume.

## MCP Consumer

MCP exposes a bounded polling tool for agent live-tail loops:

```text
event_watch(last_event_id?, event_type?, source?, severity?, project_id?, trace_id?, run_id?, limit?=100, include_raw?=false, from_start?=false)
```

Semantics:

- With `last_event_id`, returns catalog entries after that event.
- With a missing `last_event_id`, returns an explicit `last_event_id_unknown` overflow marker and anchors the cursor at the latest matching event.
- Without `last_event_id` and without `from_start=true`, returns no events and gives the latest matching cursor. This lets agents start watching without replaying history.
- With `from_start=true`, returns the first matching events from the catalog.

## Remaining Validation Gaps

This contract has first-pass unit/integration coverage and a bounded real-server validation harness:

- `bun run validate:streams -- --keep` retained `/tmp/open-logs-stream-load-q2aFBk/stream-load-validation-report.json`, proving direct generic SSE live delivery, `Last-Event-ID` buffer-miss SQLite catch-up, forced slow-subscriber `subscriber_queue_overflow`, bounded multi-consumer API SSE fanout with 8 consumers receiving 80 burst events each, remote CLI watch, local CLI watch, MCP `event_watch` over stdio with raw envelopes, missing-cursor overflow, and `doctor segments` with 141 checked raw events and 0 unindexed raw events.
- `bun run validate:dashboard-stream -- --keep` retained `/tmp/open-logs-dashboard-stream-lab-SWSrG9/dashboard-stream-validation-report.json`, proving the built dashboard in Chromium blocks the stream without a token, sends `Authorization` on fetch-backed SSE after token entry, renders live event-catalog records, enters the dashboard paused state, resumes with query `last_event_id`, catches up an event written while paused, receives a post-resume live event, and leaves raw segment plus SQLite doctor evidence with 0 unindexed raw events on both the source server and extracted npm package server paths.

This is still not final-gate evidence.

Still required:

- Long-running reconnect validation.
- Larger high-rate multi-consumer stream validation beyond the bounded 8-consumer/80-event fanout.
- MCP polling loops under larger concurrent writes.
- Broader browser/dashboard onboarding, reconnect-after-drop, and long-running reconnect-state UX beyond the first real-browser manual-token and pause/resume proof.
- Cross-process and multi-machine validation.
