import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb } from "../db/index.ts";
import { runCommand } from "./command-runner.ts";
import {
  type EventCatalogBusEvent,
  clearTelemetryEventBusesForTests,
  subscribeEventCatalogEvents,
} from "./event-bus.ts";
import { replayRawEvents, verifyEventStore } from "./event-store.ts";
import { exportEventsToJson } from "./events.ts";
import { exportToCsv, exportToJson } from "./export.ts";
import { ingestLog } from "./ingest.ts";
import { REDACTED } from "./redaction.ts";
import { STORAGE_TABLES } from "./storage-sync.ts";
import { ingestUniversalEvent } from "./universal-ingest.ts";

describe("redaction canary validation", () => {
  test("keeps canaries out of raw, SQLite, exports, streams, and sync payloads", async () => {
    const db = createTestDb();
    const canary = "OPENLOGS_SECRET_CANARY_cross_surface_12345";
    const splitArgSecret = "splitSecretValue123";
    const envSecret = "envSecretValue456";
    const canaryCwd = mkdtempSync(join(tmpdir(), `${canary}-`));
    clearTelemetryEventBusesForTests();
    const stream = subscribeEventCatalogEvents({}, { maxQueue: 20 });

    try {
      ingestLog(db, {
        id: "redaction-canary-log",
        level: "error",
        source: "sdk",
        service: "redaction-canary",
        message: `request failed token=${canary}`,
        url: `https://example.test/callback?token=${canary}&ok=1`,
        stack_trace: `Error: leaked\nAuthorization: Bearer ${canary}`,
        metadata: {
          password: canary,
          headers: {
            authorization: `Bearer ${canary}`,
            cookie: `session=${canary}`,
          },
          nested: {
            api_key: canary,
            email: "canary@example.test",
          },
        },
      });
      const logStreamEvent = await nextStreamEvent(stream);

      ingestUniversalEvent(db, {
        type: "replay",
        event_id: "redaction-canary-replay",
        source: "browser",
        severity: "info",
        privacy: "sensitive",
        message: `input token=${canary}`,
        body: {
          replay: {
            url: `https://app.test/path?auth=${canary}`,
            interactions: [
              {
                type: "input",
                field: "password",
                value: canary,
              },
            ],
          },
          request: {
            headers: {
              authorization: `Bearer ${canary}`,
              cookie: `sid=${canary}`,
            },
          },
        },
        attributes: {
          privacy_tier: "sensitive",
          input_value: canary,
        },
      });
      const replayStreamEvent = await nextStreamEvent(stream);

      ingestUniversalEvent(db, {
        type: "agent",
        event_id: "redaction-canary-agent",
        source: "mcp",
        severity: "info",
        message: `tool call secret=${canary}`,
        body: {
          tool_call: {
            name: "fetch_secret",
            arguments: {
              prompt: `model should not see ${canary}`,
              api_key: canary,
            },
            result: {
              output: `Bearer ${canary}`,
            },
          },
          model: {
            provider: "test",
            input: `password=${canary}`,
          },
        },
        attributes: {
          category: "canary_agent_tool_model",
          token: canary,
          model_prompt: `token=${canary}`,
        },
      });
      const agentStreamEvent = await nextStreamEvent(stream);

      const commandResult = await runCommand(
        db,
        [
          process.execPath,
          "-e",
          [
            "process.stdout.write('OPENLOGS_SECRET_')",
            "setTimeout(() => process.stdout.write('CANARY_cross_surface_12345\\n'), 20)",
            "setTimeout(() => process.stderr.write('token=' + process.env.OPENLOGS_CANARY_ENV + '\\n'), 40)",
          ].join("; "),
          "--password",
          splitArgSecret,
        ],
        {
          cwd: canaryCwd,
          tee: false,
          service: "redaction-canary",
          environment: "test",
          env: {
            ...process.env,
            OPENLOGS_CANARY_ENV: envSecret,
          },
        },
      );
      const commandStreamEvents = await drainStreamEvents(stream);
      const commandStreamPayloads = JSON.stringify(
        commandStreamEvents.filter(
          (event) =>
            event.kind === "event" &&
            event.entry.run_id === commandResult.run_id,
        ),
      );

      const eventExport = collect((write) =>
        exportEventsToJson(db, { include_raw: true }, write),
      );
      const logJsonExport = collect((write) => exportToJson(db, {}, write));
      const logCsvExport = collect((write) => exportToCsv(db, {}, write));
      const surfaces: Record<string, string> = {
        raw_replay: JSON.stringify(replayRawEvents(db)),
        decoded_process_chunks: decodedProcessChunks(db),
        sqlite: dumpSqliteTables(db),
        event_export: eventExport,
        log_json_export: logJsonExport,
        log_csv_export: logCsvExport,
        stream_payloads: JSON.stringify([
          logStreamEvent,
          replayStreamEvent,
          agentStreamEvent,
          ...commandStreamEvents,
        ]),
        command_stream_payloads: commandStreamPayloads,
        sync_tables: dumpStorageSyncTables(db),
        command_result: JSON.stringify(commandResult),
      };

      expect(commandStreamPayloads).toContain(commandResult.run_id);
      expect(commandStreamPayloads).toContain("process_stream_chunk");
      for (const [name, dump] of Object.entries(surfaces)) {
        expect(dump, name).not.toContain(canary);
        expect(dump, name).not.toContain(splitArgSecret);
        expect(dump, name).not.toContain(envSecret);
        expect(dump, name).not.toContain("canary@example.test");
      }
      expect(Object.values(surfaces).join("\n")).toContain(REDACTED);
      expect(commandResult.command).toContain(REDACTED);
      expect(commandResult.cwd).toContain(REDACTED);
      expect(verifyEventStore(db).ok).toBe(true);
    } finally {
      await stream.return?.();
      rmSync(canaryCwd, { recursive: true, force: true });
    }
  });
});

