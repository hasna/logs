import type { EventBatchResult, EventCatalogEntry, HttpRequestCaptureOptions, LogEntry, LogLevel, LogQuery, LogRow, LogSummary, Page, PerformanceSnapshot, Project, ScanJob, StructuredLogFormat, StructuredLogIngestResult, UniversalEvent, UniversalLogsController, UniversalLogsOptions } from "./types.js"

export type { EventBatchResult, EventCatalogEntry, HttpRequestCaptureOptions, LogEntry, LogLevel, LogQuery, LogRow, LogSummary, Page, PerformanceSnapshot, Project, ScanJob, StructuredLogFormat, StructuredLogIngestResult, UniversalEvent, UniversalLogsController, UniversalLogsOptions }

interface BrowserEventPayload {
  message?: string
  error?: { stack?: string }
  reason?: { message?: string; stack?: string } | string
}

interface BrowserGlobal {
  window?: {
    addEventListener(type: string, listener: (event: BrowserEventPayload) => void): void
    removeEventListener?(type: string, listener: (event: BrowserEventPayload) => void): void
  }
  location?: { href: string }
  history?: BrowserHistoryLike
  localStorage?: BrowserStorageLike
  performance?: BrowserPerformanceLike
  PerformanceObserver?: BrowserPerformanceObserverConstructor
}

interface BrowserStorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

interface BrowserHistoryLike {
  pushState?(state: unknown, title: string, url?: string | URL | null): void
  replaceState?(state: unknown, title: string, url?: string | URL | null): void
}

interface BrowserPerformanceLike {
  getEntriesByType?(type: string): BrowserPerformanceEntryLike[]
}

interface BrowserPerformanceEntryLike {
  name?: string
  entryType?: string
  initiatorType?: string
  startTime?: number
  duration?: number
  transferSize?: number
  encodedBodySize?: number
  decodedBodySize?: number
  responseStatus?: number
  value?: number
  hadRecentInput?: boolean
  processingStart?: number
  interactionId?: number
  renderTime?: number
  loadTime?: number
}

interface BrowserPerformanceObserverConstructor {
  new (callback: (list: BrowserPerformanceObserverListLike) => void): BrowserPerformanceObserverLike
}

interface BrowserPerformanceObserverListLike {
  getEntries(): BrowserPerformanceEntryLike[]
}

interface BrowserPerformanceObserverLike {
  observe(options: { type?: string; entryTypes?: string[]; buffered?: boolean; durationThreshold?: number }): void
  disconnect(): void
}

interface ProcessLike {
  pid?: number
  ppid?: number
  argv?: string[]
  execPath?: string
  version?: string
  versions?: Record<string, string | undefined>
  env?: Record<string, string | undefined>
  cwd?: () => string
  getBuiltinModule?: (name: string) => unknown
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown
  off?: (event: string, listener: (...args: unknown[]) => void) => unknown
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown
}

interface RuntimeGlobal {
  Bun?: unknown
  window?: unknown
  location?: { href: string }
  history?: BrowserHistoryLike
  performance?: BrowserPerformanceLike
  PerformanceObserver?: BrowserPerformanceObserverConstructor
  process?: ProcessLike
  fetch?: typeof fetch
}

export type FetchRequestHandler<TArgs extends unknown[] = unknown[]> = (
  request: Request,
  ...args: TArgs
) => Response | Promise<Response>

export interface HonoTelemetryContextLike {
  req: {
    raw: Request
    routePath?: string
    path?: string
  }
  res?: Response
}

export type HonoTelemetryNext = () => void | Promise<void>

export interface NodeHttpRequestLike {
  method?: string
  url?: string
  originalUrl?: string
  path?: string
  baseUrl?: string
  protocol?: string
  hostname?: string
  headers?: Headers | Record<string, string | string[] | number | undefined>
  header?: (name: string) => string | string[] | number | undefined
  get?: (name: string) => string | string[] | number | undefined
  route?: string | { path?: string | RegExp | Array<string | RegExp> }
  routerPath?: string
  routeOptions?: { url?: string }
  on?: (event: string | symbol, listener: (...args: unknown[]) => void) => unknown
  once?: (event: string | symbol, listener: (...args: unknown[]) => void) => unknown
  off?: (event: string | symbol, listener: (...args: unknown[]) => void) => unknown
  removeListener?: (event: string | symbol, listener: (...args: unknown[]) => void) => unknown
  raw?: NodeHttpRequestLike
}

export interface NodeHttpResponseLike {
  statusCode?: number
  status?: number
  headers?: Headers | Record<string, string | string[] | number | undefined>
  getHeader?: (name: string) => string | string[] | number | undefined
  on?: (event: string | symbol, listener: (...args: unknown[]) => void) => unknown
  once?: (event: string | symbol, listener: (...args: unknown[]) => void) => unknown
  off?: (event: string | symbol, listener: (...args: unknown[]) => void) => unknown
  removeListener?: (event: string | symbol, listener: (...args: unknown[]) => void) => unknown
  raw?: NodeHttpResponseLike
}

export interface NodeHttpRequestCaptureOptions extends Omit<HttpRequestCaptureOptions, "route"> {
  route?: string | ((request: NodeHttpRequestLike) => string | undefined)
}

export interface NodeHttpCaptureController extends UniversalLogsController {
  finish(error?: unknown): void
}

export type ExpressTelemetryNext = (error?: unknown) => void

export type ExpressTelemetryErrorNext = (error?: unknown) => void

export interface FastifyTelemetryRequestLike extends NodeHttpRequestLike {
  raw?: NodeHttpRequestLike
  routeOptions?: { url?: string }
}

export interface FastifyTelemetryReplyLike extends NodeHttpResponseLike {
  raw?: NodeHttpResponseLike
}

export interface FastifyTelemetryHooks {
  onRequest(request: FastifyTelemetryRequestLike, reply: FastifyTelemetryReplyLike, done?: (error?: unknown) => void): void
  onResponse(request: FastifyTelemetryRequestLike, reply: FastifyTelemetryReplyLike, done?: (error?: unknown) => void): void
  onError(request: FastifyTelemetryRequestLike, reply: FastifyTelemetryReplyLike, error: unknown, done?: (error?: unknown) => void): void
}

type EventWriter = NonNullable<HttpRequestCaptureOptions["client"]>

const expressCaptureSymbol = Symbol.for("@hasna/logs.express.capture")

export interface LogsClientOptions {
  url?: string
  projectId?: string
  apiKey?: string
  browserToken?: string
  source?: string
  environment?: string
  releaseId?: string
  appId?: string
  machineId?: string
  repoId?: string
  processId?: string
  runId?: string
  sessionId?: string
}

export interface StructuredLogSendOptions {
  format?: StructuredLogFormat
  source?: string
  service?: string
  projectId?: string
  pageId?: string
  machineId?: string
  repoId?: string
  appId?: string
  processId?: string
  runId?: string
  traceId?: string
  spanId?: string
  parentSpanId?: string
  sessionId?: string
  releaseId?: string
  environment?: string
  agent?: string
  logUrl?: string
  metadata?: Record<string, unknown>
  sourceEventPrefix?: string
}

export interface StructuredLoggerTransportOptions extends LogsClientOptions, StructuredLogSendOptions {
  flushIntervalMs?: number
  maxBatchSize?: number
  maxQueueSize?: number
  maxRetries?: number
  retryBaseDelayMs?: number
  retryMaxDelayMs?: number
  spoolDirectory?: string
  spoolFile?: string
  waitForTelemetry?: boolean
  level?: string
  onError?: (error: unknown) => void
  onRetry?: (event: StructuredLoggerTransportRetry) => void
  onDrop?: (event: StructuredLoggerTransportDrop) => void
}

export interface StructuredLoggerTransportRetry {
  error: unknown
  attempts: number
  pending: number
  next_delay_ms: number
}

export interface StructuredLoggerTransportDrop {
  reason: "queue_full" | "retries_exhausted"
  record: unknown
  attempts: number
  error?: unknown
}

export interface StructuredLoggerTransportStats {
  pending: number
  in_flight: boolean
  enqueued: number
  sent: number
  dropped: number
  retries: number
  failed_batches: number
  max_queue_size: number
  spool_enabled: boolean
  spool_pending: number
  spool_loaded: number
  spool_dropped: number
  spool_errors: number
}

export interface PinoOpenLogsTransport {
  write(chunk: string | Uint8Array, encoding?: string | ((error?: Error) => void), callback?: (error?: Error) => void): boolean
  end(chunk?: string | Uint8Array | (() => void), encoding?: string | (() => void), callback?: () => void): void
  flush(): Promise<void>
  stats(): StructuredLoggerTransportStats
  stop(): void
}

export interface WinstonOpenLogsTransport {
  name: string
  level?: string
  silent?: boolean
  writable: boolean
  _writableState: { objectMode: boolean }
  pipe<T = unknown>(destination?: T): T | WinstonOpenLogsTransport
  write(info: Record<string, unknown>, encoding?: unknown, callback?: unknown): boolean
  end(info?: Record<string, unknown> | (() => void), encoding?: unknown, callback?: unknown): void
  log(info: Record<string, unknown> | string, callback?: unknown, ...legacyArgs: unknown[]): void
  flush(): Promise<void>
  stats(): StructuredLoggerTransportStats
  close(): void
  stop(): void
  on(event: string, listener: (...args: unknown[]) => void): WinstonOpenLogsTransport
  once(event: string, listener: (...args: unknown[]) => void): WinstonOpenLogsTransport
  off(event: string, listener: (...args: unknown[]) => void): WinstonOpenLogsTransport
  removeListener(event: string, listener: (...args: unknown[]) => void): WinstonOpenLogsTransport
  emit(event: string, ...args: unknown[]): boolean
}

const DEFAULT_URL = "http://localhost:3460"

export class LogsClient {
  private url: string
  private projectId?: string
  private source: string
  private environment?: string
  private releaseId?: string
  private appId?: string
  private machineId?: string
  private repoId?: string
  private processId?: string
  private runId?: string
  private sessionId?: string
  private headers: Record<string, string>
  private writeHeaders: Record<string, string>
  private hasBrowserToken: boolean

  constructor(opts: LogsClientOptions = {}) {
    this.url = (opts.url ?? DEFAULT_URL).replace(/\/$/, "")
    this.projectId = opts.projectId
    this.source = opts.source ?? "sdk"
    this.environment = opts.environment
    this.releaseId = opts.releaseId
    this.appId = opts.appId
    this.machineId = opts.machineId
    this.repoId = opts.repoId
    this.processId = opts.processId
    this.runId = opts.runId
    this.sessionId = opts.sessionId
    this.hasBrowserToken = Boolean(opts.browserToken)
    this.headers = { "Content-Type": "application/json" }
    if (opts.apiKey) this.headers["Authorization"] = `Bearer ${opts.apiKey}`
    this.writeHeaders = { ...this.headers }
    if (opts.browserToken) this.writeHeaders["X-Logs-Browser-Token"] = opts.browserToken
  }

  async push(entry: LogEntry): Promise<LogRow> {
    const res = await fetch(`${this.url}/api/logs`, {
      method: "POST",
      headers: this.writeHeaders,
      body: JSON.stringify({ project_id: this.projectId, ...entry }),
    })
    return readJson<LogRow>(res)
  }

  async pushBatch(entries: LogEntry[]): Promise<{ inserted: number }> {
    const res = await fetch(`${this.url}/api/logs`, {
      method: "POST",
      headers: this.writeHeaders,
      body: JSON.stringify(entries.map(e => ({ project_id: this.projectId, ...e }))),
    })
    return readJson<{ inserted: number }>(res)
  }

  async pushEvent(event: UniversalEvent): Promise<EventCatalogEntry> {
    const res = await fetch(`${this.url}/api/events`, {
      method: "POST",
      headers: this.writeHeaders,
      body: JSON.stringify(this.withDefaultEventContext(event)),
    })
    return readJson<EventCatalogEntry>(res)
  }

  async pushEvents(events: UniversalEvent[]): Promise<EventBatchResult> {
    const res = await fetch(`${this.url}/api/events`, {
      method: "POST",
      headers: this.writeHeaders,
      body: JSON.stringify(events.map(event => this.withDefaultEventContext(event))),
    })
    return readJson<EventBatchResult>(res)
  }

