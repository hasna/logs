# Adversarial Review: Node/Bun Runtime SDK Capture

Date: 2026-06-16

## Verdict

The Node/Bun runtime SDK capture slice is accepted by both adversarial reviewers.

The full universal telemetry robustness gate remains rejected.

## Accepted Slice

The reviewers accepted this implementation evidence:

- `initUniversalLogs` now dispatches to browser or Node/Bun runtime capture from the same SDK entrypoint.
- `initNodeLogs` captures console debug/log/info/warn/error records as universal `log` events.
- `initNodeLogs` captures process start and beforeExit records as universal `process` events.
- Fatal exception capture uses `uncaughtExceptionMonitor`, not `uncaughtException`, so installing the SDK does not suppress the runtime's default crash behavior.
- Unhandled rejection capture is opt-in through `captureRejections: true`; it is not installed by default because Node does not expose a non-mutating rejection monitor event.
- Generic `fetch` success and failure records are captured as universal span/network events.
- Collector self-fetches are ignored to prevent recursive telemetry, while lookalike collector hosts are still captured as normal outbound fetches.
- `controller.stop()` restores patched console methods, process listeners, and the exact original `fetch` function object.
- The SDK package now exposes `./node` to the same universal SDK entrypoint.

## Verification

- `./node_modules/.bin/tsc --noEmit --pretty false`: passes.
- `bun test src/lib/sdk-client.test.ts src/server/server.test.ts`: 58 passing tests, 242 expectations.
- `bun test`: 219 passing tests, 780 expectations.
- `bun run build`: passes.
- `bun run build:dashboard`: passes.
- `cd sdk && bun run build`: passes.
- `bun run lint`: still fails with 197 existing Biome diagnostics.

## Reviewer-Found Issues Fixed

- Initial review rejected the slice because using `uncaughtException` changed fatal process behavior. The fix uses `uncaughtExceptionMonitor` and regression tests assert that `uncaughtException` listener count is unchanged.
- Initial review rejected the slice because `stop()` restored a bound fetch wrapper instead of the original function object. The fix stores the original `fetch`, uses a separate bound caller internally, and regression tests assert exact identity restoration.

## Remaining Full-Gate Rejection Reasons

- Historical note: repo-wide Biome lint was not part of this accepted slice.
- Framework adapters are still incomplete for Next.js, Vite, Hono, Express, Fastify, workers, and OpenTelemetry.
- Raw segment sync and compatibility projection rebuild remain incomplete.
- High-volume, slow-client, reconnect, crash-recovery, and multi-machine validation remain incomplete.
- Privacy hardening still needs generated-token onboarding, replay/input masking, broader adapter-specific redaction, and raw sync policy.