async function nextStreamEvent(
  stream: AsyncIterableIterator<EventCatalogBusEvent>,
): Promise<EventCatalogBusEvent> {
  const result = await Promise.race([
    stream.next(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Timed out waiting for stream event")),
        1_000,
      ),
    ),
  ]);
  if (result.done) throw new Error("Expected stream event");
  return result.value;
}

async function drainStreamEvents(
  stream: AsyncIterableIterator<EventCatalogBusEvent>,
): Promise<EventCatalogBusEvent[]> {
  const events: EventCatalogBusEvent[] = [];
  while (true) {
    const event = await nextStreamEventOrNull(stream, 50);
    if (!event) return events;
    events.push(event);
  }
}

async function nextStreamEventOrNull(
  stream: AsyncIterableIterator<EventCatalogBusEvent>,
  timeoutMs: number,
): Promise<EventCatalogBusEvent | null> {
  const result = await Promise.race([
    stream.next(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
  if (result === null || result.done) return null;
  return result.value;
}

function collect(run: (write: (chunk: string) => void) => number): string {
  const chunks: string[] = [];
  run((chunk) => chunks.push(chunk));
  return chunks.join("");
}

function decodedProcessChunks(db: Database): string {
  return replayRawEvents(db)
    .flatMap((item) => {
      const chunk = item.event.body?.process_stream_chunk as
        | { data_base64?: unknown }
        | undefined;
      if (typeof chunk?.data_base64 !== "string") return [];
      return [Buffer.from(chunk.data_base64, "base64").toString("utf8")];
    })
    .join("\n");
}

function dumpSqliteTables(db: Database): string {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return JSON.stringify(
    Object.fromEntries(tables.map(({ name }) => [name, tableRows(db, name)])),
  );
}

function dumpStorageSyncTables(db: Database): string {
  return JSON.stringify(
    Object.fromEntries(
      STORAGE_TABLES.filter((table) => tableExists(db, table)).map((table) => [
        table,
        tableRows(db, table),
      ]),
    ),
  );
}

function tableExists(db: Database, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name: string } | undefined;
  return Boolean(row);
}

function tableRows(db: Database, table: string): unknown[] {
  return db.prepare(`SELECT * FROM ${quoteIdent(table)}`).all();
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}