  async pushStructuredLog(record: unknown, opts: StructuredLogSendOptions = {}): Promise<StructuredLogIngestResult> {
    const url = `${this.url}/api/logs/structured${structuredLogQuery(this.withDefaultStructuredLogContext(opts))}`
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(record),
    })
    return readJson<StructuredLogIngestResult>(res)
  }

  async pushStructuredLogs(records: unknown[], opts: StructuredLogSendOptions = {}): Promise<StructuredLogIngestResult> {
    if (records.length === 0) return { inserted: 0, events: [] }
    const context = this.withDefaultStructuredLogContext(opts)
    const url = `${this.url}/api/logs/structured${structuredLogQuery(context)}`
    const body = structuredLogBatchBody(records, context)
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    })
    return readJson<StructuredLogIngestResult>(res)
  }

  async captureException(error: unknown, opts: {
    handled?: boolean
    mechanism?: string
    severity?: LogLevel
    message?: string
    trace_id?: string
    span_id?: string
    parent_span_id?: string
    attributes?: Record<string, unknown>
    body?: Record<string, unknown>
  } = {}): Promise<EventCatalogEntry> {
    const normalized = normalizeError(error)
    return this.pushEvent({
      type: "exception",
      severity: opts.severity ?? "error",
      message: opts.message ?? normalized.message,
      trace_id: opts.trace_id,
      span_id: opts.span_id,
      parent_span_id: opts.parent_span_id,
      body: {
        exception: {
          type: normalized.type,
          value: normalized.message,
          stack_trace: normalized.stack,
          handled: opts.handled ?? false,
          mechanism: opts.mechanism ?? "sdk.captureException",
        },
        ...opts.body,
      },
      attributes: {
        exception_type: normalized.type,
        stack_trace: normalized.stack,
        handled: opts.handled ?? false,
        mechanism: opts.mechanism ?? "sdk.captureException",
        ...opts.attributes,
      },
    })
  }

  async captureMetric(name: string, value: number, opts: {
    kind?: "counter" | "gauge" | "distribution" | "histogram" | "timing"
    unit?: string
    trace_id?: string
    span_id?: string
    attributes?: Record<string, unknown>
  } = {}): Promise<EventCatalogEntry> {
    return this.pushEvent({
      type: "metric",
      severity: "info",
      message: name,
      trace_id: opts.trace_id,
      span_id: opts.span_id,
      body: {
        name,
        value,
        kind: opts.kind ?? "gauge",
        unit: opts.unit,
      },
      attributes: {
        name,
        value,
        metric_kind: opts.kind ?? "gauge",
        unit: opts.unit,
        ...opts.attributes,
      },
    })
  }

  async captureSpan(span: {
    name: string
    operation?: string
    status?: string
    started_at?: string
    ended_at?: string
    duration_ms?: number
    trace_id?: string
    span_id?: string
    parent_span_id?: string
    attributes?: Record<string, unknown>
  }): Promise<EventCatalogEntry> {
    return this.pushEvent({
      type: "span",
      severity: span.status === "error" ? "error" : "info",
      message: span.name,
      trace_id: span.trace_id,
      span_id: span.span_id,
      parent_span_id: span.parent_span_id,
      body: {
        name: span.name,
        operation: span.operation,
        status: span.status,
        duration_ms: span.duration_ms,
      },
      attributes: {
        name: span.name,
        operation: span.operation,
        status: span.status,
        started_at: span.started_at,
        ended_at: span.ended_at,
        duration_ms: span.duration_ms,
        ...span.attributes,
      },
    })
  }

  async search(query: LogQuery = {}): Promise<LogRow[]> {
    const params = new URLSearchParams()
    if (query.project_id ?? this.projectId) params.set("project_id", query.project_id ?? this.projectId!)
    if (query.page_id) params.set("page_id", query.page_id)
    if (query.level) params.set("level", Array.isArray(query.level) ? query.level.join(",") : query.level)
    if (query.service) params.set("service", query.service)
    if (query.since) params.set("since", query.since)
    if (query.until) params.set("until", query.until)
    if (query.text) params.set("text", query.text)
    if (query.limit) params.set("limit", String(query.limit))
    if (query.offset) params.set("offset", String(query.offset))
    if (query.fields) params.set("fields", query.fields.join(","))
    const res = await fetch(`${this.url}/api/logs?${params}`, { headers: this.headers })
    return readJson<LogRow[]>(res)
  }

  async tail(projectId?: string, n = 50): Promise<LogRow[]> {
    const params = new URLSearchParams({ n: String(n) })
    const pid = projectId ?? this.projectId
    if (pid) params.set("project_id", pid)
    const res = await fetch(`${this.url}/api/logs/tail?${params}`, { headers: this.headers })
    return readJson<LogRow[]>(res)
  }

  async summary(projectId?: string, since?: string): Promise<LogSummary[]> {
    const params = new URLSearchParams()
    const pid = projectId ?? this.projectId
    if (pid) params.set("project_id", pid)
    if (since) params.set("since", since)
    const res = await fetch(`${this.url}/api/logs/summary?${params}`, { headers: this.headers })
    return readJson<LogSummary[]>(res)
  }

  async context(traceId: string): Promise<LogRow[]> {
    const res = await fetch(`${this.url}/api/logs/${traceId}/context`, { headers: this.headers })
    return readJson<LogRow[]>(res)
  }

  async registerProject(name: string, githubRepo?: string, baseUrl?: string): Promise<Project> {
    const res = await fetch(`${this.url}/api/projects`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ name, github_repo: githubRepo, base_url: baseUrl }),
    })
    return readJson<Project>(res)
  }

  async registerPage(projectId: string, url: string, path?: string, name?: string): Promise<Page> {
    const res = await fetch(`${this.url}/api/projects/${projectId}/pages`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ url, path, name }),
    })
    return readJson<Page>(res)
  }

  async createScanJob(projectId: string, schedule: string, pageId?: string): Promise<ScanJob> {
    const res = await fetch(`${this.url}/api/jobs`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ project_id: projectId, schedule, page_id: pageId }),
    })
    return readJson<ScanJob>(res)
  }

  async perfSnapshot(projectId: string, pageId?: string): Promise<PerformanceSnapshot | null> {
    const params = new URLSearchParams({ project_id: projectId })
    if (pageId) params.set("page_id", pageId)
    const res = await fetch(`${this.url}/api/perf?${params}`, { headers: this.headers })
    return readJson<PerformanceSnapshot | null>(res)
  }

  async perfTrend(projectId: string, pageId?: string, since?: string, limit?: number): Promise<PerformanceSnapshot[]> {
    const params = new URLSearchParams({ project_id: projectId })
    if (pageId) params.set("page_id", pageId)
    if (since) params.set("since", since)
    if (limit) params.set("limit", String(limit))
    const res = await fetch(`${this.url}/api/perf/trend?${params}`, { headers: this.headers })
    return readJson<PerformanceSnapshot[]>(res)
  }

  private withDefaultEventContext(event: UniversalEvent): UniversalEvent {
    const identityContext = this.hasBrowserToken
      ? {}
      : {
        project_id: this.projectId,
        machine_id: this.machineId,
        repo_id: this.repoId,
        process_id: this.processId,
        run_id: this.runId,
      }
    const withContext = {
      source: this.source,
      environment: this.environment,
      release_id: this.releaseId,
      app_id: this.appId,
      session_id: this.sessionId,
      ...identityContext,
      ...event,
      attributes: {
        sdk_name: "@hasna/logs-sdk",
        sdk_runtime: runtimeName(),
        ...(event.attributes ?? {}),
      },
    }
    return this.hasBrowserToken ? stripBrowserUniversalEventIdentity(withContext) : withContext
  }

  private withDefaultStructuredLogContext(opts: StructuredLogSendOptions): StructuredLogSendOptions {
    return {
      projectId: this.projectId,
      environment: this.environment,
      releaseId: this.releaseId,
      appId: this.appId,
      machineId: this.machineId,
      repoId: this.repoId,
      processId: this.processId,
      runId: this.runId,
      sessionId: this.sessionId,
      ...opts,
    }
  }
}

export function createPinoOpenLogsTransport(opts: StructuredLoggerTransportOptions = {}): PinoOpenLogsTransport {
  const queue = createStructuredLogQueue({ ...opts, format: opts.format ?? "pino" })
  const decoder = new TextDecoder()
  let pending = ""
  let stopped = false

  const parseLine = (line: string): Error | undefined => {
    const trimmed = line.trim()
    if (!trimmed) return undefined
    try {
      queue.enqueue(JSON.parse(trimmed) as unknown)
      return undefined
    } catch (error) {
      const normalized = toError(error)
      opts.onError?.(normalized)
      return normalized
    }
  }

  const drain = (text: string): Error | undefined => {
    pending += text
    while (true) {
      const newline = pending.indexOf("\n")
      if (newline < 0) return undefined
      const line = pending.slice(0, newline).replace(/\r$/, "")
      pending = pending.slice(newline + 1)
      const error = parseLine(line)
      if (error) return error
    }
  }

  const transport: PinoOpenLogsTransport = {
    write(chunk, encoding, callback) {
      if (stopped) {
        const error = new Error("open-logs Pino transport is stopped")
        callbackFromArgs(encoding, callback)?.(error)
        return false
      }
      const done = callbackFromArgs(encoding, callback)
      const error = drain(chunkText(chunk, decoder))
      if (error) {
        done?.(error)
        return false
      }
      if (opts.waitForTelemetry && queue.shouldFlush()) {
        void queue.flush().then(() => done?.(), err => done?.(toError(err)))
      } else {
        if (queue.shouldFlush()) void queue.flush().catch(opts.onError ?? noop)
        done?.()
      }
      return true
    },
    end(chunk, encoding, callback) {
      let done: (() => void) | undefined
      if (typeof chunk === "function") {
        done = chunk
      } else if (typeof encoding === "function") {
        done = encoding
      } else {
        done = callback
      }
      if (chunk !== undefined && typeof chunk !== "function") {
        const error = drain(chunkText(chunk, decoder))
        if (error) opts.onError?.(error)
      }
      const tail = decoder.decode()
      if (tail) pending += tail
      if (pending.trim()) {
        const error = parseLine(pending)
        if (error) opts.onError?.(error)
      }
      pending = ""
      stopped = true
      void queue.flush().catch(opts.onError ?? noop).finally(() => {
        queue.stop()
        done?.()
      })
    },
    flush: queue.flush,
    stats: queue.stats,
    stop() {
      stopped = true
      void queue.flush().catch(opts.onError ?? noop).finally(() => {
        queue.stop()
      })
    },
  }
  return transport
}

export function createWinstonOpenLogsTransport(opts: StructuredLoggerTransportOptions = {}): WinstonOpenLogsTransport {
  const queue = createStructuredLogQueue({ ...opts, format: opts.format ?? "winston" })
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  let closed = false

  const finish = () => {
    if (closed) return
    closed = true
    queue.stop()
    transport.writable = false
    transport.emit("finish")
    transport.emit("close")
  }

  const reportError = (error: unknown) => {
    opts.onError?.(error)
    transport.emit("error", error)
  }

  const transport: WinstonOpenLogsTransport = {
    name: "open-logs",
    level: opts.level,
    silent: false,
    writable: true,
    _writableState: { objectMode: true },
    pipe(destination) {
      return destination ?? transport
    },
    write(info, encoding, callback) {
      const done = callbackFromUnknownArgs(encoding, callback)
      transport.log(info, done)
      return transport.writable
    },
    end(info, encoding, callback) {
      const done = callbackFromUnknownArgs(encoding, callback) ?? (typeof info === "function" ? info : undefined)
      if (info && typeof info === "object") transport.write(info)
      void queue.flush().catch(reportError).finally(() => {
        finish()
        done?.()
      })
    },
    log(info, callback, ...legacyArgs) {
      const normalized = normalizeWinstonLogArguments(info, callback, legacyArgs)
      const done = normalized.callback
      if (transport.silent) {
        done?.()
        return
      }
      queue.enqueue(normalized.info)
      queueMicrotask(() => transport.emit("logged", normalized.info))
      if (opts.waitForTelemetry && queue.shouldFlush()) {
        void queue.flush().then(() => done?.(), error => {
          reportError(error)
          done?.()
        })
      } else {
        if (queue.shouldFlush()) void queue.flush().catch(error => {
          reportError(error)
        })
        done?.()
      }
    },
    flush: queue.flush,
    stats: queue.stats,
    close() {
      void queue.flush().catch(reportError).finally(finish)
    },
    stop() {
      transport.close()
    },
    on(event, listener) {
      let eventListeners = listeners.get(event)
      if (!eventListeners) {
        eventListeners = new Set()
        listeners.set(event, eventListeners)
      }
      eventListeners.add(listener)
      return transport
    },
    once(event, listener) {
      const onceListener = (...args: unknown[]) => {
        transport.removeListener(event, onceListener)
        listener(...args)
      }
      return transport.on(event, onceListener)
    },
    off(event, listener) {
      return transport.removeListener(event, listener)
    },
    removeListener(event, listener) {
      listeners.get(event)?.delete(listener)
      return transport
    },
    emit(event, ...args) {
      const eventListeners = listeners.get(event)
      if (!eventListeners?.size) return false
      for (const listener of [...eventListeners]) listener(...args)
      return true
    },
  }
  return transport
}

export async function captureHttpRequest<T>(
  request: Request,
  run: () => T | Promise<T>,
  opts: HttpRequestCaptureOptions,
): Promise<T> {
  const source = opts.source ?? opts.framework ?? runtimeName()
  const client: EventWriter = opts.client ?? new LogsClient({ ...opts, source })
  const startedAt = Date.now()
  const startedIso = new Date(startedAt).toISOString()
  const { traceId, parentSpanId } = traceContextFromRequest(request)
  const spanId = randomHex(16)
  const method = request.method || "GET"
  const url = safeUrlParts(request.url)
  const operation = opts.operation ?? "http.server"

  try {
    const result = await run()
    const response = responseLike(result)
    const durationMs = Date.now() - startedAt
    const statusCode = response?.status
    const route = routeForRequest(request, opts.route)
    const name = `${method} ${route}`
    const event = httpServerSpanEvent({
      source,
      request,
      response,
      traceId,
      spanId,
      parentSpanId,
      method,
      route,
      url,
      operation,
      name,
      statusCode,
      durationMs,
      startedIso,
      requestHeaderNames: opts.requestHeaderNames,
      responseHeaderNames: opts.responseHeaderNames,
      framework: opts.framework,
    })
    await sendRequestTelemetry(client, [event], opts.waitForTelemetry)
    return result
  } catch (error) {
    const durationMs = Date.now() - startedAt
    const normalized = normalizeError(error)
    const route = routeForRequest(request, opts.route)
    const name = `${method} ${route}`
    const span = httpServerSpanEvent({
      source,
      request,
      traceId,
      spanId,
      parentSpanId,
      method,
      route,
      url,
      operation,
      name,
      statusCode: 500,
      durationMs,
      startedIso,
      requestHeaderNames: opts.requestHeaderNames,
      framework: opts.framework,
      errorType: normalized.type,
    })
    const exception: UniversalEvent = {
      type: "exception",
      source,
      severity: "error",
      trace_id: traceId,
      span_id: spanId,
      parent_span_id: parentSpanId,
      message: normalized.message,
      body: {
        exception: {
          type: normalized.type,
          value: normalized.message,
          stack_trace: normalized.stack,
          handled: false,
          mechanism: `${opts.framework ?? "fetch"}.request`,
        },
      },
      attributes: {
        exception_type: normalized.type,
        stack_trace: normalized.stack,
        handled: false,
        mechanism: `${opts.framework ?? "fetch"}.request`,
        operation,
        method,
        route,
        url_scheme: url.scheme,
        url_host: url.host,
        url_path: url.path,
        query_present: url.queryPresent,
        framework: opts.framework,
        duration_ms: durationMs,
      },
    }
    await sendRequestTelemetry(client, [span, exception], opts.waitForTelemetry)
    throw error
  }
}

export function instrumentFetchHandler<TArgs extends unknown[]>(
  handler: FetchRequestHandler<TArgs>,
  opts: HttpRequestCaptureOptions,
): FetchRequestHandler<TArgs> {
  return (request: Request, ...args: TArgs) => captureHttpRequest(request, () => handler(request, ...args), opts)
}

export function createHonoTelemetryMiddleware(opts: HttpRequestCaptureOptions): (c: HonoTelemetryContextLike, next: HonoTelemetryNext) => Promise<void> {
  return async (c, next) => {
    const route = opts.route ?? (() => c.req.routePath ?? c.req.path)
    await captureHttpRequest(c.req.raw, async () => {
      await next()
      return c.res ?? new Response(null, { status: 204 })
    }, { ...opts, route, framework: opts.framework ?? "hono" })
  }
}

export function captureNodeHttpRequest(
  request: NodeHttpRequestLike,
  response: NodeHttpResponseLike,
  opts: NodeHttpRequestCaptureOptions,
): NodeHttpCaptureController {
  const startedAt = Date.now()
  const startedIso = new Date(startedAt).toISOString()
  let pending: Promise<void> | undefined
  let completed = false
  let stopped = false
  const errorMonitor = nodeErrorMonitorEvent()
  const listenerCleanups: Array<() => void> = []

  const finish = (error?: unknown) => {
    if (completed || stopped) return
    completed = true
    cleanupNodeListeners(listenerCleanups)
    pending = emitNodeHttpRequestTelemetry({
      request,
      response,
      opts,
      startedAt,
      startedIso,
      error,
    }).catch(() => {})
  }

  const onFinish = () => finish()
  const onClose = () => {
    if (!completed) finish(new ResponseClosedError())
  }
  const onResponseError = (error: unknown) => finish(error)
  const onRequestError = (error: unknown) => finish(error)
  const onRequestAborted = () => finish(new ResponseClosedError())

  listenerCleanups.push(addNodeListener(response, "finish", onFinish))
  listenerCleanups.push(addNodeListener(response, "close", onClose))
  if (errorMonitor) listenerCleanups.push(addNodeListener(response, errorMonitor, onResponseError))
  if (errorMonitor) listenerCleanups.push(addNodeListener(request, errorMonitor, onRequestError))
  listenerCleanups.push(addNodeListener(request, "aborted", onRequestAborted))

  return {
    finish,
    async flush() {
      await pending
    },
    stop() {
      stopped = true
      cleanupNodeListeners(listenerCleanups)
    },
  }
}

