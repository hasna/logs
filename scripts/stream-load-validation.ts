#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface StreamValidationOptions {
  dataDir?: string;
  output?: string;
  keep: boolean;
  port?: number;
}

interface CommandResult {
  label: string;
  command: string[];
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

interface SseMessage {
  event: string;
  id: string | null;
  data: string;
}

interface ScenarioReport {
  name: string;
  expected_event_ids: string[];
  seen_event_ids: string[];
  duplicate_event_ids: string[];
  overflow_reasons: string[];
  assertions: string[];
  consumer_count?: number;
  expected_deliveries?: number;
  seen_deliveries?: number;
  per_consumer_seen_event_ids?: string[][];
}

interface StreamValidationReport {
  ok: boolean;
  validation_id: string;
  started_at: string;
  ended_at: string;
  data_dir: string;
  data_dir_retained: boolean;
  server: {
    base_url: string;
    port: number;
  };
  scenarios: ScenarioReport[];
  commands: CommandResult[];
  mcp: {
    transport: "stdio";
    command: string[];
    tool_calls: Array<{
      name: string;
      arguments: Record<string, unknown>;
      returned_event_count: number;
      returned_event_ids: string[];
      raw_event_ids: string[];
      overflow: unknown;
      cursor: string | null;
    }>;
    anchor_event_id: string;
    anchor_replayed: boolean;
    cursor: string | null;
    event_ids: string[];
    raw_event_ids: string[];
    overflow: unknown;
    missing_cursor_overflow: unknown;
  };
  doctor: Record<string, unknown>;
  counts: {
    event_records: number;
    event_segments: number;
    event_types: Record<string, number>;
  };
  report_file: string;
  assertions: string[];
}

const options = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();
const validationId = `stream-load-${Date.now()}`;
const dataDir = options.dataDir
  ? resolve(options.dataDir)
  : mkdtempSync(join(tmpdir(), "open-logs-stream-load-"));
const dbPath = join(dataDir, "logs.db");
const token = `stream-token-${Date.now()}`;
const commands: CommandResult[] = [];
const scenarios: ScenarioReport[] = [];
const assertions: string[] = [];

if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

const env = {
  ...process.env,
  HASNA_LOGS_DATA_DIR: dataDir,
  HASNA_LOGS_DB_PATH: dbPath,
  HASNA_LOGS_FSYNC: "0",
  HASNA_LOGS_API_TOKEN: token,
  HASNA_LOGS_STREAM_BUFFER_SIZE: "3",
  HASNA_LOGS_STREAM_TEST_HOOKS: "1",
  LOGS_DATA_DIR: "",
  LOGS_DB_PATH: "",
};

let server: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> | undefined;

try {
  const port = options.port ?? (await getFreePort());
  const baseUrl = `http://127.0.0.1:${port}`;
  server = Bun.spawn([process.execPath, "src/server/index.ts"], {
    cwd: repoRoot,
    env: { ...env, LOGS_PORT: String(port) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForHealth(baseUrl, server);

  const directScenario = await validateDirectSseLive(baseUrl);
  scenarios.push(directScenario);
  assertions.push(
    "direct generic SSE stream delivered every expected live event exactly once",
  );

  const cursorScenario = await validateLastEventIdSqliteCatchup(baseUrl);
  scenarios.push(cursorScenario);
  assertions.push(
    "Last-Event-ID buffer miss emitted an explicit overflow and recovered from SQLite",
  );

  const slowScenario = await validateSlowSubscriberOverflow(baseUrl);
  scenarios.push(slowScenario);
  assertions.push(
    "slow-subscriber overflow produced an explicit marker and no silent event gap",
  );

  const fanoutScenario = await validateMultiConsumerFanout(baseUrl);
  scenarios.push(fanoutScenario);
  assertions.push(
    "bounded multi-consumer API SSE fanout delivered every burst event to every consumer",
  );

  const cliRemoteScenario = await validateRemoteCliWatch(baseUrl);
  scenarios.push(cliRemoteScenario);
  assertions.push(
    "remote logs watch consumed the same generic event stream with cursor resume",
  );

  const cliLocalScenario = await validateLocalCliWatch();
  scenarios.push(cliLocalScenario);
  assertions.push(
    "local logs watch --events matched the persisted cursor semantics",
  );

  const mcp = await validateMcpEventWatch(baseUrl);
  assertions.push(
    "MCP event_watch returned post-cursor events and explicit unknown-cursor overflow",
  );

  const doctorResult = await runCli(
    "logs doctor segments",
    ["doctor", "segments", "--json"],
    30_000,
  );
  commands.push(doctorResult);
  const doctor = parseJsonObject(doctorResult.stdout);
  assert(
    Number(doctor.unindexed_raw_events ?? 0) === 0,
    "doctor segments reports zero unindexed raw events",
  );
  assertions.push("doctor segments reported zero unindexed raw events");

  const counts = readCounts(dbPath);
  assert(
    counts.event_records >= totalExpectedEvents(scenarios),
    "SQLite event_records includes all validation events",
  );
  assert(counts.event_segments > 0, "raw event segment files were created");
  assertions.push(
    "SQLite metadata and raw segment records were both populated",
  );

  const reportFile = resolve(
    options.output ?? join(dataDir, "stream-load-validation-report.json"),
  );
  const report: StreamValidationReport = {
    ok: true,
    validation_id: validationId,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    data_dir: dataDir,
    data_dir_retained:
      options.keep || Boolean(options.dataDir) || Boolean(options.output),
    server: { base_url: baseUrl, port },
    scenarios,
    commands,
    mcp,
    doctor,
    counts,
    report_file: reportFile,
    assertions,
  };

  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    [
      "Stream load validation passed.",
      `Report: ${reportFile}`,
      `Data dir: ${dataDir}${report.data_dir_retained ? " (retained)" : " (temporary)"}`,
      `Events observed across scenarios: ${totalSeenEvents(scenarios)}`,
      `Overflow reasons: ${unique(scenarios.flatMap((scenario) => scenario.overflow_reasons)).join(", ") || "none"}`,
    ].join("\n"),
  );
} catch (error) {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
} finally {
  if (server) {
    server.kill("SIGTERM");
    await server.exited.catch(() => {});
  }
  if (
    !options.keep &&
    !options.dataDir &&
    !options.output &&
    process.exitCode !== 1
  ) {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function validateDirectSseLive(baseUrl: string): Promise<ScenarioReport> {
  const traceId = `${validationId}-direct`;
  const expectedIds = Array.from(
    { length: 30 },
    (_, index) => `${validationId}-direct-${index}`,
  );
  const url = eventStreamUrl(baseUrl, {
    event_name: "event",
    type: "metric",
    trace_id: traceId,
    include_raw: "true",
  });
  const messages = await collectSseMessages(
    url,
    async () => {
      await postEvents(
        baseUrl,
        expectedIds.map((eventId, index) =>
          metricEvent(eventId, traceId, `direct live metric ${index}`, index),
        ),
      );
    },
    (seen) => containsAllEventIds(seen, expectedIds),
    15_000,
  );
  const seenIds = eventIdsFromMessages(messages);
  const duplicateIds = duplicateIdsIn(seenIds);
  assert(
    duplicateIds.length === 0,
    `direct SSE delivered duplicate IDs: ${duplicateIds.join(", ")}`,
  );
  assertContainsAll(seenIds, expectedIds, "direct SSE live stream");
  const rawIds = rawEventIdsFromMessages(messages);
  assertContainsAll(rawIds, expectedIds, "direct SSE include_raw envelopes");
  const overflowReasons = overflowReasonsFromMessages(messages);
  assert(
    overflowReasons.length === 0,
    `direct SSE should not overflow, saw ${overflowReasons.join(", ")}`,
  );
  return {
    name: "direct_sse_live_generic_event_channel",
    expected_event_ids: expectedIds,
    seen_event_ids: seenIds.filter((id) => expectedIds.includes(id)),
    duplicate_event_ids: duplicateIds,
    overflow_reasons: overflowReasons,
    assertions: [
      "all expected live metric IDs arrived",
      "include_raw returned matching raw envelopes",
      "no overflow was emitted during normal live delivery",
    ],
  };
}

async function validateLastEventIdSqliteCatchup(
  baseUrl: string,
): Promise<ScenarioReport> {
  const traceId = `${validationId}-cursor`;
  const anchorId = `${validationId}-cursor-anchor`;
  const expectedIds = Array.from(
    { length: 7 },
    (_, index) => `${validationId}-cursor-${index}`,
  );
  await postEvents(baseUrl, [
    metricEvent(anchorId, traceId, "cursor anchor", -1),
    ...expectedIds.map((eventId, index) =>
      metricEvent(eventId, traceId, `cursor catch-up metric ${index}`, index),
    ),
  ]);

  const url = eventStreamUrl(baseUrl, {
    event_name: "event",
    type: "metric",
    trace_id: traceId,
    last_event_id: anchorId,
  });
  const messages = await collectSseMessages(
    url,
    undefined,
    (seen) =>
      containsAllEventIds(seen, expectedIds) &&
      overflowReasonsFromMessages(seen).includes("buffer_miss_sqlite_catchup"),
    15_000,
  );
  const seenIds = eventIdsFromMessages(messages);
  const duplicateIds = duplicateIdsIn(seenIds);
  assert(!seenIds.includes(anchorId), "Last-Event-ID anchor was replayed");
  assert(
    duplicateIds.length === 0,
    `cursor catch-up delivered duplicate IDs: ${duplicateIds.join(", ")}`,
  );
  assertContainsAll(seenIds, expectedIds, "Last-Event-ID SQLite catch-up");
  const overflowReasons = overflowReasonsFromMessages(messages);
  assert(
    overflowReasons.includes("buffer_miss_sqlite_catchup"),
    "Last-Event-ID buffer miss did not emit buffer_miss_sqlite_catchup",
  );
  return {
    name: "last_event_id_buffer_miss_sqlite_catchup",
    expected_event_ids: expectedIds,
    seen_event_ids: seenIds.filter((id) => expectedIds.includes(id)),
    duplicate_event_ids: duplicateIds,
    overflow_reasons: overflowReasons,
    assertions: [
      "anchor event was not replayed",
      "all post-anchor events arrived from SQLite catch-up",
      "buffer_miss_sqlite_catchup overflow was explicit",
    ],
  };
}

async function validateSlowSubscriberOverflow(
  baseUrl: string,
): Promise<ScenarioReport> {
  const traceId = `${validationId}-slow`;
  const expectedIds = Array.from(
    { length: 14 },
    (_, index) => `${validationId}-slow-${index}`,
  );
  const url = eventStreamUrl(baseUrl, {
    event_name: "event",
    type: "metric",
    trace_id: traceId,
    debug_subscriber_queue: "1",
    debug_write_delay_ms: "20",
  });
  const messages = await collectSseMessages(
    url,
    async () => {
      await postEvents(
        baseUrl,
        expectedIds.map((eventId, index) =>
          metricEvent(
            eventId,
            traceId,
            `slow subscriber metric ${index}`,
            index,
          ),
        ),
      );
    },
    (seen) =>
      containsAllEventIds(seen, expectedIds) &&
      overflowReasonsFromMessages(seen).includes("subscriber_queue_overflow"),
    20_000,
  );
  const seenIds = eventIdsFromMessages(messages);
  const duplicateIds = duplicateIdsIn(seenIds);
  const overflowReasons = overflowReasonsFromMessages(messages);
  assertContainsAll(seenIds, expectedIds, "slow subscriber overflow recovery");
  assert(
    duplicateIds.length === 0,
    `slow subscriber stream delivered duplicate IDs: ${duplicateIds.join(", ")}`,
  );
  assert(
    overflowReasons.includes("subscriber_queue_overflow"),
    "slow subscriber did not emit subscriber_queue_overflow",
  );
  return {
    name: "slow_subscriber_overflow_sqlite_recovery",
    expected_event_ids: expectedIds,
    seen_event_ids: seenIds.filter((id) => expectedIds.includes(id)),
    duplicate_event_ids: duplicateIds,
    overflow_reasons: overflowReasons,
    assertions: [
      "forced queue pressure emitted subscriber_queue_overflow",
      "all burst events were still delivered through SQLite recovery",
      "no duplicate event IDs were observed",
    ],
  };
}

async function validateMultiConsumerFanout(
  baseUrl: string,
): Promise<ScenarioReport> {
  const traceId = `${validationId}-fanout`;
  const consumerCount = 8;
  const expectedIds = Array.from(
    { length: 80 },
    (_, index) => `${validationId}-fanout-${index}`,
  );
  const url = eventStreamUrl(baseUrl, {
    event_name: "event",
    type: "metric",
    trace_id: traceId,
  });
  let posted: Promise<void> | undefined;
  const postBurst = async () => {
    posted ??= sleep(250).then(() =>
      postEvents(
        baseUrl,
        expectedIds.map((eventId, index) =>
          metricEvent(eventId, traceId, `fanout burst metric ${index}`, index),
        ),
      ),
    );
    await posted;
  };
  const perConsumerMessages = await Promise.all(
    Array.from({ length: consumerCount }, () =>
      collectSseMessages(
        url,
        postBurst,
        (messages) => containsAllEventIds(messages, expectedIds),
        30_000,
      ),
    ),
  );
  await posted;
  const perConsumerSeenIds = perConsumerMessages.map((messages) =>
    eventIdsFromMessages(messages),
  );
  const perConsumerDuplicateIds = perConsumerSeenIds.flatMap((seenIds) =>
    duplicateIdsIn(seenIds),
  );
  const overflowReasons = unique(
    perConsumerMessages.flatMap((messages) =>
      overflowReasonsFromMessages(messages),
    ),
  );
  for (const [index, seenIds] of perConsumerSeenIds.entries()) {
    assertContainsAll(seenIds, expectedIds, `fanout SSE consumer ${index + 1}`);
  }
  assert(
    perConsumerDuplicateIds.length === 0,
    `fanout SSE consumers delivered duplicate IDs: ${unique(perConsumerDuplicateIds).join(", ")}`,
  );
  assert(
    overflowReasons.length === 0,
    `fanout SSE should not overflow, saw ${overflowReasons.join(", ")}`,
  );
  return {
    name: "bounded_multi_consumer_sse_fanout",
    expected_event_ids: expectedIds,
    seen_event_ids: expectedIds.filter((eventId) =>
      perConsumerSeenIds.every((seenIds) => seenIds.includes(eventId)),
    ),
    duplicate_event_ids: [],
    overflow_reasons: overflowReasons,
    consumer_count: consumerCount,
    expected_deliveries: consumerCount * expectedIds.length,
    seen_deliveries: perConsumerSeenIds.reduce(
      (sum, seenIds) =>
        sum + seenIds.filter((eventId) => expectedIds.includes(eventId)).length,
      0,
    ),
    per_consumer_seen_event_ids: perConsumerSeenIds.map((seenIds) =>
      seenIds.filter((eventId) => expectedIds.includes(eventId)),
    ),
    assertions: [
      "all consumer fetches were started before the burst was posted",
      "every consumer received every burst event",
      "no consumer saw duplicate burst event IDs",
      "no overflow was emitted during bounded fanout",
    ],
  };
}

async function validateRemoteCliWatch(
  baseUrl: string,
): Promise<ScenarioReport> {
  const traceId = `${validationId}-cli-remote`;
  const anchorId = `${validationId}-cli-remote-anchor`;
  const eventId = `${validationId}-cli-remote-event`;
  const expectedIds = [eventId];
  await postEvents(baseUrl, [
    metricEvent(anchorId, traceId, "remote CLI anchor", -1),
    metricEvent(eventId, traceId, "remote CLI catch-up event", 1),
  ]);

  const result = await runCli(
    "logs watch --server --once",
    [
      "watch",
      "--server",
      baseUrl,
      "--token",
      token,
      "--events",
      "--type",
      "metric",
      "--trace",
      traceId,
      "--last-event-id",
      anchorId,
      "--once",
      "--format",
      "json",
    ],
    15_000,
  );
  commands.push(result);
  const rows = parseCliJsonRows(result.stdout);
  const seenIds = rows
    .map((row) => (typeof row.event_id === "string" ? row.event_id : null))
    .filter((id): id is string => Boolean(id));
  const duplicateIds = duplicateIdsIn(seenIds);
  assertContainsAll(seenIds, expectedIds, "remote CLI watch");
  assert(!seenIds.includes(anchorId), "remote CLI watch replayed anchor event");
  return {
    name: "remote_cli_watch_server_cursor_resume",
    expected_event_ids: expectedIds,
    seen_event_ids: seenIds.filter((id) => expectedIds.includes(id)),
    duplicate_event_ids: duplicateIds,
    overflow_reasons: rows
      .filter((row) => row.type === "overflow")
      .map((row) => String(row.reason ?? "unknown")),
    assertions: [
      "logs watch --server printed the expected post-cursor event as JSON",
      "logs watch --server did not replay the anchor event",
    ],
  };
}

async function validateLocalCliWatch(): Promise<ScenarioReport> {
  const traceId = `${validationId}-cli-local`;
  const anchorId = `${validationId}-cli-local-anchor`;
  const eventId = `${validationId}-cli-local-event`;
  const expectedIds = [eventId];
  await runCli(
    "logs events push local anchor",
    [
      "events",
      "push",
      "--type",
      "metric",
      "--id",
      anchorId,
      "--source",
      "sdk",
      "--trace",
      traceId,
      "--message",
      "local CLI anchor",
    ],
    15_000,
  ).then((result) => commands.push(result));
  await runCli(
    "logs events push local event",
    [
      "events",
      "push",
      "--type",
      "metric",
      "--id",
      eventId,
      "--source",
      "sdk",
      "--trace",
      traceId,
      "--message",
      "local CLI post-cursor event",
    ],
    15_000,
  ).then((result) => commands.push(result));

  const result = await runCli(
    "logs watch --events --once",
    [
      "watch",
      "--events",
      "--type",
      "metric",
      "--trace",
      traceId,
      "--last-event-id",
      anchorId,
      "--once",
      "--format",
      "json",
    ],
    15_000,
  );
  commands.push(result);
  const rows = parseCliJsonRows(result.stdout);
  const seenIds = rows
    .map((row) => (typeof row.event_id === "string" ? row.event_id : null))
    .filter((id): id is string => Boolean(id));
  const duplicateIds = duplicateIdsIn(seenIds);
  assertContainsAll(seenIds, expectedIds, "local CLI watch");
  assert(!seenIds.includes(anchorId), "local CLI watch replayed anchor event");
  return {
    name: "local_cli_watch_sqlite_cursor_resume",
    expected_event_ids: expectedIds,
    seen_event_ids: seenIds.filter((id) => expectedIds.includes(id)),
    duplicate_event_ids: duplicateIds,
    overflow_reasons: [],
    assertions: [
      "logs watch --events printed the expected SQLite post-cursor event as JSON",
      "logs watch --events did not replay the anchor event",
    ],
  };
}

async function validateMcpEventWatch(
  baseUrl: string,
): Promise<StreamValidationReport["mcp"]> {
  const traceId = `${validationId}-mcp`;
  const anchorId = `${validationId}-mcp-anchor`;
  const firstEventId = `${validationId}-mcp-1`;
  const secondEventId = `${validationId}-mcp-2`;
  const expectedIds = [firstEventId, secondEventId];
  await postEvents(baseUrl, [
    metricEvent(anchorId, traceId, "MCP watch anchor", -1),
    metricEvent(firstEventId, traceId, "MCP watch first event", 1),
    metricEvent(secondEventId, traceId, "MCP watch second event", 2),
  ]);

  const mcpCommand = [
    process.execPath,
    "run",
    join(repoRoot, "src/mcp/index.ts"),
  ];
  const transport = new StdioClientTransport({
    command: mcpCommand[0] ?? process.execPath,
    args: mcpCommand.slice(1),
    env,
  });
  const client = new Client(
    { name: "open-logs-stream-validation", version: "0.0.0" },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
    const watchArguments = {
      event_type: "metric",
      trace_id: traceId,
      last_event_id: anchorId,
      limit: 10,
      include_raw: true,
    };
    const watchResult = await client.callTool({
      name: "event_watch",
      arguments: watchArguments,
    });
    const watched = JSON.parse(textContent(watchResult)) as {
      cursor: string | null;
      events: Array<{ event_id?: string; raw?: { event_id?: string } }>;
      overflow: unknown;
    };
    const eventIds = watched.events.map((event) => String(event.event_id));
    assertContainsAll(eventIds, expectedIds, "MCP event_watch cursor response");
    assert(
      !eventIds.includes(anchorId),
      "MCP event_watch replayed anchor event",
    );
    assert(
      watched.overflow === null,
      "MCP event_watch known cursor returned overflow",
    );
    const rawIds = watched.events
      .map((event) => event.raw?.event_id)
      .filter((id): id is string => Boolean(id));
    assertContainsAll(rawIds, expectedIds, "MCP event_watch raw envelopes");

    const missingArguments = {
      event_type: "metric",
      trace_id: traceId,
      last_event_id: `${validationId}-mcp-missing-cursor`,
      limit: 10,
    };
    const missingResult = await client.callTool({
      name: "event_watch",
      arguments: missingArguments,
    });
    const missing = JSON.parse(textContent(missingResult)) as {
      cursor: string | null;
      events: unknown[];
      overflow: unknown;
    };
    const overflow = missing.overflow as {
      reason?: string;
      last_event_id?: string;
    } | null;
    assert(missing.events.length === 0, "MCP missing cursor replayed history");
    assert(
      overflow?.reason === "last_event_id_unknown",
      "MCP missing cursor did not return last_event_id_unknown",
    );
    return {
      transport: "stdio",
      command: mcpCommand,
      tool_calls: [
        {
          name: "event_watch",
          arguments: watchArguments,
          returned_event_count: watched.events.length,
          returned_event_ids: eventIds,
          raw_event_ids: rawIds,
          overflow: watched.overflow,
          cursor: watched.cursor,
        },
        {
          name: "event_watch",
          arguments: missingArguments,
          returned_event_count: missing.events.length,
          returned_event_ids: [],
          raw_event_ids: [],
          overflow: missing.overflow,
          cursor: missing.cursor,
        },
      ],
      anchor_event_id: anchorId,
      anchor_replayed: eventIds.includes(anchorId),
      cursor: watched.cursor,
      event_ids: eventIds,
      raw_event_ids: rawIds,
      overflow: watched.overflow,
      missing_cursor_overflow: missing.overflow,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

function metricEvent(
  eventId: string,
  traceId: string,
  message: string,
  value: number,
): Record<string, unknown> {
  return {
    type: "metric",
    event_id: eventId,
    source: "sdk",
    severity: "info",
    trace_id: traceId,
    message,
    body: { value },
    attributes: {
      validation_id: validationId,
      scenario_trace_id: traceId,
    },
  };
}

async function postEvents(
  baseUrl: string,
  events: Record<string, unknown>[],
): Promise<void> {
  const response = await fetch(`${baseUrl}/api/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ events }),
  });
  if (!response.ok) {
    throw new Error(
      `POST /api/events failed ${response.status}: ${await response.text()}`,
    );
  }
}

function eventStreamUrl(
  baseUrl: string,
  query: Record<string, string>,
): string {
  const url = new URL(
    "/api/events/stream",
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  );
  for (const [key, value] of Object.entries(query))
    url.searchParams.set(key, value);
  return url.toString();
}

async function collectSseMessages(
  url: string,
  trigger: (() => Promise<void>) | undefined,
  predicate: (messages: SseMessage[]) => boolean,
  timeoutMs: number,
): Promise<SseMessage[]> {
  const controller = new AbortController();
  try {
    const responsePromise = fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (trigger) {
      await sleep(100);
      await trigger();
    }
    const response = await responsePromise;
    if (!response.ok)
      throw new Error(
        `SSE request failed ${response.status}: ${await response.text()}`,
      );
    const readPromise = readSseUntil(response.body, predicate, timeoutMs);
    return await readPromise;
  } finally {
    controller.abort();
  }
}

async function readSseUntil(
  body: ReadableStream<Uint8Array> | null,
  predicate: (messages: SseMessage[]) => boolean,
  timeoutMs: number,
): Promise<SseMessage[]> {
  if (!body) throw new Error("Expected SSE response body");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  const messages: SseMessage[] = [];
  let buffer = "";
  try {
    while (!predicate(messages)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Timed out waiting for SSE predicate. Messages: ${JSON.stringify(messages.slice(-10))}`,
        );
      }
      const chunk = await Promise.race([
        reader.read(),
        sleep(Math.min(remaining, 250)).then(() => null),
      ]);
      if (chunk === null) continue;
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let frameEnd = findSseFrameEnd(buffer);
      while (frameEnd >= 0) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(frameEnd).replace(/^\r?\n\r?\n?/, "");
        const message = parseSseFrame(frame);
        if (message) messages.push(message);
        if (predicate(messages)) break;
        frameEnd = findSseFrameEnd(buffer);
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (!predicate(messages)) {
    throw new Error(
      `SSE stream ended before predicate matched. Messages: ${JSON.stringify(messages.slice(-10))}`,
    );
  }
  return messages;
}

function findSseFrameEnd(buffer: string): number {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

function parseSseFrame(frame: string): SseMessage | null {
  let event = "message";
  let id: string | null = null;
  const data: string[] = [];
  for (const rawLine of frame.split(/\r?\n/)) {
    if (!rawLine || rawLine.startsWith(":")) continue;
    const separator = rawLine.indexOf(":");
    const field = separator >= 0 ? rawLine.slice(0, separator) : rawLine;
    const value =
      separator >= 0 ? rawLine.slice(separator + 1).replace(/^ /, "") : "";
    if (field === "event") event = value || "message";
    if (field === "id") id = value;
    if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  return { event, id, data: data.join("\n") };
}

function eventIdsFromMessages(messages: SseMessage[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (message.event === "overflow") continue;
    const parsed = parseJsonObjectOrNull(message.data);
    const eventId =
      typeof parsed?.event_id === "string" ? parsed.event_id : message.id;
    if (eventId) ids.push(eventId);
  }
  return ids;
}

function rawEventIdsFromMessages(messages: SseMessage[]): string[] {
  const ids: string[] = [];
  for (const message of messages) {
    if (message.event === "overflow") continue;
    const parsed = parseJsonObjectOrNull(message.data);
    const raw = parsed?.raw;
    if (
      raw &&
      typeof raw === "object" &&
      typeof (raw as Record<string, unknown>).event_id === "string"
    ) {
      ids.push(String((raw as Record<string, unknown>).event_id));
    }
  }
  return ids;
}

function overflowReasonsFromMessages(messages: SseMessage[]): string[] {
  const reasons: string[] = [];
  for (const message of messages) {
    if (message.event !== "overflow") continue;
    const parsed = parseJsonObjectOrNull(message.data);
    if (typeof parsed?.reason === "string") reasons.push(parsed.reason);
  }
  return reasons;
}

function containsAllEventIds(
  messages: SseMessage[],
  expectedIds: string[],
): boolean {
  const seen = new Set(eventIdsFromMessages(messages));
  return expectedIds.every((eventId) => seen.has(eventId));
}

async function runCli(
  label: string,
  args: string[],
  timeoutMs: number,
): Promise<CommandResult> {
  const command = [process.execPath, "src/cli/index.ts", ...args];
  const child = Bun.spawn(command, {
    cwd: repoRoot,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return await waitForProcess(label, command, child, timeoutMs);
}

async function waitForProcess(
  label: string,
  command: string[],
  child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>,
  timeoutMs: number,
): Promise<CommandResult> {
  const started = performance.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  const exitCode = await child.exited;
  clearTimeout(timer);
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const result = {
    label,
    command,
    exit_code: exitCode,
    stdout,
    stderr,
    duration_ms: Math.max(0, Math.round(performance.now() - started)),
  };
  if (timedOut) throw new Error(`${label} timed out after ${timeoutMs}ms`);
  if (exitCode !== 0) {
    throw new Error(
      `${label} failed with exit ${exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
    );
  }
  return result;
}

async function waitForHealth(
  baseUrl: string,
  child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>,
): Promise<void> {
  const started = performance.now();
  while (performance.now() - started < 8_000) {
    const exited = await Promise.race([
      child.exited.then((code) => ({ code })),
      sleep(50).then(() => null),
    ]);
    if (exited)
      throw new Error(`Server exited before health check: ${exited.code}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Retry until timeout.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${baseUrl}/health`);
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to allocate free port"));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

function parseArgs(args: string[]): StreamValidationOptions {
  const result: StreamValidationOptions = { keep: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--keep") {
      result.keep = true;
      continue;
    }
    if (arg === "--data-dir") {
      index += 1;
      result.dataDir = requireValue(args, index, arg);
      continue;
    }
    if (arg === "--output") {
      index += 1;
      result.output = requireValue(args, index, arg);
      continue;
    }
    if (arg === "--port") {
      index += 1;
      result.port = Number(requireValue(args, index, arg));
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: bun scripts/stream-load-validation.ts [--keep] [--data-dir <dir>] [--output <file>] [--port <n>]",
          "",
          "Runs a real stream validation lab over API SSE, CLI watch, local SQLite watch, MCP event_watch, and doctor checks.",
        ].join("\n"),
      );
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return result;
}

function requireValue(args: string[], index: number, label: string): string {
  const value = args[index];
  if (!value) throw new Error(`${label} requires a value`);
  return value;
}

function parseJsonLines(stdout: string): Record<string, unknown>[] {
  return stdout
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => parseJsonObject(line));
}

function parseCliJsonRows(stdout: string): Record<string, unknown>[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (item): item is Record<string, unknown> =>
          Boolean(item) && typeof item === "object" && !Array.isArray(item),
      );
    }
    if (parsed && typeof parsed === "object") {
      return [parsed as Record<string, unknown>];
    }
  } catch {
    return parseJsonLines(stdout);
  }
  return [];
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object: ${value}`);
  }
  return parsed as Record<string, unknown>;
}

function parseJsonObjectOrNull(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function textContent(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  return content?.[0]?.text ?? "";
}

function readCounts(dbFile: string): StreamValidationReport["counts"] {
  const db = new Database(dbFile, { readonly: true });
  try {
    const typeRows = db
      .prepare(
        "SELECT event_type, COUNT(*) AS count FROM event_records GROUP BY event_type ORDER BY event_type",
      )
      .all() as Array<{ event_type: string; count: number }>;
    return {
      event_records: countRows(db, "event_records"),
      event_segments: countRows(db, "event_segments"),
      event_types: Object.fromEntries(
        typeRows.map((row) => [row.event_type, row.count]),
      ),
    };
  } finally {
    db.close();
  }
}

function countRows(db: Database, table: string): number {
  return Number(
    (
      db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number;
      }
    ).count,
  );
}

function assertContainsAll(
  actualIds: string[],
  expectedIds: string[],
  label: string,
): void {
  const actual = new Set(actualIds);
  const missing = expectedIds.filter((eventId) => !actual.has(eventId));
  assert(
    missing.length === 0,
    `${label} missing event IDs: ${missing.join(", ")}`,
  );
}

function duplicateIdsIn(ids: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates].sort();
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function totalExpectedEvents(items: ScenarioReport[]): number {
  return items.reduce((sum, item) => sum + item.expected_event_ids.length, 0);
}

function totalSeenEvents(items: ScenarioReport[]): number {
  return items.reduce((sum, item) => sum + item.seen_event_ids.length, 0);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? `${error.message}\n${error.stack ?? ""}`
    : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
