# Adversarial Review: Node HTTP Framework Adapters

Date: 2026-06-16

## Verdict

The Node HTTP, Express-style, and Fastify-style SDK adapter slice is accepted by both adversarial reviewers.

The full universal telemetry robustness gate remains rejected.

## Accepted Scope

- `captureNodeHttpRequest` captures structural Node request/response objects without importing framework packages.
- `createExpressTelemetryMiddleware` captures response-finish spans and resolves Express route templates after downstream handlers run.
- `createFastifyTelemetryHooks` captures Fastify-style request/reply lifecycle spans through structural hooks.
- Node HTTP adapters emit the same `http.server` span shape as Fetch API and Hono adapters.
- Request error captures emit a span plus exception event.
- W3C `traceparent` is preserved when present.
- Query strings are not serialized by default; only `query_present` and `url_path` are indexed.
- Request and response headers are captured only through explicit allowlists.

## Adversarial Findings And Fixes

Initial reviews rejected the slice for malformed Node URL synthesis risks:

- A malformed `Host` such as `[::1` could make `new Request(...)` throw inside telemetry emission, creating an unhandled rejection from instrumentation.
- A delimiter-bearing `Host` such as `example.com?token=secret` could corrupt synthesized URL parsing and route/path telemetry.

Fixes:

- `captureNodeHttpRequest` catches telemetry emission failures so instrumentation does not destabilize the host app.
- Node URL synthesis validates absolute URLs and falls back safely.
- `safeNodeHost` rejects whitespace, slash, backslash, query/hash delimiters, and userinfo markers before interpolation.
- `safeNodeHost` verifies parsed host round-trip before accepting the host value.
- Regression tests cover malformed `[::1` and delimiter-bearing `example.com?token=secret` hosts, proving fallback to `localhost`, stable `/safe` route/path telemetry, `query_present: true`, and no serialized `secret`.

## Verification

Latest local evidence after fixes:

- `bun test src/lib/sdk-client.test.ts`: 18 passing tests, 63 expectations.
- `bun test src/lib/sdk-client.test.ts src/server/server.test.ts`: 67 passing tests, 272 expectations.
- `bunx tsc --noEmit`: passes.
- `bunx biome check src/lib/sdk-client.test.ts`: passes.
- `bun test`: 228 passing tests, 810 expectations.
- `bun run build`: passes.
- `cd sdk && bun run build && test -f dist/index.d.ts`: passes.
- `bun run build:dashboard`: passes.
- `bun run lint`: still fails with 197 existing Biome diagnostics across `src/`.

## Remaining Full-Gate Blockers

The reviewers still reject the full universal telemetry substrate claim because:

- Repo-wide Biome lint is still not green.
- Next.js, Vite, workers, OpenTelemetry, replay/profile/artifact/source-map, and agent/tool/model telemetry coverage remain incomplete.
- Real framework validation is still missing for Express and Fastify beyond structural SDK tests. A follow-up hardening slice added structural coverage for Express-style error middleware and Node request/response `error` events, but real app validation remains part of the broader lab.
- High-volume, multi-process, reconnect/backpressure, crash-recovery, raw sync, projection rebuild, and one-week dogfood evidence are still missing.
- Privacy hardening is still first-pass outside the currently tested ingest and adapter paths.

## Follow-up Hardening

After this review, the SDK added:

- `createExpressErrorTelemetryMiddleware`, which finishes the capture started by `createExpressTelemetryMiddleware` and forwards the error to the next Express error handler.
- Node request/response error observation through Node's non-consuming `errorMonitor` symbol when the runtime exposes it, so telemetry does not consume or suppress EventEmitter `error` semantics.
- Request `aborted` capture as a `499` closed-response span.
- Exact listener cleanup callbacks for structural emitters, with cleanup assertions in tests.
- Regression tests for Express error middleware, response `error`, request `error`, and request `aborted` paths.

Latest verification for that hardening slice:

- `bun test src/lib/sdk-client.test.ts`: 22 passing tests, 91 expectations.
- `bun test src/lib/sdk-client.test.ts src/server/server.test.ts`: 71 passing tests, 300 expectations.
- `bun test`: 232 passing tests, 838 expectations.
- `bunx biome check src/lib/sdk-client.test.ts`: passes.
- `bun run lint`: still fails with 197 existing Biome diagnostics across `src/`.