export function createExpressTelemetryMiddleware(
  opts: NodeHttpRequestCaptureOptions,
): (request: NodeHttpRequestLike, response: NodeHttpResponseLike, next: ExpressTelemetryNext) => void {
  return (request, response, next) => {
    const capture = captureNodeHttpRequest(request, response, { ...opts, framework: opts.framework ?? "express" })
    setExpressCapture(request, capture)
    try {
      next()
    } catch (error) {
      capture.finish(error)
      clearExpressCapture(request)
      throw error
    }
  }
}

export function createExpressErrorTelemetryMiddleware(
  opts: NodeHttpRequestCaptureOptions,
): (error: unknown, request: NodeHttpRequestLike, response: NodeHttpResponseLike, next: ExpressTelemetryErrorNext) => void {
  return (error, request, response, next) => {
    const capture = getExpressCapture(request)
      ?? captureNodeHttpRequest(request, response, { ...opts, framework: opts.framework ?? "express" })
    capture.finish(error)
    clearExpressCapture(request)
    next(error)
  }
}

export function createFastifyTelemetryHooks(opts: NodeHttpRequestCaptureOptions): FastifyTelemetryHooks {
  const captures = new WeakMap<object, NodeHttpCaptureController>()

  const onRequest = (request: FastifyTelemetryRequestLike, reply: FastifyTelemetryReplyLike, done?: (error?: unknown) => void) => {
    captures.set(request, captureNodeHttpRequest(
      fastifyRequestLike(request),
      fastifyResponseLike(reply),
      { ...opts, framework: opts.framework ?? "fastify", route: opts.route ?? fastifyRoute },
    ))
    done?.()
  }

  const onResponse = (request: FastifyTelemetryRequestLike, _reply: FastifyTelemetryReplyLike, done?: (error?: unknown) => void) => {
    const capture = captures.get(request)
    captures.delete(request)
    capture?.finish()
    done?.()
  }

  const onError = (request: FastifyTelemetryRequestLike, _reply: FastifyTelemetryReplyLike, error: unknown, done?: (error?: unknown) => void) => {
    const capture = captures.get(request)
    captures.delete(request)
    capture?.finish(error)
    done?.()
  }

  return { onRequest, onResponse, onError }
}

// Browser auto-capture init
export function initLogs(opts: { projectId: string; url?: string; browserToken?: string; apiKey?: string }): void {
  const browser = globalThis as unknown as BrowserGlobal
  if (!browser.window || !browser.location) return
  const serverUrl = (opts.url ?? DEFAULT_URL).replace(/\/$/, "")
  const client = new LogsClient({ url: serverUrl, projectId: opts.projectId, browserToken: opts.browserToken, apiKey: opts.apiKey })
  const q: LogEntry[] = []
  const flush = () => { if (q.length) client.pushBatch(q.splice(0)).catch(() => {}) }
  const currentHref = () => browser.location?.href ?? ""
  setInterval(flush, 2000)

  const _ce = console.error.bind(console)
  console.error = (...args: unknown[]) => { _ce(...args); q.push({ level: "error", message: args.map(String).join(" "), source: "script", url: currentHref() }) }

  const _cw = console.warn.bind(console)
  console.warn = (...args: unknown[]) => { _cw(...args); q.push({ level: "warn", message: args.map(String).join(" "), source: "script", url: currentHref() }) }

  browser.window.addEventListener("error", (e) => { q.push({ level: "error", message: e.message ?? "Browser error", stack_trace: e.error?.stack, source: "script", url: currentHref() }) })
  browser.window.addEventListener("unhandledrejection", (e) => {
    const reason = typeof e.reason === "string" ? { message: e.reason } : e.reason
    q.push({ level: "error", message: `Unhandled: ${reason?.message ?? "promise rejection"}`, stack_trace: reason?.stack, source: "script", url: currentHref() })
  })
  browser.window.addEventListener("beforeunload", flush)
}

export function initUniversalLogs(opts: UniversalLogsOptions): UniversalLogsController | void {
  const browser = globalThis as unknown as BrowserGlobal
  if (browser.window && browser.location) return initBrowserUniversalLogs(opts)
  return initNodeLogs(opts)
}

export function initNodeLogs(opts: UniversalLogsOptions): UniversalLogsController | void {
  const runtime = globalThis as RuntimeGlobal
  const processLike = runtime.process
  if (!processLike || !runtime.fetch) return

  const source = opts.source ?? runtimeName()
  const processId = opts.processId ?? defaultProcessId(processLike)
  const client = new LogsClient({ ...opts, source, processId })
  const q: UniversalEvent[] = []
  const maxBatchSize = opts.maxBatchSize ?? 20
  const collectorUrl = (opts.url ?? DEFAULT_URL).replace(/\/$/, "")
  let stopped = false

  const enqueue = (event: UniversalEvent) => {
    if (stopped) return
    q.push({
      event_time: new Date().toISOString(),
      source,
      process_id: processId,
      ...event,
      attributes: {
        pid: processLike.pid,
        runtime: runtimeName(),
        ...(event.attributes ?? {}),
      },
    })
    if (q.length >= maxBatchSize) void flush()
  }

  const flush = async () => {
    if (!q.length) return
    const batch = q.splice(0)
    await client.pushEvents(batch).catch(() => {})
  }

  const interval = setInterval(() => { void flush() }, opts.flushIntervalMs ?? 2000)
  const restores: Array<() => void> = [() => clearInterval(interval)]
  const removeProcessListener = (event: string, listener: (...args: unknown[]) => void) => {
    if (typeof processLike.off === "function") processLike.off(event, listener)
    else if (typeof processLike.removeListener === "function") processLike.removeListener(event, listener)
  }

  if (opts.captureProcess !== false) {
    enqueue({
      type: "process",
      severity: "info",
      source_event_id: `${processId}:start`,
      message: "Process started",
      attributes: {
        phase: "start",
        argv: processLike.argv,
        cwd: safeCall(processLike.cwd),
        exec_path: processLike.execPath,
        node_version: processLike.versions?.node ?? processLike.version,
        bun_version: processLike.versions?.bun,
      },
    })

    const beforeExit = (code: unknown) => {
      enqueue({
        type: "process",
        severity: code === 0 ? "info" : "error",
        source_event_id: `${processId}:beforeExit:${String(code)}`,
        message: `Process beforeExit ${String(code)}`,
        attributes: { phase: "beforeExit", exit_code: code },
      })
      void flush()
    }
    processLike.on?.("beforeExit", beforeExit)
    restores.push(() => removeProcessListener("beforeExit", beforeExit))
  }

  if (opts.captureConsole !== false) {
    const consoleRecord = console as unknown as Record<string, (...args: unknown[]) => void>
    const consoleMethods: Array<[string, LogLevel]> = [
      ["debug", "debug"],
      ["log", "info"],
      ["info", "info"],
      ["warn", "warn"],
      ["error", "error"],
    ]
    for (const [method, severity] of consoleMethods) {
      const original = consoleRecord[method]
      if (typeof original !== "function") continue
      const bound = original.bind(console)
      consoleRecord[method] = (...args: unknown[]) => {
        bound(...args)
        enqueue({
          type: "log",
          severity,
          message: formatArgs(args),
          attributes: {
            console_method: method,
          },
        })
      }
      restores.push(() => { consoleRecord[method] = original })
    }
  }

  if (opts.captureExceptions !== false) {
    const uncaughtExceptionMonitor = (error: unknown, origin?: unknown) => {
      const normalized = normalizeError(error)
      enqueue({
        type: "exception",
        severity: "fatal",
        message: normalized.message,
        body: {
          exception: {
            type: normalized.type,
            value: normalized.message,
            stack_trace: normalized.stack,
            handled: false,
            mechanism: "process.uncaughtExceptionMonitor",
          },
        },
        attributes: {
          exception_type: normalized.type,
          stack_trace: normalized.stack,
          handled: false,
          mechanism: "process.uncaughtExceptionMonitor",
          origin,
        },
      })
      void flush()
    }
    processLike.on?.("uncaughtExceptionMonitor", uncaughtExceptionMonitor)
    restores.push(() => removeProcessListener("uncaughtExceptionMonitor", uncaughtExceptionMonitor))
  }

  if (opts.captureRejections === true) {
    const unhandledRejection = (reason: unknown) => {
      const normalized = normalizeError(reason)
      enqueue({
        type: "exception",
        severity: "error",
        message: `Unhandled rejection: ${normalized.message}`,
        body: {
          exception: {
            type: normalized.type,
            value: normalized.message,
            stack_trace: normalized.stack,
            handled: false,
            mechanism: "process.unhandledRejection",
          },
        },
        attributes: {
          exception_type: normalized.type,
          stack_trace: normalized.stack,
          handled: false,
          mechanism: "process.unhandledRejection",
        },
      })
      void flush()
    }
    processLike.on?.("unhandledRejection", unhandledRejection)
    restores.push(() => removeProcessListener("unhandledRejection", unhandledRejection))
  }

  if (opts.captureFetch !== false) {
    const originalFetch = runtime.fetch
    const boundFetch = originalFetch.bind(globalThis)
    runtime.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const requestUrl = requestUrlString(input)
      const method = requestMethod(input, init)
      const collectorRequest = isCollectorRequest(requestUrl, collectorUrl)
      let fetchInput = input
      let fetchInit = init
      const existingTraceparent = traceparentInfoFromFetchInput(input, init)
      let traceContext = existingTraceparent.context
      let traceparentInjected = false
      if (!existingTraceparent.present && !collectorRequest && shouldPropagateTrace(opts, requestUrl)) {
        traceContext = { traceId: randomHex(32), spanId: randomHex(16) }
        const tracedFetch = fetchInputWithTraceparent(
          input,
          init,
          traceparentFromContext(traceContext),
        )
        fetchInput = tracedFetch.input
        fetchInit = tracedFetch.init
        traceparentInjected = true
      }
      const startedAt = Date.now()
      try {
        const response = await boundFetch(fetchInput, fetchInit)
        if (!collectorRequest) {
          enqueue({
            type: "span",
            severity: response.ok ? "info" : "error",
            trace_id: traceContext?.traceId,
            span_id: traceContext?.spanId ?? randomId("span"),
            message: `${method} ${requestUrl}`,
            body: {
              name: `${method} ${requestUrl}`,
              operation: "http.client",
              status: response.ok ? "ok" : "error",
              duration_ms: Date.now() - startedAt,
            },
            attributes: {
              name: `${method} ${requestUrl}`,
              operation: "http.client",
              method,
              url: requestUrl,
              status_code: response.status,
              ok: response.ok,
              duration_ms: Date.now() - startedAt,
              traceparent_propagated: traceparentInjected || undefined,
              traceparent_existing: existingTraceparent.present || undefined,
            },
          })
        }
        return response
      } catch (error) {
        if (!collectorRequest) {
          const normalized = normalizeError(error)
          enqueue({
            type: "network",
            severity: "error",
            trace_id: traceContext?.traceId,
            span_id: traceContext?.spanId ?? randomId("span"),
            message: `${method} ${requestUrl} failed: ${normalized.message}`,
            body: {
              error: {
                type: normalized.type,
                value: normalized.message,
                stack_trace: normalized.stack,
              },
            },
            attributes: {
              operation: "http.client",
              method,
              url: requestUrl,
              duration_ms: Date.now() - startedAt,
              error_type: normalized.type,
              stack_trace: normalized.stack,
              traceparent_propagated: traceparentInjected || undefined,
              traceparent_existing: existingTraceparent.present || undefined,
            },
          })
        }
        throw error
      }
    }) as typeof fetch
    restores.push(() => { runtime.fetch = originalFetch })
  }

  return {
    flush,
    stop() {
      stopped = true
      while (restores.length) restores.pop()?.()
    },
  }
}

