import type { LogLevel, LogRow } from "../types/index.ts";
import type { EventCatalogEntry } from "./events.ts";

export interface LogStreamFilter {
  project_id?: string;
  levels?: LogLevel[];
  service?: string;
}

export interface EventCatalogStreamFilter {
  event_type?: string[];
  source?: string[];
  severity?: string[];
  project_id?: string;
  page_id?: string;
  machine_id?: string;
  repo_id?: string;
  app_id?: string;
  process_id?: string;
  run_id?: string;
  trace_id?: string;
  span_id?: string;
  session_id?: string;
  release_id?: string;
  environment?: string;
}

export type LogBusEvent =
  | {
      kind: "log";
      sequence: number;
      id: string;
      row: LogRow;
      created_at: string;
    }
  | {
      kind: "overflow";
      sequence: number;
      dropped: number;
      reason: string;
      created_at: string;
    };

export type EventCatalogBusEvent =
  | {
      kind: "event";
      sequence: number;
      id: string;
      entry: EventCatalogEntry;
      created_at: string;
    }
  | {
      kind: "overflow";
      sequence: number;
      dropped: number;
      reason: string;
      created_at: string;
    };

interface Subscriber {
  filter: LogStreamFilter;
  maxQueue: number;
  queue: LogBusEvent[];
  resolve?: (result: IteratorResult<LogBusEvent>) => void;
  closed: boolean;
}

interface EventCatalogSubscriber {
  filter: EventCatalogStreamFilter;
  maxQueue: number;
  queue: EventCatalogBusEvent[];
  resolve?: (result: IteratorResult<EventCatalogBusEvent>) => void;
  closed: boolean;
}

export class LogEventBus {
  private buffer: LogBusEvent[] = [];
  private subscribers = new Set<Subscriber>();
  private sequence = 0;

  constructor(
    private readonly bufferSize = readPositiveInt(
      "HASNA_LOGS_STREAM_BUFFER_SIZE",
      1_000,
    ),
  ) {}

  publish(row: LogRow): LogBusEvent {
    const event: LogBusEvent = {
      kind: "log",
      sequence: ++this.sequence,
      id: row.id,
      row,
      created_at: new Date().toISOString(),
    };
    this.buffer.push(event);
    while (this.buffer.length > this.bufferSize) this.buffer.shift();

    for (const subscriber of this.subscribers) {
      if (matchesLogFilter(row, subscriber.filter))
        this.enqueue(subscriber, event);
    }
    return event;
  }

  subscribe(
    filter: LogStreamFilter = {},
    opts: { maxQueue?: number } = {},
  ): AsyncIterableIterator<LogBusEvent> {
    const subscriber: Subscriber = {
      filter,
      maxQueue:
        opts.maxQueue ??
        readPositiveInt("HASNA_LOGS_STREAM_SUBSCRIBER_QUEUE", 500),
      queue: [],
      closed: false,
    };
    this.subscribers.add(subscriber);

    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => this.next(subscriber),
      return: async () => {
        this.close(subscriber);
        return { done: true, value: undefined };
      },
    };
  }

  hasBufferedLog(id: string): boolean {
    return this.buffer.some((event) => event.kind === "log" && event.id === id);
  }

  clearForTests(): void {
    for (const subscriber of this.subscribers) this.close(subscriber);
    this.buffer = [];
    this.sequence = 0;
  }

  private enqueue(subscriber: Subscriber, event: LogBusEvent): void {
    if (subscriber.closed) return;
    if (subscriber.queue.length >= subscriber.maxQueue) {
      const dropped = subscriber.queue.length;
      subscriber.queue = [
        {
          kind: "overflow",
          sequence: ++this.sequence,
          dropped,
          reason: "subscriber_queue_overflow",
          created_at: new Date().toISOString(),
        },
      ];
    }
    subscriber.queue.push(event);

    if (subscriber.resolve) {
      const resolve = subscriber.resolve;
      subscriber.resolve = undefined;
      const next = subscriber.queue.shift();
      if (next) resolve({ done: false, value: next });
    }
  }

  private next(subscriber: Subscriber): Promise<IteratorResult<LogBusEvent>> {
    if (subscriber.closed)
      return Promise.resolve({ done: true, value: undefined });
    const next = subscriber.queue.shift();
    if (next) return Promise.resolve({ done: false, value: next });
    return new Promise((resolve) => {
      subscriber.resolve = resolve;
    });
  }

  private close(subscriber: Subscriber): void {
    if (subscriber.closed) return;
    subscriber.closed = true;
    this.subscribers.delete(subscriber);
    if (subscriber.resolve) {
      const resolve = subscriber.resolve;
      subscriber.resolve = undefined;
      resolve({ done: true, value: undefined });
    }
  }
}

export class EventCatalogBus {
  private buffer: EventCatalogBusEvent[] = [];
  private subscribers = new Set<EventCatalogSubscriber>();
  private sequence = 0;

  constructor(
    private readonly bufferSize = readPositiveInt(
      "HASNA_LOGS_STREAM_BUFFER_SIZE",
      1_000,
    ),
  ) {}

  publish(entry: EventCatalogEntry): EventCatalogBusEvent {
    const event: EventCatalogBusEvent = {
      kind: "event",
      sequence: ++this.sequence,
      id: entry.event_id,
      entry,
      created_at: new Date().toISOString(),
    };
    this.buffer.push(event);
    while (this.buffer.length > this.bufferSize) this.buffer.shift();

    for (const subscriber of this.subscribers) {
      if (matchesEventCatalogFilter(entry, subscriber.filter))
        this.enqueue(subscriber, event);
    }
    return event;
  }

