import { describe, expect, it } from "bun:test";
import type { LogRow } from "../types/index.ts";
import { EventCatalogBus, LogEventBus } from "./event-bus.ts";
import type { EventCatalogEntry } from "./events.ts";

describe("LogEventBus", () => {
  it("publishes matching log events to subscribers", async () => {
    const bus = new LogEventBus(10);
    const sub = bus.subscribe({ project_id: "p1", levels: ["error"] });

    bus.publish(logRow("other", { project_id: "p2", level: "error" }));
    bus.publish(logRow("skip-level", { project_id: "p1", level: "info" }));
    bus.publish(logRow("match", { project_id: "p1", level: "error" }));

    const event = await sub.next();
    expect(event.done).toBe(false);
    expect(event.value?.kind).toBe("log");
    if (event.value?.kind === "log") expect(event.value.id).toBe("match");
    await sub.return?.();
  });

  it("emits explicit overflow when a subscriber queue is overrun", async () => {
    const bus = new LogEventBus(10);
    const sub = bus.subscribe({}, { maxQueue: 1 });

    bus.publish(logRow("first"));
    bus.publish(logRow("second"));

    const overflow = await sub.next();
    expect(overflow.value?.kind).toBe("overflow");
    if (overflow.value?.kind === "overflow") {
      expect(overflow.value.reason).toBe("subscriber_queue_overflow");
      expect(overflow.value.dropped).toBe(1);
    }

    const second = await sub.next();
    expect(second.value?.kind).toBe("log");
    if (second.value?.kind === "log") expect(second.value.id).toBe("second");
    await sub.return?.();
  });

  it("tracks bounded replay buffer membership", () => {
    const bus = new LogEventBus(2);
    bus.publish(logRow("one"));
    bus.publish(logRow("two"));
    bus.publish(logRow("three"));

    expect(bus.hasBufferedLog("one")).toBe(false);
    expect(bus.hasBufferedLog("two")).toBe(true);
    expect(bus.hasBufferedLog("three")).toBe(true);
  });
});

describe("EventCatalogBus", () => {
  it("publishes matching catalog events to subscribers", async () => {
    const bus = new EventCatalogBus(10);
    const sub = bus.subscribe({ event_type: ["span"], trace_id: "trace-1" });

    bus.publish(
      eventEntry("skip-type", { event_type: "metric", trace_id: "trace-1" }),
    );
    bus.publish(
      eventEntry("skip-trace", { event_type: "span", trace_id: "trace-2" }),
    );
    bus.publish(
      eventEntry("match", { event_type: "span", trace_id: "trace-1" }),
    );

    const event = await sub.next();
    expect(event.done).toBe(false);
    expect(event.value?.kind).toBe("event");
    if (event.value?.kind === "event") expect(event.value.id).toBe("match");
    await sub.return?.();
  });

  it("emits explicit overflow when a catalog subscriber queue is overrun", async () => {
    const bus = new EventCatalogBus(10);
    const sub = bus.subscribe({}, { maxQueue: 1 });

    bus.publish(eventEntry("first"));
    bus.publish(eventEntry("second"));

    const overflow = await sub.next();
    expect(overflow.value?.kind).toBe("overflow");
    if (overflow.value?.kind === "overflow") {
      expect(overflow.value.reason).toBe("subscriber_queue_overflow");
      expect(overflow.value.dropped).toBe(1);
    }

    const second = await sub.next();
    expect(second.value?.kind).toBe("event");
    if (second.value?.kind === "event") expect(second.value.id).toBe("second");
    await sub.return?.();
  });

  it("tracks bounded catalog replay buffer membership", () => {
    const bus = new EventCatalogBus(2);
    bus.publish(eventEntry("one"));
    bus.publish(eventEntry("two"));
    bus.publish(eventEntry("three"));

    expect(bus.hasBufferedEvent("one")).toBe(false);
    expect(bus.hasBufferedEvent("two")).toBe(true);
    expect(bus.hasBufferedEvent("three")).toBe(true);
  });
});

function logRow(id: string, overrides: Partial<LogRow> = {}): LogRow {
  return {
    id,
    timestamp: new Date().toISOString(),
    project_id: null,
    page_id: null,
    level: "info",
    source: "sdk",
    service: null,
    message: id,
    trace_id: null,
    session_id: null,
    agent: null,
    url: null,
    stack_trace: null,
    metadata: null,
    ...overrides,
  };
}

function eventEntry(
  id: string,
  overrides: Partial<EventCatalogEntry> = {},
): EventCatalogEntry {
  return {
    event_id: id,
    schema_version: 1,
    source_event_id: null,
    event_type: "log",
    event_time: new Date().toISOString(),
    ingest_time: new Date().toISOString(),
    severity: "info",
    source: "sdk",
    project_id: null,
    page_id: null,
    log_id: null,
    machine_id: null,
    repo_id: null,
    app_id: null,
    process_id: null,
    run_id: null,
    trace_id: null,
    span_id: null,
    parent_span_id: null,
    session_id: null,
    release_id: null,
    environment: null,
    artifact_id: null,
    privacy_tier: "internal",
    segment_id: "segment",
    segment_path: "events/test.jsonl",
    byte_offset: 0,
    byte_length: 1,
    record_hash: "hash",
    message: id,
    metadata: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}