function initBrowserUniversalLogs(opts: UniversalLogsOptions): UniversalLogsController | void {
  const browser = globalThis as unknown as BrowserGlobal
  const runtime = globalThis as RuntimeGlobal
  if (!browser.window || !browser.location) return
  const serverUrl = browserRequestUrlString(opts.url ?? DEFAULT_URL, browser.location.href).replace(/\/$/, "")
  const client = new LogsClient({ ...opts, url: serverUrl, source: opts.source ?? "browser" })
  const maxBatchSize = opts.maxBatchSize ?? 10
  const maxQueueSize = Math.max(1, opts.maxQueueSize ?? 1000)
  const spool = createBrowserUniversalSpool(opts)
  const loadedSpool = spool.load()
  const q: Array<{ event: UniversalEvent, spoolEvent: UniversalEvent }> = loadedSpool.events.slice(-maxQueueSize).map((event) => ({
    event,
    spoolEvent: event,
  }))
  let inFlightBatch: Array<{ event: UniversalEvent, spoolEvent: UniversalEvent }> | undefined
  let flushPromise: Promise<void> | undefined
  let stopped = false
  const currentHref = () => browser.location?.href ?? ""
  const allSpoolItems = () => [...(inFlightBatch ?? []), ...q]
  const persistSpool = () => persistBrowserUniversalSpool(spool, allSpoolItems())
  const enforceQueueLimit = () => {
    const inFlightCount = inFlightBatch?.length ?? 0
    while (q.length + inFlightCount > maxQueueSize) q.shift()
  }
  if (loadedSpool.hadStoredRecord) persistSpool()
  const enqueue = (event: UniversalEvent) => {
    if (stopped) return
    const queued = {
      event_time: new Date().toISOString(),
      source: "browser",
      ...event,
      attributes: {
        url: currentHref(),
        ...(event.attributes ?? {}),
      },
    }
    q.push({
      event: queued,
      spoolEvent: redactBrowserUniversalEvent(queued),
    })
    enforceQueueLimit()
    persistSpool()
    if (q.length >= maxBatchSize) void flush()
  }
  const flush = () => {
    if (flushPromise) return flushPromise
    if (!q.length) return Promise.resolve()
    const batch = q.splice(0, maxBatchSize)
    inFlightBatch = batch
    persistSpool()
    flushPromise = (async () => {
      try {
        await client.pushEvents(batch.map((item) => item.event))
      } catch {
        if (inFlightBatch === batch) inFlightBatch = undefined
        q.unshift(...batch.map((item) => ({
          event: item.spoolEvent,
          spoolEvent: item.spoolEvent,
        })))
        enforceQueueLimit()
      } finally {
        if (inFlightBatch === batch) inFlightBatch = undefined
        flushPromise = undefined
        persistSpool()
        if (!stopped && q.length >= maxBatchSize) void flush()
      }
    })()
    return flushPromise
  }
  const interval = setInterval(() => { void flush() }, opts.flushIntervalMs ?? 2000)
  const restores: Array<() => void> = [() => clearInterval(interval)]

  if (opts.captureConsole !== false) {
    const consoleRecord = console as unknown as Record<string, (...args: unknown[]) => void>
    const consoleMethods: Array<[string, LogLevel]> = [
      ["debug", "debug"],
      ["log", "info"],
      ["info", "info"],
      ["warn", "warn"],
      ["error", "error"],
    ]
    for (const [method, severity] of consoleMethods) {
      const original = consoleRecord[method]
      if (typeof original !== "function") continue
      const bound = original.bind(console)
      consoleRecord[method] = (...args: unknown[]) => {
        bound(...args)
        enqueue({
          type: "log",
          severity,
          message: formatArgs(args),
          attributes: {
            console_method: method,
          },
        })
      }
      restores.push(() => { consoleRecord[method] = original })
    }
  }

  if (opts.captureExceptions !== false) {
    const browserErrorListener = (e: BrowserEventPayload) => {
      enqueue({
        type: "exception",
        severity: "error",
        message: e.message ?? "Browser error",
        body: {
          exception: {
            value: e.message ?? "Browser error",
            stack_trace: e.error?.stack,
            handled: false,
            mechanism: "browser.onerror",
          },
        },
        attributes: {
          stack_trace: e.error?.stack,
          mechanism: "browser.onerror",
        },
      })
    }
    browser.window.addEventListener("error", browserErrorListener)
    restores.push(() => { browser.window?.removeEventListener?.("error", browserErrorListener) })
  }
  if (opts.captureRejections !== false) {
    const browserRejectionListener = (e: BrowserEventPayload) => {
      const reason = typeof e.reason === "string" ? { message: e.reason } : e.reason
      enqueue({
        type: "exception",
        severity: "error",
        message: `Unhandled: ${reason?.message ?? "promise rejection"}`,
        body: {
          exception: {
            value: reason?.message ?? "promise rejection",
            stack_trace: reason?.stack,
            handled: false,
            mechanism: "browser.unhandledrejection",
          },
        },
        attributes: {
          stack_trace: reason?.stack,
          mechanism: "browser.unhandledrejection",
        },
      })
    }
    browser.window.addEventListener("unhandledrejection", browserRejectionListener)
    restores.push(() => { browser.window?.removeEventListener?.("unhandledrejection", browserRejectionListener) })
  }
  if (opts.captureNavigation) {
    let lastHref = currentHref()
    const enqueueNavigation = (navigationType: string, fromUrl?: string, toUrl = currentHref()) => {
      enqueue({
        type: "span",
        severity: "info",
        span_id: randomId("span"),
        message: `NAVIGATION ${toUrl}`,
        body: {
          name: `NAVIGATION ${toUrl}`,
          operation: "browser.navigation",
          status: "ok",
        },
        attributes: {
          name: `NAVIGATION ${toUrl}`,
          operation: "browser.navigation",
          navigation_type: navigationType,
          from_url: fromUrl,
          to_url: toUrl,
        },
      })
    }
    enqueueNavigation("page_load", undefined, lastHref)
    const emitRouteChange = (navigationType: string) => {
      const previousHref = lastHref
      const nextHref = currentHref()
      if (nextHref === previousHref) return
      lastHref = nextHref
      enqueueNavigation(navigationType, previousHref, nextHref)
    }
    const popstateListener = () => emitRouteChange("popstate")
    const hashchangeListener = () => emitRouteChange("hashchange")
    browser.window.addEventListener("popstate", popstateListener)
    browser.window.addEventListener("hashchange", hashchangeListener)
    restores.push(() => {
      browser.window?.removeEventListener?.("popstate", popstateListener)
      browser.window?.removeEventListener?.("hashchange", hashchangeListener)
    })
    const originalPushState = browser.history?.pushState
    if (typeof originalPushState === "function") {
      const wrappedPushState = function pushState(this: BrowserHistoryLike, state: unknown, title: string, url?: string | URL | null) {
        originalPushState.call(this, state, title, url)
        emitRouteChange("pushState")
      }
      browser.history!.pushState = wrappedPushState
      restores.push(() => {
        if (browser.history?.pushState === wrappedPushState) browser.history.pushState = originalPushState
      })
    }
    const originalReplaceState = browser.history?.replaceState
    if (typeof originalReplaceState === "function") {
      const wrappedReplaceState = function replaceState(this: BrowserHistoryLike, state: unknown, title: string, url?: string | URL | null) {
        originalReplaceState.call(this, state, title, url)
        emitRouteChange("replaceState")
      }
      browser.history!.replaceState = wrappedReplaceState
      restores.push(() => {
        if (browser.history?.replaceState === wrappedReplaceState) browser.history.replaceState = originalReplaceState
      })
    }
  }
  if (opts.captureResourceTiming) {
    let resourceTimingEvents = 0
    const configuredResourceLimit = opts.maxResourceTimingEvents
    const maxResourceTimingEvents = Number.isFinite(configuredResourceLimit)
      ? Math.max(1, Math.floor(configuredResourceLimit!))
      : 100
    const seenResourceTimings = new Set<string>()
    const enqueueResourceTiming = (entry: BrowserPerformanceEntryLike) => {
      if (resourceTimingEvents >= maxResourceTimingEvents) return
      const resourceUrl = browserPerformanceEntryUrl(entry, currentHref())
      if (!resourceUrl || isCollectorRequest(resourceUrl, serverUrl)) return
      const durationMs = roundedNumber(entry.duration)
      const initiatorType = typeof entry.initiatorType === "string" ? entry.initiatorType : "resource"
      const resourceKey = browserPerformanceEntryKey(entry, resourceUrl, initiatorType)
      if (seenResourceTimings.has(resourceKey)) return
      seenResourceTimings.add(resourceKey)
      resourceTimingEvents += 1
      enqueue({
        type: "span",
        severity: "info",
        span_id: randomId("span"),
        message: `RESOURCE ${resourceUrl}`,
        body: {
          name: `RESOURCE ${resourceUrl}`,
          operation: "browser.resource",
          status: "ok",
          duration_ms: durationMs,
        },
        attributes: {
          name: `RESOURCE ${resourceUrl}`,
          operation: "browser.resource",
          url: resourceUrl,
          initiator_type: initiatorType,
          start_time_ms: roundedNumber(entry.startTime),
          duration_ms: durationMs,
          transfer_size: roundedNumber(entry.transferSize),
          encoded_body_size: roundedNumber(entry.encodedBodySize),
          decoded_body_size: roundedNumber(entry.decodedBodySize),
          response_status: roundedNumber(entry.responseStatus),
        },
      })
    }
    for (const entry of browser.performance?.getEntriesByType?.("resource") ?? []) {
      enqueueResourceTiming(entry)
    }
    if (runtime.PerformanceObserver) {
      try {
        const observer = new runtime.PerformanceObserver((list) => {
          for (const entry of list.getEntries()) enqueueResourceTiming(entry)
        })
        let observing = false
        try {
          observer.observe({ type: "resource", buffered: true })
          observing = true
        } catch {
          try {
            observer.observe({ entryTypes: ["resource"] })
            observing = true
          } catch {
            // Some browser-like runtimes expose PerformanceObserver but not resource entries.
          }
        }
        if (observing) restores.push(() => observer.disconnect())
      } catch {
        // Ignore broken browser-like PerformanceObserver constructors.
      }
    }
  }
  if (opts.captureWebVitals) {
    let webVitalEvents = 0
    let cumulativeLayoutShift = 0
    let currentInp = 0
    const configuredWebVitalLimit = opts.maxWebVitalEvents
    const maxWebVitalEvents = Number.isFinite(configuredWebVitalLimit)
      ? Math.max(1, Math.floor(configuredWebVitalLimit!))
      : 50
    const seenWebVitalEntries = new Set<string>()
    const webVitalObserverDisconnects: Array<() => void> = []
    let webVitalObservationStopped = false
    const stopWebVitalObservation = () => {
      if (webVitalObservationStopped) return
      webVitalObservationStopped = true
      seenWebVitalEntries.clear()
      while (webVitalObserverDisconnects.length) webVitalObserverDisconnects.pop()?.()
    }
    const enqueueWebVital = (
      metricName: string,
      value: number | undefined,
      entry: BrowserPerformanceEntryLike,
      extraAttributes: Record<string, unknown> = {},
    ) => {
      if (webVitalObservationStopped || webVitalEvents >= maxWebVitalEvents) {
        stopWebVitalObservation()
        return
      }
      const normalizedValue = normalizedWebVitalValue(metricName, value)
      if (normalizedValue === undefined) return
      webVitalEvents += 1
      const unit = metricName === "cls" ? "score" : "ms"
      const name = `browser.web_vital.${metricName}`
      enqueue({
        type: "metric",
        severity: "info",
        message: `WEB_VITAL ${metricName} ${normalizedValue}`,
        body: {
          name,
          value: normalizedValue,
          kind: "gauge",
          unit,
        },
        attributes: {
          name,
          operation: "browser.web_vital",
          web_vital: metricName,
          metric_kind: "gauge",
          value: normalizedValue,
          unit,
          rating: webVitalRating(metricName, normalizedValue),
          entry_type: entry.entryType,
          entry_name: entry.name,
          start_time_ms: roundedNumber(entry.startTime),
          duration_ms: roundedNumber(entry.duration),
          interaction_id: roundedNumber(entry.interactionId),
          ...extraAttributes,
        },
      })
      if (webVitalEvents >= maxWebVitalEvents) stopWebVitalObservation()
    }
    const processWebVitalEntry = (entry: BrowserPerformanceEntryLike) => {
      if (webVitalObservationStopped || webVitalEvents >= maxWebVitalEvents) {
        stopWebVitalObservation()
        return
      }
      const entryType = entry.entryType
      if (entryType === "paint" && entry.name === "first-contentful-paint") {
        if (normalizedWebVitalValue("fcp", entry.startTime) === undefined) return
        const key = browserWebVitalEntryKey("fcp", entry)
        if (seenWebVitalEntries.has(key)) return
        seenWebVitalEntries.add(key)
        enqueueWebVital("fcp", entry.startTime, entry)
        return
      }
      if (entryType === "largest-contentful-paint") {
        const value = entry.renderTime ?? entry.loadTime ?? entry.startTime
        if (normalizedWebVitalValue("lcp", value) === undefined) return
        const key = browserWebVitalEntryKey("lcp", entry)
        if (seenWebVitalEntries.has(key)) return
        seenWebVitalEntries.add(key)
        enqueueWebVital("lcp", value, entry)
        return
      }
      if (entryType === "layout-shift") {
        if (entry.hadRecentInput) return
        const delta = normalizedWebVitalValue("cls", entry.value)
        if (delta === undefined) return
        const key = browserWebVitalEntryKey("cls", entry)
        if (seenWebVitalEntries.has(key)) return
        seenWebVitalEntries.add(key)
        cumulativeLayoutShift = normalizedWebVitalValue("cls", cumulativeLayoutShift + delta) ?? cumulativeLayoutShift
        enqueueWebVital("cls", cumulativeLayoutShift, entry, { delta })
        return
      }
      if (entryType === "first-input") {
        const value =
          typeof entry.processingStart === "number" && typeof entry.startTime === "number"
            ? entry.processingStart - entry.startTime
            : entry.duration
        if (normalizedWebVitalValue("fid", value) === undefined) return
        const key = browserWebVitalEntryKey("fid", entry)
        if (seenWebVitalEntries.has(key)) return
        seenWebVitalEntries.add(key)
        enqueueWebVital("fid", value, entry)
        return
      }
      if (entryType === "event") {
        const value = typeof entry.duration === "number" ? entry.duration : undefined
        const normalizedValue = normalizedWebVitalValue("inp", value)
        if (normalizedValue === undefined || normalizedValue <= currentInp) return
        const key = browserWebVitalEntryKey("inp", entry)
        if (seenWebVitalEntries.has(key)) return
        seenWebVitalEntries.add(key)
        currentInp = normalizedValue
        enqueueWebVital("inp", normalizedValue, entry)
      }
    }
    const processExistingWebVitalEntries = (entryType: string) => {
      for (const entry of browser.performance?.getEntriesByType?.(entryType) ?? []) {
        if (webVitalObservationStopped) break
        processWebVitalEntry(entry)
      }
    }
    for (const entryType of ["paint", "largest-contentful-paint", "layout-shift", "first-input", "event"]) {
      if (webVitalObservationStopped) break
      processExistingWebVitalEntries(entryType)
    }
    const observeWebVitalEntries = (
      entryType: string,
      observeOptions: { type: string; buffered: boolean; durationThreshold?: number },
    ) => {
      if (webVitalObservationStopped || !runtime.PerformanceObserver) return
      try {
        const observer = new runtime.PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (webVitalObservationStopped || webVitalEvents >= maxWebVitalEvents) {
              stopWebVitalObservation()
              break
            }
            processWebVitalEntry(entry)
          }
        })
        let observing = false
        try {
          observer.observe(observeOptions)
          observing = true
        } catch {
          try {
            observer.observe({ entryTypes: [entryType] })
            observing = true
          } catch {
            // Some browser-like runtimes expose PerformanceObserver without this entry type.
          }
        }
        if (observing) {
          let disconnected = false
          const disconnectObserver = () => {
            if (disconnected) return
            disconnected = true
            observer.disconnect()
          }
          webVitalObserverDisconnects.push(disconnectObserver)
          restores.push(disconnectObserver)
        }
      } catch {
        // Ignore broken browser-like PerformanceObserver constructors.
      }
    }
    observeWebVitalEntries("paint", { type: "paint", buffered: true })
    observeWebVitalEntries("largest-contentful-paint", { type: "largest-contentful-paint", buffered: true })
    observeWebVitalEntries("layout-shift", { type: "layout-shift", buffered: true })
    observeWebVitalEntries("first-input", { type: "first-input", buffered: true })
    observeWebVitalEntries("event", { type: "event", buffered: true, durationThreshold: 16 })
  }
  if (opts.captureFetch !== false && runtime.fetch) {
    const originalFetch = runtime.fetch
    const boundFetch = originalFetch.bind(globalThis)
    runtime.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const requestUrl = browserRequestUrlString(input, browser.location?.href)
      const method = requestMethod(input, init)
      const collectorRequest = isCollectorRequest(requestUrl, serverUrl)
      const traceparentSuppressed = browserTraceparentSuppressionReason(
        requestUrl,
        browserRequestMode(input, init),
      )
      let fetchInput = input
      let fetchInit = init
      const existingTraceparent = traceparentSuppressed
        ? { present: false }
        : traceparentInfoFromFetchInput(input, init)
      let traceContext = existingTraceparent.context
      let traceparentInjected = false
      if (!traceparentSuppressed && !existingTraceparent.present && !collectorRequest && shouldPropagateTrace(opts, requestUrl, browser.location?.href)) {
        traceContext = { traceId: randomHex(32), spanId: randomHex(16) }
        const tracedFetch = fetchInputWithTraceparent(
          input,
          init,
          traceparentFromContext(traceContext),
        )
        fetchInput = tracedFetch.input
        fetchInit = tracedFetch.init
        traceparentInjected = true
      }
      const startedAt = Date.now()
      try {
        const response = await boundFetch(fetchInput, fetchInit)
        if (!collectorRequest) {
          enqueue({
            type: "span",
            severity: response.ok ? "info" : "error",
            trace_id: traceContext?.traceId,
            span_id: traceContext?.spanId ?? randomId("span"),
            message: `${method} ${requestUrl}`,
            body: {
              name: `${method} ${requestUrl}`,
              operation: "http.client",
              status: response.ok ? "ok" : "error",
              duration_ms: Date.now() - startedAt,
            },
            attributes: {
              name: `${method} ${requestUrl}`,
              operation: "http.client",
              method,
              url: requestUrl,
              status_code: response.status,
              ok: response.ok,
              duration_ms: Date.now() - startedAt,
              traceparent_propagated: traceparentInjected || undefined,
              traceparent_existing: existingTraceparent.present || undefined,
              traceparent_suppressed: traceparentSuppressed,
            },
          })
        }
        return response
      } catch (error) {
        if (!collectorRequest) {
          const normalized = normalizeError(error)
          enqueue({
            type: "network",
            severity: "error",
            trace_id: traceContext?.traceId,
            span_id: traceContext?.spanId ?? randomId("span"),
            message: `${method} ${requestUrl} failed: ${normalized.message}`,
            body: {
              error: {
                type: normalized.type,
                value: normalized.message,
                stack_trace: normalized.stack,
              },
            },
            attributes: {
              operation: "http.client",
              method,
              url: requestUrl,
              duration_ms: Date.now() - startedAt,
              error_type: normalized.type,
              stack_trace: normalized.stack,
              traceparent_propagated: traceparentInjected || undefined,
              traceparent_existing: existingTraceparent.present || undefined,
              traceparent_suppressed: traceparentSuppressed,
            },
          })
        }
        throw error
      }
    }) as typeof fetch
    restores.push(() => { runtime.fetch = originalFetch })
  }
  const beforeUnloadListener = () => { void flush() }
  browser.window.addEventListener("beforeunload", beforeUnloadListener)
  restores.push(() => { browser.window?.removeEventListener?.("beforeunload", beforeUnloadListener) })
  return {
    flush,
    stop() {
      stopped = true
      while (restores.length) restores.pop()?.()
    },
  }
}