  subscribe(
    filter: EventCatalogStreamFilter = {},
    opts: { maxQueue?: number } = {},
  ): AsyncIterableIterator<EventCatalogBusEvent> {
    const subscriber: EventCatalogSubscriber = {
      filter,
      maxQueue:
        opts.maxQueue ??
        readPositiveInt("HASNA_LOGS_STREAM_SUBSCRIBER_QUEUE", 500),
      queue: [],
      closed: false,
    };
    this.subscribers.add(subscriber);

    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => this.next(subscriber),
      return: async () => {
        this.close(subscriber);
        return { done: true, value: undefined };
      },
    };
  }

  hasBufferedEvent(id: string): boolean {
    return this.buffer.some(
      (event) => event.kind === "event" && event.id === id,
    );
  }

  clearForTests(): void {
    for (const subscriber of this.subscribers) this.close(subscriber);
    this.buffer = [];
    this.sequence = 0;
  }

  private enqueue(
    subscriber: EventCatalogSubscriber,
    event: EventCatalogBusEvent,
  ): void {
    if (subscriber.closed) return;
    if (subscriber.queue.length >= subscriber.maxQueue) {
      const dropped = subscriber.queue.length;
      subscriber.queue = [
        {
          kind: "overflow",
          sequence: ++this.sequence,
          dropped,
          reason: "subscriber_queue_overflow",
          created_at: new Date().toISOString(),
        },
      ];
    }
    subscriber.queue.push(event);

    if (subscriber.resolve) {
      const resolve = subscriber.resolve;
      subscriber.resolve = undefined;
      const next = subscriber.queue.shift();
      if (next) resolve({ done: false, value: next });
    }
  }

  private next(
    subscriber: EventCatalogSubscriber,
  ): Promise<IteratorResult<EventCatalogBusEvent>> {
    if (subscriber.closed)
      return Promise.resolve({ done: true, value: undefined });
    const next = subscriber.queue.shift();
    if (next) return Promise.resolve({ done: false, value: next });
    return new Promise((resolve) => {
      subscriber.resolve = resolve;
    });
  }

  private close(subscriber: EventCatalogSubscriber): void {
    if (subscriber.closed) return;
    subscriber.closed = true;
    this.subscribers.delete(subscriber);
    if (subscriber.resolve) {
      const resolve = subscriber.resolve;
      subscriber.resolve = undefined;
      resolve({ done: true, value: undefined });
    }
  }
}

export const logEventBus = new LogEventBus();
export const eventCatalogBus = new EventCatalogBus();

export function publishLogEvent(row: LogRow): LogBusEvent {
  return logEventBus.publish(row);
}

export function publishEventCatalogEvent(
  entry: EventCatalogEntry,
): EventCatalogBusEvent {
  return eventCatalogBus.publish(entry);
}

export function subscribeLogEvents(
  filter?: LogStreamFilter,
  opts?: { maxQueue?: number },
): AsyncIterableIterator<LogBusEvent> {
  return logEventBus.subscribe(filter, opts);
}

export function subscribeEventCatalogEvents(
  filter?: EventCatalogStreamFilter,
  opts?: { maxQueue?: number },
): AsyncIterableIterator<EventCatalogBusEvent> {
  return eventCatalogBus.subscribe(filter, opts);
}

export function hasBufferedLogEvent(id: string): boolean {
  return logEventBus.hasBufferedLog(id);
}

export function hasBufferedEventCatalogEvent(id: string): boolean {
  return eventCatalogBus.hasBufferedEvent(id);
}

export function clearLogEventBusForTests(): void {
  logEventBus.clearForTests();
}

export function clearTelemetryEventBusesForTests(): void {
  logEventBus.clearForTests();
  eventCatalogBus.clearForTests();
}

export function matchesLogFilter(
  row: LogRow,
  filter: LogStreamFilter,
): boolean {
  if (filter.project_id && row.project_id !== filter.project_id) return false;
  if (filter.service && row.service !== filter.service) return false;
  if (
    filter.levels &&
    filter.levels.length > 0 &&
    !filter.levels.includes(row.level)
  )
    return false;
  return true;
}

export function matchesEventCatalogFilter(
  entry: EventCatalogEntry,
  filter: EventCatalogStreamFilter,
): boolean {
  if (
    filter.event_type &&
    filter.event_type.length > 0 &&
    !filter.event_type.includes(entry.event_type)
  )
    return false;
  if (
    filter.source &&
    filter.source.length > 0 &&
    !filter.source.includes(entry.source)
  )
    return false;
  if (
    filter.severity &&
    filter.severity.length > 0 &&
    (!entry.severity || !filter.severity.includes(entry.severity))
  )
    return false;
  if (filter.project_id && entry.project_id !== filter.project_id) return false;
  if (filter.page_id && entry.page_id !== filter.page_id) return false;
  if (filter.machine_id && entry.machine_id !== filter.machine_id) return false;
  if (filter.repo_id && entry.repo_id !== filter.repo_id) return false;
  if (filter.app_id && entry.app_id !== filter.app_id) return false;
  if (filter.process_id && entry.process_id !== filter.process_id) return false;
  if (filter.run_id && entry.run_id !== filter.run_id) return false;
  if (filter.trace_id && entry.trace_id !== filter.trace_id) return false;
  if (filter.span_id && entry.span_id !== filter.span_id) return false;
  if (filter.session_id && entry.session_id !== filter.session_id) return false;
  if (filter.release_id && entry.release_id !== filter.release_id) return false;
  if (filter.environment && entry.environment !== filter.environment)
    return false;
  return true;
}

function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
