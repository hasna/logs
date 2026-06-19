# Adversarial Review: SDK Request Adapters

Date: 2026-06-16

## Verdict

The first SDK framework/request adapter slice is accepted by both adversarial reviewers.

The full universal telemetry robustness gate remains rejected.

## Accepted Slice

The reviewers accepted this implementation evidence:

- `captureHttpRequest` wraps Fetch API style request work and emits inbound `http.server` span events.
- `instrumentFetchHandler` wraps fetch-native route handlers for Next-style route handlers, workers, Bun, and other Fetch API runtimes.
- `createHonoTelemetryMiddleware` provides a structural Hono-style middleware adapter without adding a hard Hono dependency.
- Request spans preserve W3C `traceparent` correlation through `trace_id` and `parent_span_id`.
- Request spans capture route/path, method, status, duration, framework, and selected URL parts.
- Query strings are not captured by default; only `query_present` is stored.
- Request/response headers are captured only by explicit allowlist.
- Thrown handlers emit both an error span and an exception event, then rethrow the original error.
- Hono route resolution happens after `next()`, so real Hono middleware captures the matched endpoint route instead of the middleware mount route.
- The SDK build emits declaration files, including `sdk/dist/index.d.ts`, so TypeScript package consumers can use the adapter APIs.

## Verification

- `./node_modules/.bin/tsc --noEmit --pretty false`: passes.
- `bun test src/lib/sdk-client.test.ts src/server/server.test.ts`: 61 passing tests, 252 expectations.
- `bun test`: 222 passing tests, 790 expectations.
- `bun run build`: passes.
- `bun run build:dashboard`: passes.
- `cd sdk && bun run build && test -f dist/index.d.ts`: passes.
- `bun run lint`: still fails with 197 existing Biome diagnostics.

## Reviewer-Found Issues Fixed

- Initial review rejected the slice because Hono `routePath` was resolved before `next()`, which could record the middleware mount route such as `/*`. The fix defers route resolution until after the wrapped request work runs; regression coverage starts with `/*`, mutates to `/items/:id` inside `next()`, and verifies `/items/:id`.
- Initial review rejected the slice because the SDK package advertised `dist/index.d.ts` but did not generate it. The fix adds `sdk/tsconfig.json` and updates the SDK build to emit declarations.

## Remaining Full-Gate Rejection Reasons

- Repo-wide Biome lint still fails.
- Robust framework coverage is still incomplete for Next.js, Vite, Express, Fastify, workers, and OpenTelemetry.
- Replay/profile/artifact/source-map coverage remains incomplete.
- Raw segment sync and compatibility projection rebuild remain incomplete.
- High-volume, reconnect, crash-recovery, and multi-machine validation remain incomplete.
- Privacy hardening still needs generated-token onboarding, replay/input masking, broader adapter-specific redaction, and raw sync policy.