interface BrowserUniversalSpool {
  enabled: boolean
  load(): BrowserUniversalSpoolLoad
  save(events: UniversalEvent[]): void
}

interface BrowserUniversalSpoolLoad {
  hadStoredRecord: boolean
  events: UniversalEvent[]
}

interface BrowserUniversalSpoolRecord {
  version: 1
  events: UniversalEvent[]
}

function createBrowserUniversalSpool(opts: UniversalLogsOptions): BrowserUniversalSpool {
  const runtime = globalThis as unknown as BrowserGlobal
  const storage = runtime.localStorage
  const key = browserUniversalSpoolKey(opts)
  if (!storage || !key) {
    return {
      enabled: false,
      load: () => ({ hadStoredRecord: false, events: [] }),
      save: () => {},
    }
  }
  return {
    enabled: true,
    load() {
      let raw: string | null
      try {
        raw = storage.getItem(key)
      } catch {
        return { hadStoredRecord: false, events: [] }
      }
      if (!raw) return { hadStoredRecord: false, events: [] }
      try {
        const parsed = JSON.parse(raw) as unknown
        if (!isObjectRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.events)) {
          return { hadStoredRecord: true, events: [] }
        }
        const events = parsed.events
          .filter(isValidBrowserUniversalSpoolEvent)
          .map((event) => redactBrowserUniversalEvent(event))
          .filter(isValidBrowserUniversalSpoolEvent)
        return { hadStoredRecord: true, events }
      } catch {
        return { hadStoredRecord: true, events: [] }
      }
    },
    save(events) {
      try {
        const validEvents = events
          .filter(isValidBrowserUniversalSpoolEvent)
          .map(redactBrowserUniversalEvent)
          .filter(isValidBrowserUniversalSpoolEvent)
        if (!validEvents.length) {
          storage.removeItem(key)
          return
        }
        storage.setItem(
          key,
          JSON.stringify({
            version: 1,
            events: validEvents,
          } satisfies BrowserUniversalSpoolRecord),
        )
      } catch {
        // Browser storage may be unavailable, full, or blocked. Capture must continue in memory.
      }
    },
  }
}

function browserUniversalSpoolKey(opts: UniversalLogsOptions): string | undefined {
  if (!opts.browserSpool && !opts.browserSpoolKey) return undefined
  if (opts.browserSpoolKey) return opts.browserSpoolKey
  return [
    "open-logs",
    "browser-universal-spool",
    sanitizeSpoolPathPart(opts.projectId),
    sanitizeSpoolPathPart(opts.sessionId ?? "default"),
  ].join(":")
}

function persistBrowserUniversalSpool(
  spool: BrowserUniversalSpool,
  q: Array<{ spoolEvent: UniversalEvent }>,
): void {
  if (!spool.enabled) return
  spool.save(q.map((item) => item.spoolEvent))
}

function redactBrowserUniversalEvent(event: unknown): UniversalEvent {
  const redacted = redactSdkValue(event)
  return isObjectRecord(redacted)
    ? redacted as unknown as UniversalEvent
    : { type: "log", message: String(redacted) }
}

function stripBrowserUniversalEventIdentity(event: UniversalEvent): UniversalEvent {
  const stripped = { ...event } as Record<string, unknown>
  for (const key of SDK_BROWSER_FORBIDDEN_IDENTITY_FIELDS) delete stripped[key]
  if (isObjectRecord(stripped.attributes)) {
    stripped.attributes = stripBrowserIdentityFields(stripped.attributes)
  }
  if (isObjectRecord(stripped.metadata)) {
    stripped.metadata = stripBrowserIdentityFields(stripped.metadata)
  }
  return stripped as unknown as UniversalEvent
}

function stripBrowserIdentityFields(value: Record<string, unknown>): Record<string, unknown> {
  const stripped = { ...value }
  for (const key of SDK_BROWSER_FORBIDDEN_IDENTITY_FIELDS) delete stripped[key]
  return stripped
}

function isValidBrowserUniversalSpoolEvent(event: unknown): event is UniversalEvent {
  if (!isObjectRecord(event)) return false
  for (const key of Object.keys(event)) {
    if (!SDK_BROWSER_UNIVERSAL_EVENT_FIELDS.has(key)) return false
  }
  if (!SDK_BROWSER_UNIVERSAL_EVENT_TYPES.has(event.type)) return false
  if (event.source !== undefined && event.source !== "browser") return false
  if (
    event.schema_version !== undefined &&
    (!Number.isInteger(event.schema_version) || Number(event.schema_version) < 1)
  ) {
    return false
  }
  const severity = event.severity ?? event.level
  if (severity !== undefined && severity !== null) {
    if (typeof severity !== "string" || !SDK_BROWSER_SEVERITIES.has(severity)) return false
  }
  if (event.privacy !== undefined && event.privacy !== null) {
    if (typeof event.privacy !== "string" || !SDK_BROWSER_PRIVACY_CLASSES.has(event.privacy)) return false
  }
  for (const key of SDK_BROWSER_STRING_EVENT_FIELDS) {
    const item = event[key]
    if (item !== undefined && item !== null && typeof item !== "string") return false
  }
  for (const key of SDK_BROWSER_TIMESTAMP_EVENT_FIELDS) {
    const item = event[key]
    if (typeof item === "string" && item.length > 0 && Number.isNaN(new Date(item).getTime())) {
      return false
    }
  }
  for (const key of SDK_BROWSER_OBJECT_EVENT_FIELDS) {
    const item = event[key]
    if (item !== undefined && !isObjectRecord(item)) return false
  }
  if (hasBrowserIdentityFields(event.attributes) || hasBrowserIdentityFields(event.metadata)) return false
  for (const key of SDK_BROWSER_FORBIDDEN_IDENTITY_FIELDS) {
    if (event[key] !== undefined && event[key] !== null) return false
  }
  return true
}

function hasBrowserIdentityFields(value: unknown): boolean {
  if (!isObjectRecord(value)) return false
  return SDK_BROWSER_FORBIDDEN_IDENTITY_FIELDS.some((key) => value[key] !== undefined && value[key] !== null)
}

const SDK_BROWSER_UNIVERSAL_EVENT_FIELDS = new Set<string>([
  "schema_version",
  "event_id",
  "id",
  "source_event_id",
  "event_time",
  "timestamp",
  "type",
  "source",
  "severity",
  "level",
  "privacy",
  "project_id",
  "page_id",
  "machine_id",
  "repo_id",
  "app_id",
  "process_id",
  "run_id",
  "trace_id",
  "span_id",
  "parent_span_id",
  "session_id",
  "release_id",
  "environment",
  "artifact_id",
  "message",
  "body",
  "attributes",
  "metadata",
])

const SDK_BROWSER_UNIVERSAL_EVENT_TYPES = new Set<unknown>([
  "log",
  "exception",
  "span",
  "metric",
  "network",
  "replay",
  "session",
])

const SDK_BROWSER_SEVERITIES = new Set<string>(["debug", "info", "warn", "error", "fatal"])

const SDK_BROWSER_PRIVACY_CLASSES = new Set<string>(["public", "internal", "sensitive", "secret", "pii"])

const SDK_BROWSER_STRING_EVENT_FIELDS = [
  "event_id",
  "id",
  "source_event_id",
  "event_time",
  "timestamp",
  "source",
  "severity",
  "level",
  "privacy",
  "project_id",
  "page_id",
  "machine_id",
  "repo_id",
  "app_id",
  "process_id",
  "run_id",
  "trace_id",
  "span_id",
  "parent_span_id",
  "session_id",
  "release_id",
  "environment",
  "artifact_id",
  "message",
] as const

const SDK_BROWSER_TIMESTAMP_EVENT_FIELDS = ["event_time", "timestamp"] as const

const SDK_BROWSER_OBJECT_EVENT_FIELDS = ["body", "attributes", "metadata"] as const

const SDK_BROWSER_FORBIDDEN_IDENTITY_FIELDS = [
  "project_id",
  "page_id",
  "machine_id",
  "repo_id",
  "app_id",
  "process_id",
  "run_id",
  "artifact_id",
  "build_id",
  "agent_id",
]

function normalizeError(error: unknown): { type: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return { type: error.name || "Error", message: error.message || String(error), stack: error.stack }
  }
  if (typeof error === "object" && error !== null) {
    const record = error as { name?: unknown; message?: unknown; stack?: unknown }
    return {
      type: typeof record.name === "string" ? record.name : "Error",
      message: typeof record.message === "string" ? record.message : safeStringify(error),
      stack: typeof record.stack === "string" ? record.stack : undefined,
    }
  }
  return { type: "Error", message: String(error) }
}

function formatArgs(args: unknown[]): string {
  return args.map(arg => {
    if (typeof arg === "string") return arg
    if (arg instanceof Error) return `${arg.name}: ${arg.message}`
    if (typeof arg === "object" && arg !== null) return safeStringify(arg)
    return String(arg)
  }).join(" ")
}

function requestUrlString(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.toString()
  if (typeof Request !== "undefined" && input instanceof Request) return input.url
  return String(input)
}

function browserRequestUrlString(input: Parameters<typeof fetch>[0], baseHref?: string): string {
  const value = requestUrlString(input)
  if (!baseHref) return value
  try {
    return new URL(value, baseHref).toString()
  } catch {
    return value
  }
}

function browserRequestMode(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): RequestInit["mode"] | undefined {
  if (init?.mode) return init.mode
  if (typeof Request !== "undefined" && input instanceof Request) return input.mode
  return undefined
}

function browserTraceparentSuppressionReason(
  requestUrl: string,
  requestMode: RequestInit["mode"] | undefined,
): string | undefined {
  if (requestMode === "no-cors") return "no-cors"
  try {
    const protocol = new URL(requestUrl).protocol
    if (protocol !== "http:" && protocol !== "https:") return "non-http"
  } catch {
    return undefined
  }
  return undefined
}

function browserPerformanceEntryUrl(entry: BrowserPerformanceEntryLike, baseHref?: string): string | undefined {
  if (typeof entry.name !== "string" || !entry.name) return undefined
  try {
    return baseHref ? new URL(entry.name, baseHref).toString() : entry.name
  } catch {
    return entry.name
  }
}

function browserPerformanceEntryKey(
  entry: BrowserPerformanceEntryLike,
  url: string,
  initiatorType: string,
): string {
  return [
    url,
    initiatorType,
    roundedNumber(entry.startTime) ?? "",
    roundedNumber(entry.duration) ?? "",
    roundedNumber(entry.transferSize) ?? "",
    roundedNumber(entry.responseStatus) ?? "",
  ].join("|")
}

function browserWebVitalEntryKey(metricName: string, entry: BrowserPerformanceEntryLike): string {
  return [
    metricName,
    entry.entryType ?? "",
    entry.name ?? "",
    roundedNumber(entry.startTime) ?? "",
    roundedNumber(entry.duration) ?? "",
    normalizedWebVitalValue(metricName, entry.value) ?? "",
    roundedNumber(entry.processingStart) ?? "",
    roundedNumber(entry.interactionId) ?? "",
    roundedNumber(entry.renderTime) ?? "",
    roundedNumber(entry.loadTime) ?? "",
  ].join("|")
}

function normalizedWebVitalValue(metricName: string, value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return metricName === "cls" ? Math.round(value * 1000) / 1000 : Math.round(value)
}

function webVitalRating(metricName: string, value: number): "good" | "needs_improvement" | "poor" | undefined {
  const thresholds = WEB_VITAL_THRESHOLDS[metricName]
  if (!thresholds) return undefined
  if (value <= thresholds.good) return "good"
  if (value <= thresholds.needsImprovement) return "needs_improvement"
  return "poor"
}

const WEB_VITAL_THRESHOLDS: Record<string, { good: number; needsImprovement: number }> = {
  fcp: { good: 1800, needsImprovement: 3000 },
  lcp: { good: 2500, needsImprovement: 4000 },
  cls: { good: 0.1, needsImprovement: 0.25 },
  fid: { good: 100, needsImprovement: 300 },
  inp: { good: 200, needsImprovement: 500 },
}

function roundedNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined
}

function requestMethod(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): string {
  if (init?.method) return init.method.toUpperCase()
  if (typeof Request !== "undefined" && input instanceof Request && input.method) return input.method.toUpperCase()
  return "GET"
}

