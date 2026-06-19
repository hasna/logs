# Adversarial Review: Event Catalog And Universal Ingest

Date: 2026-06-16

## Verdict

Rejected by both independent adversarial reviewers.

Open-logs is materially stronger after the event catalog and first universal ingest work, but it is still not robust enough to claim universal telemetry data-substrate status.

Latest slice re-review after SDK/browser-token event-ingest hardening: both adversarial reviewers accepted the patched slice, but both still rejected the full robustness gate.

## Evidence Reviewers Credited

- Raw JSONL event segments exist for supported ingest paths.
- SQLite stores `event_segments` and `event_records` pointers with byte offsets, byte lengths, and record hashes.
- Event catalog read helpers, `/api/events`, CLI `logs events`, and MCP event tools can search indexed events and reconstruct raw envelopes from segment pointers.
- `POST /api/events`, `logs events push`, MCP `event_push`, and `ingestUniversalEvent` provide a first raw-first universal event ingest path.
- Full `bun test` and `bun run build` pass locally after the post-review hardening slice.
- `bun run build:dashboard` passes after dashboard live tail moved from `/api/logs/stream` to `/api/events/stream`.

## Issues Fixed Immediately After Review

- Top-level universal event source/correlation fields are now redacted before raw persistence, including `source_event_id`.
- Universal ingest now derives a stable internal `event_id` from `source + source_event_id` when no canonical event ID is supplied, so producer retries dedupe.
- Universal event validation now checks invalid timestamps, severity values, and privacy values before `POST /api/events` batch writes.
- Regression coverage now includes source-event canary redaction, source-event retry idempotency, and invalid batch prevalidation.
- A first shared event-catalog stream now exists: `GET /api/events/stream` receives indexed log, universal, and process lifecycle events, filters by event metadata, resumes with `Last-Event-ID`, catches up from `event_records`, catches SQLite-only first matching events, can include raw envelopes, falls back to indexed metadata on raw-read failure, and emits explicit overflow events.
- A follow-up stream review found a no-anchor cursor bug where an empty stream could skip the first SQLite-only matching event. That defect is fixed and covered by route tests.
- `GET /api/events/stream` now supports `event_name=event` so generic consumers can subscribe once and read the concrete telemetry type from each payload.
- Dashboard live tail now consumes the generic event-catalog stream, deduplicates by `event_id`, renders event catalog entries instead of legacy log rows, and resumes after pause with explicit `last_event_id` catch-up.
- CLI watch now has first-pass event-catalog modes: local `logs watch --events` rowid-cursor polling and API-backed `logs watch --server` streaming with reconnect, overflow handling, token support, and `Last-Event-ID` resume.
- A follow-up stream-consumer review found that local `logs watch --events --last-event-id missing` silently replayed history from rowid `0`; that defect is fixed with an explicit `last_event_id_unknown` marker and latest-event anchoring, and is covered by a CLI regression test.
- Remote `logs watch --server` now has a secured integration test proving token-authenticated one-shot stream delivery after `Last-Event-ID`.
- MCP now exposes `event_watch`, a bounded cursor-polling tool over `event_records` with explicit missing-cursor markers and no-history default anchoring.
- The external stream contract is documented in `docs/event-stream-contract.md`.
- Repo-wide `./node_modules/.bin/tsc --noEmit --pretty false` now passes after SQLite binding, scanner typing, and removal of the stale external CLI event registration.
- The SDK now has first-pass universal event helpers for generic events, exceptions, metrics, spans, and browser universal auto-capture, and scoped browser ingest tokens can write restricted browser-safe event types to `/api/events` with forced token project ownership, top-level and nested identity-spoof rejection, project-scoped browser producer IDs, and token metadata redaction.
- A follow-up adversarial review found that browser-token `/api/events` still accepted top-level `artifact_id`; the server now checks the complete forbidden identity list for browser-token events and a regression proves top-level `artifact_id` returns `422`.

## Latest Slice Re-review

Both adversarial reviewers accepted the patched SDK/browser-token universal event slice after the `artifact_id` fix.

Verified evidence:

- `./node_modules/.bin/tsc --noEmit --pretty false`: passes.
- `bun test src/lib/sdk-client.test.ts src/server/server.test.ts`: 55 passing tests, 223 expectations.
- `bun test`: 216 passing tests, 761 expectations.
- `bun run build`: passes.
- `bun run build:dashboard`: passes.
- `cd sdk && bun run build`: passes.
- `bun run lint`: still fails with 197 Biome diagnostics.

## Remaining Rejection Reasons

- Capture is not universal yet. The SDK has first-pass universal event helpers and browser-token event writes, but server/framework, OpenTelemetry, replay/profile, artifact/source-map, monitor, and agent/tool/model adapters do not emit through the universal event contract by default.
- Real-time consumers are still not validation-complete. `/api/events/stream` now provides a shared `event_records` stream contract for non-log universal events, dashboard live tail consumes it with explicit resume and token-capable fetch-backed SSE, CLI watch has first-pass event-catalog modes, MCP has `event_watch`, and stream docs exist, but long-running remote reconnect/overflow testing, broader dashboard auth/onboarding/reconnect-state UX, and high-volume/slow-client validation still need to move onto or validate against it.
- Raw replay rebuilds the event index, but not compatibility projections such as `logs`, `issues`, `traces`, `spans`, `sessions`, `releases`, `artifacts`, `processes`, and `runs`.
- Recovery is detection-heavy. Partial/corrupt-line quarantine, truncation repair, crash injection, and disk-failure recovery are not proven.
- Raw segment sync is incomplete. Metadata sync exists, but raw JSONL segment files, sealed manifests, and payload sync policy are not replicated.
- High-volume behavior is not proven. The required 1M-event, 10k/sec burst, slow-client, reconnect, and multi-process validation lab has not run.
- Repository-wide `bun run lint` still fails with 197 existing Biome diagnostics, although repo-wide `tsc --noEmit --pretty false`, `bun test`, `bun run build`, `bun run build:dashboard`, and `cd sdk && bun run build` now pass locally.

## Follow-up Tasks

- `4b1ce35f`: migrate live consumers to a shared event catalog stream contract.
- `06dd11e7`: capture browser, server, and framework telemetry universally.
- `0d93b989`: rebuild universal compatibility projections from raw event segments.
- `0b121c9a`: create the real-life telemetry validation lab.
- `625c572a`: create high-volume concurrent ingest stress validation.
- `b00f4951`: create crash and failure injection recovery validation.
- `e8608b66`: stabilize repository verification gates.
