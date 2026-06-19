# Open Logs Planning Docs

These docs describe the plan to turn `@hasna/logs` into a local-first universal telemetry data substrate for apps, repositories, machines, builds, processes, agents, and frameworks.

Read in this order:

1. [Universal Telemetry Data Substrate Plan](./universal-telemetry-data-substrate-plan.md)
2. [Universal Data Capture Matrix](./universal-data-capture-matrix.md)
3. [Telemetry Platform Architecture](./telemetry-platform-architecture.md)
4. [Event Stream Contract](./event-stream-contract.md)
5. [Sentry Capability Audit 2026](./sentry-capability-audit-2026.md)
6. [Real-Life Telemetry Validation Plan](./real-life-validation-plan.md)
7. [Adversarial Acceptance Gate](./adversarial-acceptance-gate.md)
8. [Adversarial Review: Event Catalog And Universal Ingest](./adversarial-review-2026-06-16-event-ingest.md)
9. [Adversarial Review: Node/Bun Runtime SDK Capture](./adversarial-review-2026-06-16-node-runtime-sdk.md)
10. [Adversarial Review: SDK Request Adapters](./adversarial-review-2026-06-16-request-adapters.md)
11. [Adversarial Review: Node HTTP Framework Adapters](./adversarial-review-2026-06-16-node-http-adapters.md)

Current conclusion:

- The existing app is a useful prototype, but its storage model is inverted for the target product.
- Raw event payloads should live in append-only files.
- SQLite should store metadata, mappings, indexes, correlations, and projection cursors.
- The primary goal is data completeness and agent-accessible context, not built-in AI debugging automation.
- Sentry is a reference for telemetry categories, not the product architecture.
- The current gate status is still rejected until universal capture, raw replication, resumable streams, crash recovery, high-volume validation, and security/privacy evidence are complete.

When this project removes the need for Sentry, it should be because we collect enough raw data locally that teams and agents have the observability context they need. It should not mean cloning Sentry's hosted debugging workflow or AI product surface.