interface OutgoingTraceContext {
  traceId: string
  spanId: string
}

interface FetchTraceparentInfo {
  present: boolean
  value?: string
  context?: OutgoingTraceContext
}

function traceparentInfoFromFetchInput(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): FetchTraceparentInfo {
  if (init?.headers !== undefined) {
    const header = fetchHeaderValue(init.headers, "traceparent")
    return {
      present: header.present,
      value: header.value,
      context: parseTraceparent(header.value),
    }
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    const value = input.headers.get("traceparent") ?? undefined
    return {
      present: value !== undefined,
      value,
      context: parseTraceparent(value),
    }
  }
  return { present: false }
}

function fetchInputWithTraceparent(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1] | undefined,
  traceparent: string,
): { input: Parameters<typeof fetch>[0]; init?: Parameters<typeof fetch>[1] } {
  const headers = new Headers(
    init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined),
  )
  headers.set("traceparent", traceparent)
  return { input, init: { ...(init ?? {}), headers } }
}

function fetchHeaderValue(headers: RequestInit["headers"] | undefined, name: string): { present: boolean; value?: string } {
  if (!headers) return { present: false }
  if (typeof Headers !== "undefined") {
    const value = new Headers(headers).get(name) ?? undefined
    return { present: value !== undefined, value }
  }
  const normalizedName = name.toLowerCase()
  if (Array.isArray(headers)) {
    const pairs = headers.filter((entry) => entry[0]?.toLowerCase() === normalizedName)
    return pairs.length
      ? { present: true, value: pairs.map((entry) => entry[1]).join(", ") }
      : { present: false }
  }
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    if (key.toLowerCase() === normalizedName) return { present: true, value }
  }
  return { present: false }
}

function shouldPropagateTrace(
  opts: UniversalLogsOptions,
  requestUrl: string,
  baseHref?: string,
): boolean {
  if (opts.propagateTrace !== true) return false
  const targets = opts.tracePropagationTargets ?? []
  if (targets.length > 0) {
    return targets.some((target) => tracePropagationTargetMatches(target, requestUrl))
  }
  if (baseHref) return sameOrigin(requestUrl, baseHref)
  return true
}

function tracePropagationTargetMatches(target: string | RegExp, requestUrl: string): boolean {
  if (typeof target === "string") {
    try {
      const parsedTarget = new URL(target)
      const parsedRequest = new URL(requestUrl)
      if (parsedRequest.origin !== parsedTarget.origin) return false
      return `${parsedRequest.pathname}${parsedRequest.search}`.startsWith(
        `${parsedTarget.pathname}${parsedTarget.search}`,
      )
    } catch {
      return requestUrl.startsWith(target)
    }
  }
  target.lastIndex = 0
  return target.test(requestUrl)
}

function sameOrigin(requestUrl: string, baseHref: string): boolean {
  try {
    return new URL(requestUrl, baseHref).origin === new URL(baseHref).origin
  } catch {
    return false
  }
}

function traceparentFromContext(context: OutgoingTraceContext): string {
  return `00-${context.traceId}-${context.spanId}-01`
}

function routeForRequest(request: Request, route: HttpRequestCaptureOptions["route"]): string {
  if (typeof route === "function") return route(request) ?? safeUrlParts(request.url).path
  if (route) return route
  return safeUrlParts(request.url).path
}

async function emitNodeHttpRequestTelemetry(input: {
  request: NodeHttpRequestLike
  response: NodeHttpResponseLike
  opts: NodeHttpRequestCaptureOptions
  startedAt: number
  startedIso: string
  error?: unknown
}): Promise<void> {
  const source = input.opts.source ?? input.opts.framework ?? runtimeName()
  const client: EventWriter = input.opts.client ?? new LogsClient({ ...input.opts, source })
  const request = nodeRequestToRequest(input.request)
  const { traceId, parentSpanId } = traceContextFromRequest(request)
  const spanId = randomHex(16)
  const method = request.method || "GET"
  const url = safeUrlParts(request.url)
  const operation = input.opts.operation ?? "http.server"
  const durationMs = Date.now() - input.startedAt
  const route = nodeRouteForRequest(input.request, input.opts.route)
  const name = `${method} ${route}`
  const statusCode = nodeResponseStatus(input.response, input.error)
  const normalized = input.error ? normalizeError(input.error) : undefined
  const response = nodeResponseToResponse(input.response, statusCode, input.opts.responseHeaderNames)
  const span = httpServerSpanEvent({
    source,
    request,
    response,
    traceId,
    spanId,
    parentSpanId,
    method,
    route,
    url,
    operation,
    name,
    statusCode,
    durationMs,
    startedIso: input.startedIso,
    requestHeaderNames: input.opts.requestHeaderNames,
    responseHeaderNames: input.opts.responseHeaderNames,
    framework: input.opts.framework,
    errorType: normalized?.type,
  })

  if (!input.error || input.error instanceof ResponseClosedError) {
    await sendRequestTelemetry(client, [span], input.opts.waitForTelemetry)
    return
  }

  const exception: UniversalEvent = {
    type: "exception",
    source,
    severity: "error",
    trace_id: traceId,
    span_id: spanId,
    parent_span_id: parentSpanId,
    message: normalized?.message ?? "Request failed",
    body: {
      exception: {
        type: normalized?.type,
        value: normalized?.message,
        stack_trace: normalized?.stack,
        handled: false,
        mechanism: `${input.opts.framework ?? "node-http"}.request`,
      },
    },
    attributes: {
      exception_type: normalized?.type,
      stack_trace: normalized?.stack,
      handled: false,
      mechanism: `${input.opts.framework ?? "node-http"}.request`,
      operation,
      method,
      route,
      url_scheme: url.scheme,
      url_host: url.host,
      url_path: url.path,
      query_present: url.queryPresent,
      framework: input.opts.framework,
      duration_ms: durationMs,
    },
  }
  await sendRequestTelemetry(client, [span, exception], input.opts.waitForTelemetry)
}

function nodeRequestToRequest(request: NodeHttpRequestLike): Request {
  return new Request(nodeRequestUrl(request), {
    method: nodeRequestMethod(request),
    headers: nodeHeaders(request),
  })
}

function nodeRequestUrl(request: NodeHttpRequestLike): string {
  const input = request.originalUrl ?? request.url ?? request.path ?? "/"
  if (/^https?:\/\//i.test(input)) return safeAbsoluteUrl(input) ?? "http://localhost/"
  const path = input.startsWith("/") ? input : `/${input}`
  const host = safeNodeHost(firstHeaderValue(nodeRequestHeader(request, "host")) ?? request.hostname) ?? "localhost"
  const scheme = safeNodeScheme(request.protocol ?? firstHeaderValue(nodeRequestHeader(request, "x-forwarded-proto")))
  return safeAbsoluteUrl(`${scheme}://${host}${path}`) ?? `http://localhost${path}`
}

function safeAbsoluteUrl(input: string): string | undefined {
  try {
    return new URL(input).toString()
  } catch {
    return undefined
  }
}

function safeNodeHost(input: string | undefined): string | undefined {
  const host = input?.trim()
  if (!host || /[\s/\\?#@]/.test(host)) return undefined
  try {
    const parsed = new URL(`http://${host}/`)
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return undefined
    if (parsed.host.toLowerCase() !== host.toLowerCase()) return undefined
    return host
  } catch {
    return undefined
  }
}

function safeNodeScheme(input: string | undefined): "http" | "https" {
  const scheme = input?.split(",")[0]?.trim().replace(/:$/, "").toLowerCase()
  return scheme === "https" ? "https" : "http"
}

function nodeRequestMethod(request: NodeHttpRequestLike): string {
  const method = request.method?.toUpperCase() ?? "GET"
  return /^[A-Z][A-Z0-9-]*$/.test(method) ? method : "GET"
}

function nodeHeaders(request: NodeHttpRequestLike): Headers {
  const headers = new Headers()
  if (request.headers instanceof Headers) {
    request.headers.forEach((value, name) => headers.set(name, value))
    return headers
  }
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    setHeaderValue(headers, name, value)
  }
  for (const name of ["host", "traceparent", "tracestate", "x-forwarded-proto"]) {
    const value = firstHeaderValue(nodeRequestHeader(request, name))
    if (value && !headers.has(name)) headers.set(name, value)
  }
  return headers
}

function setHeaderValue(headers: Headers, name: string, value: string | string[] | number | undefined): void {
  if (value === undefined) return
  if (Array.isArray(value)) {
    headers.set(name, value.map(String).join(", "))
    return
  }
  headers.set(name, String(value))
}

function nodeRequestHeader(request: NodeHttpRequestLike, name: string): string | string[] | number | undefined {
  const getter = request.header ?? request.get
  const direct = getter?.call(request, name)
  if (direct !== undefined) return direct
  const headers = request.headers
  if (!headers) return undefined
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const lowerName = name.toLowerCase()
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() === lowerName) return value
  }
  return undefined
}

function nodeRouteForRequest(request: NodeHttpRequestLike, route: NodeHttpRequestCaptureOptions["route"]): string {
  if (typeof route === "function") return route(request) ?? nodeRouteFallback(request)
  if (route) return route
  return nodeRouteFallback(request)
}

function nodeRouteFallback(request: NodeHttpRequestLike): string {
  const routePath = routePathValue(request.route)
  if (routePath) return joinRoutePath(request.baseUrl, routePath)
  if (request.routerPath) return request.routerPath
  if (request.routeOptions?.url) return request.routeOptions.url
  if (request.path) return request.path
  return safeUrlParts(nodeRequestUrl(request)).path
}

function routePathValue(route: NodeHttpRequestLike["route"]): string | undefined {
  if (!route) return undefined
  if (typeof route === "string") return route
  const path = route.path
  if (!path) return undefined
  if (Array.isArray(path)) return path.map(part => String(part)).join("|")
  return String(path)
}

function joinRoutePath(baseUrl: string | undefined, routePath: string): string {
  if (!baseUrl) return routePath
  if (routePath === "/") return baseUrl || "/"
  return `${baseUrl.replace(/\/$/, "")}/${routePath.replace(/^\//, "")}`
}

function nodeResponseStatus(response: NodeHttpResponseLike, error: unknown): number {
  if (error instanceof ResponseClosedError) return 499
  const status = response.statusCode ?? response.status
  if (typeof status === "number" && status >= 100 && status <= 599) {
    if (error && status < 400) return 500
    return status
  }
  return error ? 500 : 200
}

function nodeResponseToResponse(response: NodeHttpResponseLike, status: number, headerNames: string[] | undefined): Response {
  const headers = new Headers()
  for (const name of headerNames ?? []) {
    const value = firstHeaderValue(nodeResponseHeader(response, name))
    if (value !== undefined) headers.set(name, value)
  }
  return new Response(null, { status: status >= 200 ? status : 200, headers })
}

function nodeResponseHeader(response: NodeHttpResponseLike, name: string): string | string[] | number | undefined {
  const direct = response.getHeader?.call(response, name)
  if (direct !== undefined) return direct
  const headers = response.headers
  if (!headers) return undefined
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const lowerName = name.toLowerCase()
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() === lowerName) return value
  }
  return undefined
}

function firstHeaderValue(value: string | string[] | number | undefined): string | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value)) return value.length ? String(value[0]) : undefined
  return String(value)
}

function addNodeListener(target: NodeHttpRequestLike | NodeHttpResponseLike, event: string | symbol, listener: (...args: unknown[]) => void): () => void {
  if (typeof target.on === "function") {
    target.on(event, listener)
    return () => removeNodeListener(target, event, listener)
  }
  if (typeof target.once === "function") {
    const onceListener = (...args: unknown[]) => {
      removeNodeListener(target, event, onceListener)
      listener(...args)
    }
    target.once(event, onceListener)
    return () => removeNodeListener(target, event, onceListener)
  }
  return () => {}
}

function cleanupNodeListeners(cleanups: Array<() => void>): void {
  while (cleanups.length) cleanups.pop()?.()
}

function removeNodeListener(target: NodeHttpRequestLike | NodeHttpResponseLike, event: string | symbol, listener: (...args: unknown[]) => void): void {
  if (typeof target.off === "function") {
    target.off(event, listener)
    return
  }
  target.removeListener?.(event, listener)
}

function nodeErrorMonitorEvent(): symbol | undefined {
  try {
    const runtime = globalThis as unknown as {
      process?: {
        getBuiltinModule?: (name: string) => { errorMonitor?: unknown } | undefined
      }
    }
    const errorMonitor = runtime.process?.getBuiltinModule?.("node:events")?.errorMonitor
    return typeof errorMonitor === "symbol" ? errorMonitor : undefined
  } catch {
    return undefined
  }
}

function setExpressCapture(request: NodeHttpRequestLike, capture: NodeHttpCaptureController): void {
  if (request && typeof request === "object") {
    (request as NodeHttpRequestLike & { [expressCaptureSymbol]?: NodeHttpCaptureController })[expressCaptureSymbol] = capture
  }
}

function getExpressCapture(request: NodeHttpRequestLike): NodeHttpCaptureController | undefined {
  return (request as NodeHttpRequestLike & { [expressCaptureSymbol]?: NodeHttpCaptureController })[expressCaptureSymbol]
}

function clearExpressCapture(request: NodeHttpRequestLike): void {
  if (request && typeof request === "object") {
    delete (request as NodeHttpRequestLike & { [expressCaptureSymbol]?: NodeHttpCaptureController })[expressCaptureSymbol]
  }
}

function fastifyRequestLike(request: FastifyTelemetryRequestLike): NodeHttpRequestLike {
  if (!request.raw) return request
  return {
    ...request.raw,
    method: request.method ?? request.raw.method,
    url: request.url ?? request.raw.url,
    headers: request.headers ?? request.raw.headers,
    header: request.header?.bind(request) ?? request.raw.header?.bind(request.raw),
    get: request.get?.bind(request) ?? request.raw.get?.bind(request.raw),
    on: request.raw.on?.bind(request.raw),
    once: request.raw.once?.bind(request.raw),
    off: request.raw.off?.bind(request.raw),
    removeListener: request.raw.removeListener?.bind(request.raw),
    routeOptions: request.routeOptions ?? request.raw.routeOptions,
    routerPath: request.routerPath ?? request.raw.routerPath,
  }
}

function fastifyResponseLike(reply: FastifyTelemetryReplyLike): NodeHttpResponseLike {
  if (!reply.raw) return reply
  return {
    ...reply.raw,
    statusCode: reply.statusCode ?? reply.raw.statusCode,
    status: reply.status ?? reply.raw.status,
    headers: reply.headers ?? reply.raw.headers,
    getHeader: reply.getHeader?.bind(reply) ?? reply.raw.getHeader?.bind(reply.raw),
    on: reply.raw.on?.bind(reply.raw),
    once: reply.raw.once?.bind(reply.raw),
    off: reply.raw.off?.bind(reply.raw),
    removeListener: reply.raw.removeListener?.bind(reply.raw),
  }
}

function fastifyRoute(request: NodeHttpRequestLike): string | undefined {
  return request.routeOptions?.url ?? request.routerPath
}

class ResponseClosedError extends Error {
  constructor() {
    super("Response closed before finish")
    this.name = "ResponseClosedError"
  }
}

function safeUrlParts(input: string): { scheme: string | null; host: string | null; path: string; queryPresent: boolean } {
  try {
    const url = new URL(input)
    return {
      scheme: url.protocol.replace(/:$/, "") || null,
      host: url.host || null,
      path: url.pathname || "/",
      queryPresent: url.search.length > 0,
    }
  } catch {
    return { scheme: null, host: null, path: input.split("?")[0] || "/", queryPresent: input.includes("?") }
  }
}

function traceContextFromRequest(request: Request): { traceId: string; parentSpanId?: string } {
  const parsed = parseTraceparent(request.headers.get("traceparent"))
  if (parsed) return { traceId: parsed.traceId, parentSpanId: parsed.spanId }
  return { traceId: randomHex(32) }
}

function parseTraceparent(value: string | null | undefined): OutgoingTraceContext | undefined {
  const match = value?.match(/^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/)
  const version = match?.[1]
  const traceId = match?.[2]
  const spanId = match?.[3]
  if (version === "ff") return undefined
  if (!traceId || !spanId) return undefined
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined
  return { traceId, spanId }
}

function responseLike(value: unknown): Response | undefined {
  if (typeof Response !== "undefined" && value instanceof Response) return value
  if (value && typeof value === "object" && "status" in value && typeof (value as { status?: unknown }).status === "number") {
    return value as Response
  }
  return undefined
}

function httpServerSpanEvent(input: {
  source: string
  request: Request
  response?: Response
  traceId: string
  spanId: string
  parentSpanId?: string
  method: string
  route: string
  url: { scheme: string | null; host: string | null; path: string; queryPresent: boolean }
  operation: string
  name: string
  statusCode?: number
  durationMs: number
  startedIso: string
  requestHeaderNames?: string[]
  responseHeaderNames?: string[]
  framework?: string
  errorType?: string
}): UniversalEvent {
  const status = input.statusCode ?? 0
  const statusText = status >= 500 || input.errorType ? "error" : "ok"
  return {
    type: "span",
    source: input.source,
    severity: status >= 500 || input.errorType ? "error" : status >= 400 ? "warn" : "info",
    trace_id: input.traceId,
    span_id: input.spanId,
    parent_span_id: input.parentSpanId,
    message: input.name,
    body: {
      name: input.name,
      operation: input.operation,
      status: statusText,
      started_at: input.startedIso,
      duration_ms: input.durationMs,
    },
    attributes: {
      name: input.name,
      operation: input.operation,
      method: input.method,
      route: input.route,
      framework: input.framework,
      status: statusText,
      status_code: input.statusCode,
      duration_ms: input.durationMs,
      started_at: input.startedIso,
      url_scheme: input.url.scheme,
      url_host: input.url.host,
      url_path: input.url.path,
      query_present: input.url.queryPresent,
      request_headers: pickHeaders(input.request.headers, input.requestHeaderNames),
      response_headers: input.response ? pickHeaders(input.response.headers, input.responseHeaderNames) : undefined,
      error_type: input.errorType,
    },
  }
}

function pickHeaders(headers: Headers, names: string[] | undefined): Record<string, string> | undefined {
  if (!names?.length) return undefined
  const picked: Record<string, string> = {}
  for (const name of names) {
    const value = headers.get(name)
    if (value !== null) picked[name.toLowerCase()] = value
  }
  return Object.keys(picked).length ? picked : undefined
}

function structuredLogQuery(opts: StructuredLogSendOptions): string {
  const params = new URLSearchParams()
  setParam(params, "format", opts.format)
  setParam(params, "source", opts.source)
  setParam(params, "service", opts.service)
  setParam(params, "project_id", opts.projectId)
  setParam(params, "page_id", opts.pageId)
  setParam(params, "machine_id", opts.machineId)
  setParam(params, "repo_id", opts.repoId)
  setParam(params, "app_id", opts.appId)
  setParam(params, "process_id", opts.processId)
  setParam(params, "run_id", opts.runId)
  setParam(params, "trace_id", opts.traceId)
  setParam(params, "span_id", opts.spanId)
  setParam(params, "parent_span_id", opts.parentSpanId)
  setParam(params, "session_id", opts.sessionId)
  setParam(params, "release_id", opts.releaseId)
  setParam(params, "environment", opts.environment)
  setParam(params, "agent", opts.agent)
  setParam(params, "url", opts.logUrl)
  const query = params.toString()
  return query ? `?${query}` : ""
}

function setParam(params: URLSearchParams, key: string, value: string | undefined): void {
  if (value !== undefined && value !== "") params.set(key, value)
}

function structuredLogBatchBody(records: unknown[], opts: StructuredLogSendOptions): unknown {
  if (!opts.metadata && !opts.sourceEventPrefix) return records
  return {
    logs: records,
    metadata: opts.metadata,
    source_event_prefix: opts.sourceEventPrefix,
  }
}

interface QueuedStructuredLog {
  record: unknown
  spoolRecord: unknown
  sendOptions: StructuredLogSendOptions
  spoolSendOptions: StructuredLogSendOptions
  attempts: number
  eventId: string
  createdAt: string
  batchPrefix?: string
}

interface StructuredLogSpool {
  enabled: boolean
  load(): StructuredLogSpoolLoad
  save(items: QueuedStructuredLog[]): void
}

interface StructuredLogSpoolLoad {
  items: QueuedStructuredLog[]
  dropped: QueuedStructuredLog[]
  errors: number
}

function createStructuredLogQueue(opts: StructuredLoggerTransportOptions): {
  enqueue(record: unknown): void
  shouldFlush(): boolean
  flush(): Promise<void>
  stats(): StructuredLoggerTransportStats
  stop(): void
} {
  const client = new LogsClient(opts)
  const maxBatchSize = Math.max(1, opts.maxBatchSize ?? 20)
  const maxQueueSize = Math.max(1, opts.maxQueueSize ?? 10_000)
  const maxRetries = Math.max(0, opts.maxRetries ?? 3)
  const retryBaseDelayMs = Math.max(0, opts.retryBaseDelayMs ?? 250)
  const retryMaxDelayMs = Math.max(retryBaseDelayMs, opts.retryMaxDelayMs ?? 5_000)
  const flushIntervalMs = opts.flushIntervalMs ?? 2000
  const transportId = randomId(`${opts.format ?? "structured"}_transport`)
  const transportSendOptions = copyStructuredLogSendOptions(opts)
  const spooledTransportSendOptions = redactStructuredLogSendOptions(transportSendOptions)
  const spool = createStructuredLogSpool(opts)
  let q: QueuedStructuredLog[] = []
  const stats = {
    enqueued: 0,
    sent: 0,
    dropped: 0,
    retries: 0,
    failed_batches: 0,
    spool_loaded: 0,
    spool_dropped: 0,
    spool_errors: 0,
  }
  let batchNumber = 0
  let recordNumber = 0
  let stopped = false
  let inFlight: Promise<void> | undefined
  let activeBatch: QueuedStructuredLog[] | undefined

  const nextBatchPrefix = (sourceEventPrefix?: string): string => {
    batchNumber += 1
    return `${redactSdkString(sourceEventPrefix ?? "sdk-structured-transport")}:${transportId}:${batchNumber}`
  }

  const nextRecordId = (): string => {
    recordNumber += 1
    return `${transportId}:record:${recordNumber}`
  }

  const persistSpool = (): void => {
    if (!spool.enabled) return
    try {
      spool.save(q)
    } catch (error) {
      stats.spool_errors += 1
      opts.onError?.(error)
    }
  }

  const dropItem = (
    item: Pick<QueuedStructuredLog, "record" | "attempts">,
    reason: StructuredLoggerTransportDrop["reason"],
    error?: unknown,
  ): void => {
    stats.dropped += 1
    if (spool.enabled) stats.spool_dropped += 1
    opts.onDrop?.({ reason, record: item.record, attempts: item.attempts, error })
  }

  if (spool.enabled) {
    try {
      const loaded = spool.load()
      q = loaded.items
      stats.spool_loaded = q.length
      stats.spool_errors += loaded.errors
      for (const item of loaded.dropped) dropItem(item, "queue_full")
      if (loaded.errors || loaded.dropped.length) persistSpool()
    } catch (error) {
      stats.spool_errors += 1
      opts.onError?.(error)
    }
  }

  const makeQueueSpace = (incoming: unknown): boolean => {
    while (q.length >= maxQueueSize) {
      const dropIndex = q.findIndex((item) => !activeBatch?.includes(item))
      if (dropIndex < 0) {
        dropItem({ record: incoming, attempts: 0 }, "queue_full")
        return false
      }
      const dropped = q.splice(dropIndex, 1)[0]
      if (dropped) dropItem(dropped, "queue_full")
      persistSpool()
    }
    return true
  }

  const retryDelay = (attempts: number): number => {
    if (retryBaseDelayMs === 0) return 0
    return Math.min(retryMaxDelayMs, retryBaseDelayMs * (2 ** Math.max(0, attempts - 1)))
  }

  const recordForTransport = (item: { record: unknown, eventId: string }): unknown => {
    if (!isObjectRecord(item.record) || hasStructuredProducerId(item.record)) return item.record
    return { ...item.record, _open_logs_event_id: item.eventId }
  }

  const flush = async (): Promise<void> => {
    if (inFlight) return inFlight
    inFlight = (async () => {
      let firstDroppedError: unknown
      while (q.length) {
        const batch = nextStructuredLogBatch(q, maxBatchSize)
        const batchSendOptions = batch[0]?.sendOptions ?? transportSendOptions
        const batchPrefix =
          batch[0]?.batchPrefix ?? nextBatchPrefix(batchSendOptions.sourceEventPrefix)
        for (const item of batch) item.batchPrefix = batchPrefix
        persistSpool()
        activeBatch = batch
        try {
          await client.pushStructuredLogs(batch.map(recordForTransport), {
            ...batchSendOptions,
            sourceEventPrefix: batchPrefix,
          })
          q.splice(0, batch.length)
          stats.sent += batch.length
          persistSpool()
        } catch (error) {
          stats.failed_batches += 1
          for (const item of batch) item.attempts += 1
          const exhausted = batch.filter((item) => item.attempts > maxRetries)
          if (spool.enabled && exhausted.length) {
            for (const item of exhausted) item.attempts = 0
            opts.onError?.(error)
            firstDroppedError ??= error
            persistSpool()
            break
          }
          for (const item of exhausted) {
            const index = q.indexOf(item)
            if (index >= 0) q.splice(index, 1)
            dropItem(item, "retries_exhausted", error)
          }
          if (exhausted.length) opts.onError?.(error)
          if (exhausted.length) firstDroppedError ??= error
          persistSpool()
          const retryable = batch.filter((item) => item.attempts <= maxRetries && q.includes(item))
          if (!retryable.length) continue
          const attempts = Math.max(...retryable.map((item) => item.attempts))
          const nextDelayMs = retryDelay(attempts)
          stats.retries += 1
          opts.onRetry?.({
            error,
            attempts,
            pending: q.length,
            next_delay_ms: nextDelayMs,
          })
          if (nextDelayMs > 0) await sleep(nextDelayMs)
        } finally {
          activeBatch = undefined
        }
      }
      if (firstDroppedError) throw toError(firstDroppedError)
    })().finally(() => {
      inFlight = undefined
    })
    return inFlight
  }

  const interval = setInterval(() => {
    if (!q.length || stopped) return
    void flush().catch(opts.onError ?? noop)
  }, flushIntervalMs)

  return {
    enqueue(record) {
      if (stopped) return
      if (!makeQueueSpace(record)) return
      q.push({
        record,
        spoolRecord: redactStructuredSpoolRecord(record),
        sendOptions: transportSendOptions,
        spoolSendOptions: spooledTransportSendOptions,
        attempts: 0,
        eventId: nextRecordId(),
        createdAt: new Date().toISOString(),
      })
      stats.enqueued += 1
      persistSpool()
    },
    shouldFlush() {
      return q.length >= maxBatchSize
    },
    async flush() {
      await flush()
    },
    stats() {
      return {
        pending: q.length,
        in_flight: Boolean(inFlight),
        enqueued: stats.enqueued,
        sent: stats.sent,
        dropped: stats.dropped,
        retries: stats.retries,
        failed_batches: stats.failed_batches,
        max_queue_size: maxQueueSize,
        spool_enabled: spool.enabled,
        spool_pending: spool.enabled ? q.length : 0,
        spool_loaded: stats.spool_loaded,
        spool_dropped: stats.spool_dropped,
        spool_errors: stats.spool_errors,
      }
    },
    stop() {
      stopped = true
      clearInterval(interval)
    },
  }
}

interface NodeFsLike {
  existsSync(path: string): boolean
  mkdirSync(path: string, options?: { recursive?: boolean }): unknown
  readFileSync(path: string, encoding: "utf8"): string
  renameSync(oldPath: string, newPath: string): void
  unlinkSync(path: string): void
  writeFileSync(path: string, data: string, encoding: "utf8"): void
}

interface NodePathLike {
  dirname(path: string): string
  join(...parts: string[]): string
}

interface StructuredLogSpoolRecord {
  version: 1
  record: unknown
  send_options?: StructuredLogSendOptions
  event_id: string
  attempts: number
  created_at: string
  batch_prefix?: string
}

function createStructuredLogSpool(opts: StructuredLoggerTransportOptions): StructuredLogSpool {
  const filePath = structuredLogSpoolPath(opts)
  const builtins = nodeBuiltins()
  const spooledTransportSendOptions = redactStructuredLogSendOptions(
    copyStructuredLogSendOptions(opts),
  )
  if (!filePath || !builtins) {
    return {
      enabled: false,
      load: () => ({ items: [], dropped: [], errors: 0 }),
      save: () => {},
    }
  }
  const { fs, path } = builtins
  return {
    enabled: true,
    load() {
      if (!fs.existsSync(filePath)) return { items: [], dropped: [], errors: 0 }
      const contents = fs.readFileSync(filePath, "utf8")
      const items: QueuedStructuredLog[] = []
      let errors = 0
      for (const line of contents.split(/\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        let parsed: Partial<StructuredLogSpoolRecord>
        try {
          const value = JSON.parse(trimmed) as unknown
          if (!isObjectRecord(value)) {
            errors += 1
            continue
          }
          parsed = value
        } catch {
          errors += 1
          continue
        }
        if (parsed.version !== 1 || typeof parsed.event_id !== "string") {
          errors += 1
          continue
        }
        if (!isObjectRecord(parsed.record)) {
          errors += 1
          continue
        }
        const sendOptions = loadStructuredSpoolSendOptions(
          parsed.send_options,
          spooledTransportSendOptions,
        )
        if (!sendOptions) {
          errors += 1
          continue
        }
        const record = redactStructuredSpoolRecord(parsed.record)
        items.push({
          record,
          spoolRecord: record,
          sendOptions,
          spoolSendOptions: sendOptions,
          attempts:
            typeof parsed.attempts === "number" && parsed.attempts >= 0
              ? Math.floor(parsed.attempts)
              : 0,
          eventId: parsed.event_id,
          createdAt:
            typeof parsed.created_at === "string"
              ? parsed.created_at
              : new Date().toISOString(),
          batchPrefix:
            typeof parsed.batch_prefix === "string"
              ? redactStructuredBatchPrefix(parsed.batch_prefix)
              : undefined,
        })
      }
      const maxItems = Math.max(1, opts.maxQueueSize ?? 10_000)
      const dropped = items.length > maxItems ? items.slice(0, items.length - maxItems) : []
      return {
        items: items.slice(-maxItems),
        dropped,
        errors,
      }
    },
    save(items) {
      if (!items.length) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
        return
      }
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      const tmpPath = `${filePath}.${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}.tmp`
      const lines = items.map((item) =>
        JSON.stringify({
          version: 1,
          record: redactStructuredSpoolRecord(item.spoolRecord),
          send_options: redactStructuredLogSendOptions(item.spoolSendOptions),
          event_id: item.eventId,
          attempts: item.attempts,
          created_at: item.createdAt,
          batch_prefix: item.batchPrefix,
        } satisfies StructuredLogSpoolRecord),
      )
      fs.writeFileSync(tmpPath, `${lines.join("\n")}\n`, "utf8")
      fs.renameSync(tmpPath, filePath)
    },
  }
}

function nextStructuredLogBatch(
  queue: QueuedStructuredLog[],
  maxBatchSize: number,
): QueuedStructuredLog[] {
  const first = queue[0]
  if (!first) return []
  const key = structuredLogSendOptionsKey(first.sendOptions)
  const batch: QueuedStructuredLog[] = []
  for (const item of queue.slice(0, maxBatchSize)) {
    if (batch.length && structuredLogSendOptionsKey(item.sendOptions) !== key) break
    batch.push(item)
  }
  return batch
}

function structuredLogSendOptionsKey(opts: StructuredLogSendOptions): string {
  return safeStringify(opts)
}

function copyStructuredLogSendOptions(opts: StructuredLogSendOptions): StructuredLogSendOptions {
  return {
    format: opts.format,
    source: opts.source,
    service: opts.service,
    projectId: opts.projectId,
    pageId: opts.pageId,
    machineId: opts.machineId,
    repoId: opts.repoId,
    appId: opts.appId,
    processId: opts.processId,
    runId: opts.runId,
    traceId: opts.traceId,
    spanId: opts.spanId,
    parentSpanId: opts.parentSpanId,
    sessionId: opts.sessionId,
    releaseId: opts.releaseId,
    environment: opts.environment,
    agent: opts.agent,
    logUrl: opts.logUrl,
    metadata: isObjectRecord(opts.metadata) ? { ...opts.metadata } : undefined,
    sourceEventPrefix: opts.sourceEventPrefix,
  }
}

function redactStructuredLogSendOptions(opts: StructuredLogSendOptions): StructuredLogSendOptions {
  const redacted = redactSdkValue(copyStructuredLogSendOptions(opts))
  return isObjectRecord(redacted)
    ? copyStructuredLogSendOptions(redacted as StructuredLogSendOptions)
    : {}
}

function redactStructuredBatchPrefix(value: string): string {
  const generated = value.match(
    /^(.*)(:[A-Za-z0-9_-]+_transport_[A-Za-z0-9]+_[A-Za-z0-9]+:\d+)$/,
  )
  const userPrefix = generated?.[1]
  const suffix = generated?.[2]
  if (userPrefix !== undefined && suffix !== undefined) {
    return `${redactSdkString(userPrefix)}${suffix}`
  }
  return redactSdkString(value)
}

function loadStructuredSpoolSendOptions(
  value: unknown,
  fallback: StructuredLogSendOptions,
): StructuredLogSendOptions | undefined {
  if (value === undefined) return fallback
  if (!isObjectRecord(value)) return undefined
  if (!isValidStructuredSpoolSendOptions(value)) return undefined
  return redactStructuredLogSendOptions(value as StructuredLogSendOptions)
}

function isValidStructuredSpoolSendOptions(value: Record<string, unknown>): boolean {
  if (value.format !== undefined && !SDK_STRUCTURED_LOG_FORMATS.has(value.format)) {
    return false
  }
  if (value.source !== undefined && !SDK_STRUCTURED_LOG_SOURCES.has(value.source)) {
    return false
  }
  for (const key of SDK_STRUCTURED_LOG_STRING_OPTION_KEYS) {
    if (value[key] !== undefined && typeof value[key] !== "string") return false
  }
  return value.metadata === undefined || isObjectRecord(value.metadata)
}

const SDK_STRUCTURED_LOG_FORMATS = new Set<unknown>(["auto", "pino", "winston", "json"])

const SDK_STRUCTURED_LOG_SOURCES = new Set<unknown>([
  "sdk",
  "scanner",
  "node",
  "bun",
  "next",
  "vite",
  "cli",
  "build",
  "test",
  "mcp",
  "agent",
  "otel",
  "system",
  "pino",
  "winston",
  "structured",
])

const SDK_STRUCTURED_LOG_STRING_OPTION_KEYS = [
  "service",
  "projectId",
  "pageId",
  "machineId",
  "repoId",
  "appId",
  "processId",
  "runId",
  "traceId",
  "spanId",
  "parentSpanId",
  "sessionId",
  "releaseId",
  "environment",
  "agent",
  "logUrl",
  "sourceEventPrefix",
]

function structuredLogSpoolPath(opts: StructuredLoggerTransportOptions): string | undefined {
  if (opts.spoolFile) return opts.spoolFile
  if (!opts.spoolDirectory) return undefined
  const builtins = nodeBuiltins()
  const fileName = [
    "open-logs",
    sanitizeSpoolPathPart(opts.projectId ?? "default"),
    sanitizeSpoolPathPart(opts.format ?? "structured"),
    "structured-spool.jsonl",
  ].join("-")
  return builtins?.path.join(opts.spoolDirectory, fileName)
}

function nodeBuiltins(): { fs: NodeFsLike, path: NodePathLike } | undefined {
  const processLike = (globalThis as RuntimeGlobal).process
  const getBuiltinModule = processLike?.getBuiltinModule
  if (!getBuiltinModule) return undefined
  const fs = getBuiltinModule.call(processLike, "node:fs") as Partial<NodeFsLike> | undefined
  const path = getBuiltinModule.call(processLike, "node:path") as Partial<NodePathLike> | undefined
  if (
    !fs ||
    !path ||
    typeof fs.existsSync !== "function" ||
    typeof fs.mkdirSync !== "function" ||
    typeof fs.readFileSync !== "function" ||
    typeof fs.renameSync !== "function" ||
    typeof fs.unlinkSync !== "function" ||
    typeof fs.writeFileSync !== "function" ||
    typeof path.dirname !== "function" ||
    typeof path.join !== "function"
  ) {
    return undefined
  }
  return { fs: fs as NodeFsLike, path: path as NodePathLike }
}

function sanitizeSpoolPathPart(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "")
  return cleaned.slice(0, 80) || "default"
}

function redactStructuredSpoolRecord(value: unknown): unknown {
  return redactSdkValue(value)
}

function redactSdkValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === "string") return redactSdkString(value)
  if (typeof value !== "object" || depth >= 12) return value
  if (Array.isArray(value)) {
    const output: unknown[] = []
    let previousWasSensitiveFlag = false
    for (const item of value) {
      if (previousWasSensitiveFlag && typeof item === "string") {
        output.push("[REDACTED]")
        previousWasSensitiveFlag = false
        continue
      }
      const redacted = redactSdkValue(item, depth + 1)
      output.push(redacted)
      previousWasSensitiveFlag =
        typeof redacted === "string" && SDK_SENSITIVE_FLAG.test(redacted)
    }
    return output
  }
  const output: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] =
      SDK_SENSITIVE_KEY.test(key) && child !== null && child !== undefined
        ? "[REDACTED]"
        : redactSdkValue(child, depth + 1)
  }
  return output
}

const SDK_SENSITIVE_KEY =
  /(?:authorization|cookie|set-cookie|api[_-]?key|token|secret|password|passwd|pwd|private[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?secret|client[_-]?secret)/i

const SDK_SENSITIVE_FLAG =
  /^(?:authorization|auth|api[-_]?key|token|secret|password|passwd|pwd|private[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?secret|client[-_]?secret|--[A-Za-z0-9._-]*(?:authorization|api[-_]?key|token|secret|password|passwd|pwd|private[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?secret|client[-_]?secret)[A-Za-z0-9._-]*)$/i

const SDK_STRING_PATTERNS: Array<{
  pattern: RegExp
  replacement: string | ((match: string, ...args: string[]) => string)
}> = [
  {
    pattern: /\b(?:OPENLOGS|LOGS)[_-]?SECRET[_-]?CANARY[_-]?[A-Za-z0-9._-]*/gi,
    replacement: "[REDACTED]",
  },
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
    replacement: "Bearer [REDACTED]",
  },
  {
    pattern:
      /\b([A-Za-z0-9_-]*Authorization\b\s*(?::|=|\\?["']\s*:\s*\\?["']?)\s*\\?["']?Basic\s+)[A-Za-z0-9+/=._~-]+/gi,
    replacement: (_match, prefix: string) => `${prefix}[REDACTED]`,
  },
  {
    pattern: /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^@\s/?#]+@)(?=[^\s/?#]+)/g,
    replacement: (_match, scheme: string) => `${scheme}[REDACTED]@`,
  },
  {
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g,
    replacement: "[REDACTED]",
  },
  {
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replacement: "[REDACTED]",
  },
  {
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[REDACTED]",
  },
  {
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED]",
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replacement: "[REDACTED]",
  },
  {
    pattern:
      /\b(api[_-]?key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
    replacement: (_match, key: string) => `${key}=[REDACTED]`,
  },
  {
    pattern:
      /(--[A-Za-z0-9._-]*(?:authorization|api[-_]?key|token|secret|password|passwd|pwd|private[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?secret|client[-_]?secret)[A-Za-z0-9._-]*\s+)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
    replacement: (_match, prefix: string) => `${prefix}[REDACTED]`,
  },
  {
    pattern: /(--auth\s+)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
    replacement: (_match, prefix: string) => `${prefix}[REDACTED]`,
  },
  {
    pattern:
      /([?&](?:api[_-]?key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token|auth|code)=)[^&#\s]+/gi,
    replacement: (_match, prefix: string) => `${prefix}[REDACTED]`,
  },
]

function redactSdkString(input: string): string {
  let output = input
  for (const { pattern, replacement } of SDK_STRING_PATTERNS) {
    output = output.replace(pattern, (...args: string[]) => {
      if (typeof replacement === "function") return replacement(args[0] ?? "", ...args.slice(1))
      return replacement
    })
  }
  return output
}

function callbackFromArgs(
  encoding: string | ((error?: Error) => void) | undefined,
  callback: ((error?: Error) => void) | undefined,
): ((error?: Error) => void) | undefined {
  return typeof encoding === "function" ? encoding : callback
}

function callbackFromUnknownArgs(
  encoding: unknown,
  callback: unknown,
): (() => void) | undefined {
  if (typeof callback === "function") return callback as () => void
  if (typeof encoding === "function") return encoding as () => void
  return undefined
}

function normalizeWinstonLogArguments(
  infoOrLevel: Record<string, unknown> | string,
  callbackOrMessage: unknown,
  legacyArgs: unknown[],
): { info: Record<string, unknown>, callback?: () => void } {
  if (infoOrLevel && typeof infoOrLevel === "object") {
    return {
      info: { ...infoOrLevel },
      callback:
        typeof callbackOrMessage === "function"
          ? (callbackOrMessage as () => void)
          : undefined,
    }
  }

  const metadata = legacyArgs.find(
    (arg) => arg && typeof arg === "object" && !Array.isArray(arg),
  ) as Record<string, unknown> | undefined
  let callback: (() => void) | undefined
  for (let index = legacyArgs.length - 1; index >= 0; index -= 1) {
    const arg = legacyArgs[index]
    if (typeof arg === "function") {
      callback = arg as () => void
      break
    }
  }
  const normalized: Record<string, unknown> = metadata ? { ...metadata } : {}
  normalized.level = String(infoOrLevel)
  if (normalized.message === undefined && callbackOrMessage !== undefined) {
    normalized.message =
      callbackOrMessage instanceof Error
        ? callbackOrMessage.message
        : typeof callbackOrMessage === "string"
          ? callbackOrMessage
          : String(callbackOrMessage)
  }
  if (callbackOrMessage instanceof Error && normalized.stack === undefined) {
    normalized.stack = callbackOrMessage.stack
  }
  return { info: normalized, callback }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function hasStructuredProducerId(value: Record<string, unknown>): boolean {
  return (
    typeof value.id === "string" ||
    typeof value.event_id === "string" ||
    typeof value.eventId === "string" ||
    typeof value.source_event_id === "string" ||
    typeof value.log_id === "string" ||
    typeof value.logId === "string" ||
    typeof value._open_logs_event_id === "string"
  )
}

function chunkText(chunk: string | Uint8Array, decoder: TextDecoder): string {
  if (typeof chunk === "string") return chunk
  return decoder.decode(chunk, { stream: true })
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function noop(): void {}

async function sendRequestTelemetry(
  client: EventWriter,
  events: UniversalEvent[],
  waitForTelemetry: boolean | undefined,
): Promise<void> {
  const send = events.length === 1 ? client.pushEvent(events[0]!) : client.pushEvents(events)
  if (waitForTelemetry) {
    await send.catch(() => {})
    return
  }
  void send.catch(() => {})
}

function isCollectorRequest(requestUrl: string, collectorUrl: string): boolean {
  return requestUrl === collectorUrl || requestUrl.startsWith(`${collectorUrl}/`)
}

function randomHex(length: number): string {
  let output = ""
  while (output.length < length) output += Math.random().toString(16).slice(2)
  return output.slice(0, length)
}

function randomId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function defaultProcessId(processLike: ProcessLike): string {
  return `proc_${processLike.pid ?? "unknown"}_${Date.now().toString(36)}`
}

function safeCall(fn: (() => string) | undefined): string | undefined {
  try {
    return fn?.()
  } catch {
    return undefined
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return Object.prototype.toString.call(value)
  }
}

function runtimeName(): string {
  const runtime = globalThis as unknown as { Bun?: unknown; window?: unknown; process?: { versions?: { node?: string } } }
  if (runtime.Bun) return "bun"
  if (runtime.window) return "browser"
  if (runtime.process?.versions?.node) return "node"
  return "unknown"
}

async function readJson<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null) as unknown
  if (!res.ok) {
    const message = body && typeof body === "object" && "error" in body
      ? String((body as { error?: unknown }).error)
      : `Request failed: ${res.status} ${res.statusText}`
    throw new Error(message)
  }
  return body as T
}
