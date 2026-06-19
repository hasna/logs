import { describe, expect, it } from "bun:test";
import { createTestDb } from "../db/index.ts";
import {
  appendRawEvent,
  readRawEvent,
  rebuildEventStoreIndex,
  verifyEventStore,
} from "./event-store.ts";
import { getEvent, searchEvents } from "./events.ts";
import { ingestUniversalEvent } from "./universal-ingest.ts";

describe("universal event ingest", () => {
  it("persists non-log events raw-first, indexes metadata, redacts secrets, and writes span/trace projections", () => {
    const db = createTestDb();
    const secret = "OPENLOGS_SECRET_CANARY_universal_event_12345";
    const result = ingestUniversalEvent(db, {
      type: "span",
      event_id: "universal-span-1",
      source_event_id: "producer-span-1",
      event_time: "2026-06-16T08:00:00.000Z",
      source: "otel",
      severity: "info",
      message: `GET /api/items token=${secret}`,
      trace_id: "trace-universal",
      span_id: "span-universal",
      parent_span_id: "span-parent",
      process_id: "proc-universal",
      run_id: "run-universal",
      environment: "test",
      body: { route: "/api/items", Authorization: `Bearer ${secret}` },
      attributes: {
        name: "GET /api/items",
        operation: "http.server",
        duration_ms: 42,
        password: secret,
      },
    });

    expect(result.inserted).toBe(true);
    expect(result.event.event_id).toBe("universal-span-1");
    expect(result.event.event_type).toBe("span");
    expect(result.event.trace_id).toBe("trace-universal");

    const raw = readRawEvent(db, "universal-span-1");
    expect(JSON.stringify(raw)).not.toContain(secret);
    expect(JSON.stringify(raw)).toContain("[REDACTED]");

    const event = getEvent(db, "universal-span-1");
    expect(event?.raw?.event_id).toBe("universal-span-1");
    expect(event?.raw?.message).toContain("[REDACTED]");

    const span = db
      .prepare(
        "SELECT id, trace_id, operation, duration_ms FROM spans WHERE id = ?",
      )
      .get("span-universal") as {
      id: string;
      trace_id: string;
      operation: string;
      duration_ms: number;
    } | null;
    expect(span).toEqual({
      id: "span-universal",
      trace_id: "trace-universal",
      operation: "http.server",
      duration_ms: 42,
    });

    const trace = db
      .prepare("SELECT id, root_span_id FROM traces WHERE id = ?")
      .get("trace-universal") as { id: string; root_span_id: string } | null;
    expect(trace).toEqual({
      id: "trace-universal",
      root_span_id: "span-universal",
    });

    const rows = searchEvents(db, {
      event_type: "span",
      source: "otel",
      trace_id: "trace-universal",
      text: "items",
    });
    expect(rows.map((row) => row.event_id)).toEqual(["universal-span-1"]);
    expect(verifyEventStore(db).ok).toBe(true);
  });

  it("deduplicates retries by event_id without appending another raw record", () => {
    const db = createTestDb();
    const first = ingestUniversalEvent(db, {
      type: "metric",
      event_id: "universal-metric-1",
      source: "sdk",
      message: "first",
      body: { value: 1 },
    });
    const second = ingestUniversalEvent(db, {
      type: "metric",
      event_id: "universal-metric-1",
      source: "sdk",
      message: "retry",
      body: { value: 2 },
    });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(
      searchEvents(db, { event_id: "universal-metric-1", include_raw: true }),
    ).toHaveLength(1);
    const verification = verifyEventStore(db);
    expect(verification.ok).toBe(true);
    expect(verification.checked_raw_events).toBe(1);
  });

  it("redacts top-level producer IDs and deduplicates retries by source_event_id", () => {
    const db = createTestDb();
    const secret = "OPENLOGS_SECRET_CANARY_source_event_12345";
    const sourceEventId = `fetch?token=${secret}`;
    const first = ingestUniversalEvent(db, {
      type: "network",
      source: "browser",
      source_event_id: sourceEventId,
      message: "fetch failed",
    });
    const second = ingestUniversalEvent(db, {
      type: "network",
      source: "browser",
      source_event_id: sourceEventId,
      message: "retry",
    });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.event.event_id).toBe(first.event.event_id);

    const raw = readRawEvent(db, first.event.event_id);
    expect(JSON.stringify(raw)).not.toContain(secret);
    expect(raw?.source_event_id).toContain("[REDACTED]");
    const verification = verifyEventStore(db);
    expect(verification.ok).toBe(true);
    expect(verification.checked_raw_events).toBe(1);
  });

  it("creates exception issue projections", () => {
    const db = createTestDb();
    ingestUniversalEvent(db, {
      type: "exception",
      event_id: "universal-exception-1",
      source: "node",
      severity: "error",
      message: "TypeError: failed universal ingest",
      attributes: { service: "api", stack_trace: "TypeError\n at handler" },
    });

    const issue = db
      .prepare("SELECT level, service, count FROM issues WHERE service = ?")
      .get("api") as { level: string; service: string; count: number } | null;
    expect(issue).toEqual({ level: "error", service: "api", count: 1 });
  });

  it("projects nested artifact body IDs through live ingest and raw rebuild", () => {
    const db = createTestDb();
    ingestUniversalEvent(db, {
      type: "artifact",
      event_id: "universal-artifact-body-event",
      source: "ci",
      body: {
        artifact: {
          artifact_id: "artifact-body-id",
          artifact_type: "source_map",
          path: "dist/app.js.map",
          content_hash: "sha256:body",
          size_bytes: 42,
          source_map: {
            source_map_artifact_id: "artifact-body-id",
            source_map_path: "dist/app.js.map",
            javascript_path: "dist/app.js",
            javascript_artifact_id: "artifact-js-id",
            version: 3,
            validation_status: "parsed",
            source_count: 1,
            names_count: 1,
            mappings_length: 4,
            has_sources_content: false,
            sources: [
              {
                ordinal: 0,
                source_path: "src/app.ts",
                has_content: false,
                content_hash: null,
              },
            ],
            source_storage_policy: "paths_and_hashes_only",
          },
        },
      },
    });

    const record = db
      .prepare(
        "SELECT artifact_id, metadata FROM event_records WHERE event_id = ?",
      )
      .get("universal-artifact-body-event") as {
      artifact_id: string | null;
      metadata: string;
    } | null;
    expect(record?.artifact_id).toBe("artifact-body-id");
    expect(JSON.parse(record?.metadata ?? "{}")).toMatchObject({
      artifact_id: "artifact-body-id",
      artifact_type: "source_map",
      path: "dist/app.js.map",
    });
    expect(
      db
        .prepare("SELECT path FROM artifacts WHERE id = ?")
        .get("artifact-body-id"),
    ).toEqual({ path: "dist/app.js.map" });
    expect(
      db
        .prepare(
          "SELECT javascript_path, validation_status, source_count FROM source_maps WHERE id = ?",
        )
        .get("artifact-body-id"),
    ).toEqual({
      javascript_path: "dist/app.js",
      validation_status: "parsed",
      source_count: 1,
    });
    expect(
      db
        .prepare(
          "SELECT source_path FROM source_map_sources WHERE source_map_id = ?",
        )
        .get("artifact-body-id"),
    ).toEqual({ source_path: "src/app.ts" });

    db.run("DELETE FROM event_records");
    db.run("DELETE FROM source_map_sources");
    db.run("DELETE FROM source_maps");
    db.run("DELETE FROM artifacts");
    const rebuilt = rebuildEventStoreIndex(db);
    expect(rebuilt.errors).toEqual([]);
    expect(rebuilt.skipped_events).toBe(0);
    expect(
      db
        .prepare("SELECT path FROM artifacts WHERE id = ?")
        .get("artifact-body-id"),
    ).toEqual({ path: "dist/app.js.map" });
    expect(
      db
        .prepare(
          "SELECT javascript_path, validation_status, source_count FROM source_maps WHERE id = ?",
        )
        .get("artifact-body-id"),
    ).toEqual({
      javascript_path: "dist/app.js",
      validation_status: "parsed",
      source_count: 1,
    });
    expect(verifyEventStore(db).ok).toBe(true);
  });

  it("sanitizes universal source-map payloads before raw append and rebuild", () => {
    const db = createTestDb();
    const absoluteRoot = "/tmp/open-logs-universal-source-map-root";
    const sourceContentCanary =
      "OPENLOGS_UNIVERSAL_SOURCE_MAP_CONTENT_SHOULD_NOT_PERSIST";
    const rawJsonCanary = "OPENLOGS_UNIVERSAL_SOURCE_MAP_RAW_JSON";
    const mappingsCanary = "OPENLOGS_UNIVERSAL_SOURCE_MAP_MAPPINGS";
    const validationErrorCanary =
      "OPENLOGS_UNIVERSAL_SOURCE_MAP_VALIDATION_ERROR";
    const markerBypassPath = `[source-map-host_path:${absoluteRoot}/src/marker.ts]`;
    const markerBypassValidationError = `[source-map-validation-error:Parse failed at ${absoluteRoot}/src/root.ts: ${validationErrorCanary}]`;

    const result = ingestUniversalEvent(db, {
      type: "artifact",
      event_id: "universal-artifact-source-map-adversarial",
      source: "ci",
      body: {
        artifact: {
          artifact_id: "artifact-source-map-adversarial",
          artifact_type: "source_map",
          path: "dist/app.js.map",
          content_hash: "sha256:adversarial",
          size_bytes: 123,
          source_map: {
            source_map_artifact_id: "artifact-source-map-adversarial",
            source_map_path: "dist/app.js.map",
            javascript_path: "dist/app.js",
            version: 3,
            file: `${absoluteRoot}/dist/app.js`,
            sourceRoot: absoluteRoot,
            sources: [
              {
                ordinal: 0,
                source_path: `${absoluteRoot}/src/app.ts`,
                content: sourceContentCanary,
              },
              {
                ordinal: 0,
                source_path: "../outside.ts",
                content: `${sourceContentCanary}:duplicate`,
              },
            ],
            sourcesContent: [
              sourceContentCanary,
              `${sourceContentCanary}:duplicate`,
            ],
            names: ["boot"],
            mappings: mappingsCanary,
            raw_json: rawJsonCanary,
            validation_error: `Parse failed at ${absoluteRoot}/src/app.ts: ${validationErrorCanary}`,
          },
        },
      },
    });

    expect(result.inserted).toBe(true);
    const raw = readRawEvent(db, "universal-artifact-source-map-adversarial");
    const rawText = JSON.stringify(raw);
    expect(rawText).not.toContain(sourceContentCanary);
    expect(rawText).not.toContain(rawJsonCanary);
    expect(rawText).not.toContain(mappingsCanary);
    expect(rawText).not.toContain(validationErrorCanary);
    expect(rawText).not.toContain(absoluteRoot);
    expect(rawText).not.toContain("sourcesContent");
    expect(rawText).not.toContain("raw_json");
    expect(rawText).not.toContain('"mappings"');
    expect(rawText).toContain("mappings_length");
    expect(rawText).toContain("[source-map-host_path:");

    const record = db
      .prepare("SELECT metadata FROM event_records WHERE event_id = ?")
      .get("universal-artifact-source-map-adversarial") as
      | { metadata: string }
      | undefined;
    const metadataText = record?.metadata ?? "";
    expect(metadataText).not.toContain(sourceContentCanary);
    expect(metadataText).not.toContain(rawJsonCanary);
    expect(metadataText).not.toContain(mappingsCanary);
    expect(metadataText).not.toContain(validationErrorCanary);
    expect(metadataText).not.toContain(absoluteRoot);

    const sourceMap = db
      .prepare(
        "SELECT file, source_root, javascript_path, validation_status, validation_error, source_count, has_sources_content FROM source_maps WHERE id = ?",
      )
      .get("artifact-source-map-adversarial") as
      | {
          file: string;
          source_root: string;
          javascript_path: string;
          validation_status: string;
          validation_error: string | null;
          source_count: number;
          has_sources_content: number;
        }
      | undefined;
    expect(sourceMap).toMatchObject({
      javascript_path: "dist/app.js",
      validation_status: "parsed",
      source_count: 2,
      has_sources_content: 1,
    });
    expect(sourceMap?.file).toStartWith("[source-map-host_path:");
    expect(sourceMap?.source_root).toStartWith("[source-map-host_path:");
    expect(sourceMap?.validation_error).toStartWith(
      "[source-map-validation-error:",
    );

    const sourceRows = db
      .prepare(
        "SELECT id, ordinal, source_path, has_content, content_hash FROM source_map_sources WHERE source_map_id = ? ORDER BY ordinal",
      )
      .all("artifact-source-map-adversarial") as Array<{
      id: string;
      ordinal: number;
      source_path: string;
      has_content: number;
      content_hash: string | null;
    }>;
    expect(sourceRows).toHaveLength(2);
    expect(sourceRows.map((row) => row.ordinal)).toEqual([0, 1]);
    expect(sourceRows[0]?.id).toStartWith("srcmap_source_");
    expect(sourceRows[0]?.source_path).toStartWith("[source-map-host_path:");
    expect(sourceRows[1]?.source_path).toStartWith(
      "[source-map-unsafe_relative:",
    );
    for (const row of sourceRows) {
      expect(row.has_content).toBe(1);
      expect(row.content_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(row)).not.toContain(sourceContentCanary);
      expect(JSON.stringify(row)).not.toContain(absoluteRoot);
    }

    ingestUniversalEvent(db, {
      type: "artifact",
      event_id: "universal-artifact-root-source-map-adversarial",
      source: "ci",
      body: {
        artifact: {
          artifact_id: "artifact-root-source-map-adversarial",
          artifact_type: "source_map",
          path: `${absoluteRoot}/dist/root.js.map`,
          content_hash: "sha256:root-adversarial",
          size_bytes: 456,
          version: 3,
          file: `${absoluteRoot}/dist/root.js`,
          sourceRoot: absoluteRoot,
          sources: [markerBypassPath],
          sourcesContent: [`${sourceContentCanary}:root`],
          names: ["root"],
          mappings: mappingsCanary,
          raw_json: rawJsonCanary,
          validation_error: markerBypassValidationError,
        },
      },
    });

    const rootRaw = readRawEvent(
      db,
      "universal-artifact-root-source-map-adversarial",
    );
    const rootRawText = JSON.stringify(rootRaw);
    expect(rootRawText).not.toContain(sourceContentCanary);
    expect(rootRawText).not.toContain(rawJsonCanary);
    expect(rootRawText).not.toContain(mappingsCanary);
    expect(rootRawText).not.toContain(validationErrorCanary);
    expect(rootRawText).not.toContain(markerBypassPath);
    expect(rootRawText).not.toContain(markerBypassValidationError);
    expect(rootRawText).not.toContain(absoluteRoot);
    expect(rootRawText).not.toContain("sourcesContent");
    expect(rootRawText).not.toContain("raw_json");
    expect(rootRawText).not.toContain('"mappings"');
    expect(rootRawText).toContain("[source-map-host_path:");
    expect(rootRawText).toContain("[source-map-validation-error:");

    const rootRecord = db
      .prepare("SELECT metadata FROM event_records WHERE event_id = ?")
      .get("universal-artifact-root-source-map-adversarial") as
      | { metadata: string }
      | undefined;
    const rootMetadataText = rootRecord?.metadata ?? "";
    expect(rootMetadataText).not.toContain(sourceContentCanary);
    expect(rootMetadataText).not.toContain(rawJsonCanary);
    expect(rootMetadataText).not.toContain(mappingsCanary);
    expect(rootMetadataText).not.toContain(validationErrorCanary);
    expect(rootMetadataText).not.toContain(markerBypassPath);
    expect(rootMetadataText).not.toContain(markerBypassValidationError);
    expect(rootMetadataText).not.toContain(absoluteRoot);

    const rootSourceMap = db
      .prepare(
        "SELECT source_map_path, file, source_root, validation_error, source_count, has_sources_content FROM source_maps WHERE id = ?",
      )
      .get("artifact-root-source-map-adversarial") as
      | {
          source_map_path: string;
          file: string;
          source_root: string;
          validation_error: string | null;
          source_count: number;
          has_sources_content: number;
        }
      | undefined;
    expect(rootSourceMap).toMatchObject({
      source_count: 1,
      has_sources_content: 1,
    });
    expect(rootSourceMap?.source_map_path).toStartWith(
      "[source-map-host_path:",
    );
    expect(rootSourceMap?.file).toStartWith("[source-map-host_path:");
    expect(rootSourceMap?.source_root).toStartWith("[source-map-host_path:");
    expect(rootSourceMap?.validation_error).toStartWith(
      "[source-map-validation-error:",
    );
    expect(rootSourceMap?.validation_error).not.toContain(
      validationErrorCanary,
    );

    const rootSourceRow = db
      .prepare(
        "SELECT source_path FROM source_map_sources WHERE source_map_id = ?",
      )
      .get("artifact-root-source-map-adversarial") as
      | { source_path: string }
      | undefined;
    expect(rootSourceRow?.source_path).toStartWith(
      "[source-map-unsafe_marker:",
    );
    expect(rootSourceRow?.source_path).not.toContain(absoluteRoot);

    ingestUniversalEvent(db, {
      type: "artifact",
      event_id: "universal-attributes-source-map-adversarial",
      source: "ci",
      artifact_id: "artifact-attributes-source-map-adversarial",
      attributes: {
        artifact_id: "artifact-attributes-source-map-adversarial",
        artifact_type: "source_map",
        path: `${absoluteRoot}/dist/attrs.js.map`,
        content_hash: "sha256:attrs-adversarial",
        size_bytes: 789,
        version: 3,
        file: `${absoluteRoot}/dist/attrs.js`,
        sourceRoot: absoluteRoot,
        sources: [markerBypassPath],
        sourcesContent: [`${sourceContentCanary}:attrs`],
        names: ["attrs"],
        mappings: mappingsCanary,
        raw_json: rawJsonCanary,
        validation_error: markerBypassValidationError,
      },
    });

    const attrsRaw = readRawEvent(
      db,
      "universal-attributes-source-map-adversarial",
    );
    const attrsRawText = JSON.stringify(attrsRaw);
    expect(attrsRawText).not.toContain(sourceContentCanary);
    expect(attrsRawText).not.toContain(rawJsonCanary);
    expect(attrsRawText).not.toContain(mappingsCanary);
    expect(attrsRawText).not.toContain(validationErrorCanary);
    expect(attrsRawText).not.toContain(markerBypassPath);
    expect(attrsRawText).not.toContain(markerBypassValidationError);
    expect(attrsRawText).not.toContain(absoluteRoot);
    expect(attrsRawText).not.toContain("sourcesContent");
    expect(attrsRawText).not.toContain("raw_json");
    expect(attrsRawText).not.toContain('"mappings"');

    const attrsRecord = db
      .prepare("SELECT metadata FROM event_records WHERE event_id = ?")
      .get("universal-attributes-source-map-adversarial") as
      | { metadata: string }
      | undefined;
    const attrsMetadataText = attrsRecord?.metadata ?? "";
    expect(attrsMetadataText).not.toContain(sourceContentCanary);
    expect(attrsMetadataText).not.toContain(rawJsonCanary);
    expect(attrsMetadataText).not.toContain(mappingsCanary);
    expect(attrsMetadataText).not.toContain(validationErrorCanary);
    expect(attrsMetadataText).not.toContain(markerBypassPath);
    expect(attrsMetadataText).not.toContain(markerBypassValidationError);
    expect(attrsMetadataText).not.toContain(absoluteRoot);

    const attrsSourceMap = db
      .prepare(
        "SELECT source_map_path, file, source_root, validation_error, source_count, has_sources_content FROM source_maps WHERE id = ?",
      )
      .get("artifact-attributes-source-map-adversarial") as
      | {
          source_map_path: string;
          file: string;
          source_root: string;
          validation_error: string | null;
          source_count: number;
          has_sources_content: number;
        }
      | undefined;
    expect(attrsSourceMap).toMatchObject({
      source_count: 1,
      has_sources_content: 1,
    });
    expect(attrsSourceMap?.source_map_path).toStartWith(
      "[source-map-host_path:",
    );
    expect(attrsSourceMap?.file).toStartWith("[source-map-host_path:");
    expect(attrsSourceMap?.source_root).toStartWith("[source-map-host_path:");
    expect(attrsSourceMap?.validation_error).toStartWith(
      "[source-map-validation-error:",
    );

    const attrsSourceRow = db
      .prepare(
        "SELECT source_path FROM source_map_sources WHERE source_map_id = ?",
      )
      .get("artifact-attributes-source-map-adversarial") as
      | { source_path: string }
      | undefined;
    expect(attrsSourceRow?.source_path).toStartWith(
      "[source-map-unsafe_marker:",
    );
    expect(attrsSourceRow?.source_path).not.toContain(absoluteRoot);

    ingestUniversalEvent(db, {
      type: "artifact",
      event_id: "universal-attributes-shape-source-map-adversarial",
      source: "ci",
      artifact_id: "artifact-attributes-shape-source-map-adversarial",
      attributes: {
        source_map_path: "dist/shape.js.map",
        version: 3,
        file: `${absoluteRoot}/dist/shape.js`,
        sourceRoot: absoluteRoot,
        sources: [`${absoluteRoot}/src/shape.ts`],
        sourcesContent: [`${sourceContentCanary}:shape`],
        names: ["shape"],
        mappings: mappingsCanary,
        raw_json: rawJsonCanary,
        validation_error: markerBypassValidationError,
      },
    });

    const attrsShapeRaw = readRawEvent(
      db,
      "universal-attributes-shape-source-map-adversarial",
    );
    const attrsShapeRawText = JSON.stringify(attrsShapeRaw);
    expect(attrsShapeRawText).not.toContain(sourceContentCanary);
    expect(attrsShapeRawText).not.toContain(rawJsonCanary);
    expect(attrsShapeRawText).not.toContain(mappingsCanary);
    expect(attrsShapeRawText).not.toContain(validationErrorCanary);
    expect(attrsShapeRawText).not.toContain(markerBypassValidationError);
    expect(attrsShapeRawText).not.toContain(absoluteRoot);
    expect(attrsShapeRawText).not.toContain("sourcesContent");
    expect(attrsShapeRawText).not.toContain("raw_json");
    expect(attrsShapeRawText).not.toContain('"mappings"');

    const attrsShapeRecord = db
      .prepare("SELECT metadata FROM event_records WHERE event_id = ?")
      .get("universal-attributes-shape-source-map-adversarial") as
      | { metadata: string }
      | undefined;
    const attrsShapeMetadataText = attrsShapeRecord?.metadata ?? "";
    expect(attrsShapeMetadataText).not.toContain(sourceContentCanary);
    expect(attrsShapeMetadataText).not.toContain(rawJsonCanary);
    expect(attrsShapeMetadataText).not.toContain(mappingsCanary);
    expect(attrsShapeMetadataText).not.toContain(validationErrorCanary);
    expect(attrsShapeMetadataText).not.toContain(markerBypassValidationError);
    expect(attrsShapeMetadataText).not.toContain(absoluteRoot);

    const attrsShapeSourceMap = db
      .prepare(
        "SELECT source_map_path, file, source_root, validation_error, source_count, has_sources_content FROM source_maps WHERE id = ?",
      )
      .get("artifact-attributes-shape-source-map-adversarial") as
      | {
          source_map_path: string;
          file: string;
          source_root: string;
          validation_error: string | null;
          source_count: number;
          has_sources_content: number;
        }
      | undefined;
    expect(attrsShapeSourceMap).toMatchObject({
      source_map_path: "dist/shape.js.map",
      source_count: 1,
      has_sources_content: 1,
    });
    expect(attrsShapeSourceMap?.file).toStartWith("[source-map-host_path:");
    expect(attrsShapeSourceMap?.source_root).toStartWith(
      "[source-map-host_path:",
    );
    expect(attrsShapeSourceMap?.validation_error).toStartWith(
      "[source-map-validation-error:",
    );

    db.run("DELETE FROM event_records");
    db.run("DELETE FROM source_map_sources");
    db.run("DELETE FROM source_maps");
    db.run("DELETE FROM artifacts");
    const rebuilt = rebuildEventStoreIndex(db);
    expect(rebuilt.errors).toEqual([]);
    expect(rebuilt.skipped_events).toBe(0);
    expect(verifyEventStore(db).ok).toBe(true);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM source_map_sources WHERE source_map_id = ?",
        )
        .get("artifact-source-map-adversarial"),
    ).toEqual({ count: 2 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM source_map_sources WHERE source_map_id = ?",
        )
        .get("artifact-root-source-map-adversarial"),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM source_map_sources WHERE source_map_id = ?",
        )
        .get("artifact-attributes-source-map-adversarial"),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM source_map_sources WHERE source_map_id = ?",
        )
        .get("artifact-attributes-shape-source-map-adversarial"),
    ).toEqual({ count: 1 });
  });

  it("sanitizes legacy raw attribute-root source-map artifacts during rebuild", () => {
    const db = createTestDb();
    const absoluteRoot = "/Users/alice/project";
    const sourceContentCanary = "OPENLOGS_LEGACY_ATTRS_SOURCE_CONTENT_CANARY";
    const mappingsCanary = "OPENLOGS_LEGACY_ATTRS_MAPPINGS_CANARY";
    const rawJsonCanary = "OPENLOGS_LEGACY_ATTRS_RAW_JSON_CANARY";
    const validationCanary = "OPENLOGS_LEGACY_ATTRS_VALIDATION_CANARY";
    const markerBypassPath = `[source-map-host_path:${absoluteRoot}/src/legacy.ts]`;
    const markerBypassValidation = `[source-map-validation-error:Parse failed at ${absoluteRoot}/src/legacy.ts: ${validationCanary}]`;

    appendRawEvent(db, {
      schema_version: 1,
      event_id: "legacy-attrs-source-map-replay",
      event_time: "2026-06-18T00:00:00.000Z",
      ingest_time: "2026-06-18T00:00:00.000Z",
      type: "artifact",
      source: "legacy",
      privacy: "internal",
      body: {},
      attributes: {
        artifact_id: "legacy-attrs-source-map",
        source_map_path: "dist/legacy.js.map",
        content_hash: "sha256:legacy-source-map",
        size_bytes: 321,
        version: 3,
        file: `${absoluteRoot}/dist/legacy.js`,
        sourceRoot: absoluteRoot,
        sources: [markerBypassPath, `${absoluteRoot}/src/legacy-two.ts`],
        sourcesContent: [sourceContentCanary, `${sourceContentCanary}:second`],
        names: ["legacy"],
        mappings: mappingsCanary,
        raw_json: {
          mappings: mappingsCanary,
          source: sourceContentCanary,
          raw: rawJsonCanary,
        },
        validation_error: markerBypassValidation,
      },
    });

    const rebuilt = rebuildEventStoreIndex(db);
    expect(rebuilt.errors).toEqual([]);
    expect(rebuilt.skipped_events).toBe(0);
    expect(verifyEventStore(db).ok).toBe(true);

    const record = db
      .prepare(
        "SELECT artifact_id, metadata FROM event_records WHERE event_id = ?",
      )
      .get("legacy-attrs-source-map-replay") as
      | { artifact_id: string | null; metadata: string }
      | undefined;
    expect(record?.artifact_id).toBe("legacy-attrs-source-map");
    const metadataText = record?.metadata ?? "";
    expect(metadataText).not.toContain(sourceContentCanary);
    expect(metadataText).not.toContain(mappingsCanary);
    expect(metadataText).not.toContain(rawJsonCanary);
    expect(metadataText).not.toContain(validationCanary);
    expect(metadataText).not.toContain(markerBypassPath);
    expect(metadataText).not.toContain(markerBypassValidation);
    expect(metadataText).not.toContain(absoluteRoot);
    expect(metadataText).not.toContain("sourcesContent");
    expect(metadataText).not.toContain("raw_json");
    expect(metadataText).not.toContain('"mappings"');

    const artifact = db
      .prepare(
        "SELECT path, content_hash, size_bytes, metadata FROM artifacts WHERE id = ?",
      )
      .get("legacy-attrs-source-map") as
      | {
          path: string | null;
          content_hash: string | null;
          size_bytes: number | null;
          metadata: string;
        }
      | undefined;
    expect(artifact?.path).toBeNull();
    expect(artifact?.content_hash).toStartWith("[source-map-content-hash:");
    expect(artifact?.size_bytes).toBe(321);
    expect(artifact?.metadata).not.toContain(sourceContentCanary);
    expect(artifact?.metadata).not.toContain(mappingsCanary);
    expect(artifact?.metadata).not.toContain(rawJsonCanary);
    expect(artifact?.metadata).not.toContain(validationCanary);
    expect(artifact?.metadata).not.toContain(markerBypassPath);
    expect(artifact?.metadata).not.toContain(absoluteRoot);

    const sourceMap = db
      .prepare(
        "SELECT source_map_path, file, source_root, validation_error, source_count, has_sources_content, content_hash, size_bytes FROM source_maps WHERE id = ?",
      )
      .get("legacy-attrs-source-map") as
      | {
          source_map_path: string;
          file: string;
          source_root: string;
          validation_error: string | null;
          source_count: number;
          has_sources_content: number;
          content_hash: string | null;
          size_bytes: number | null;
        }
      | undefined;
    expect(sourceMap).toMatchObject({
      source_map_path: "dist/legacy.js.map",
      source_count: 2,
      has_sources_content: 1,
      size_bytes: 321,
    });
    expect(sourceMap?.content_hash).toStartWith("[source-map-content-hash:");
    expect(sourceMap?.file).toStartWith("[source-map-host_path:");
    expect(sourceMap?.source_root).toStartWith("[source-map-host_path:");
    expect(sourceMap?.validation_error).toStartWith(
      "[source-map-validation-error:",
    );
    expect(sourceMap?.validation_error).not.toContain(validationCanary);

    const sources = db
      .prepare(
        "SELECT ordinal, source_path, has_content, content_hash FROM source_map_sources WHERE source_map_id = ? ORDER BY ordinal",
      )
      .all("legacy-attrs-source-map") as Array<{
      ordinal: number;
      source_path: string;
      has_content: number;
      content_hash: string | null;
    }>;
    expect(sources).toHaveLength(2);
    expect(sources.map((source) => source.ordinal)).toEqual([0, 1]);
    expect(sources[0]?.source_path).toStartWith("[source-map-unsafe_marker:");
    expect(sources[1]?.source_path).toStartWith("[source-map-host_path:");
    for (const source of sources) {
      expect(source.has_content).toBe(1);
      expect(source.content_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(source)).not.toContain(sourceContentCanary);
      expect(JSON.stringify(source)).not.toContain(absoluteRoot);
    }
  });

  it("sanitizes root file-plus-sources source-map attributes before raw append", () => {
    const db = createTestDb();
    const absoluteRoot = "/Users/alice/project";

    ingestUniversalEvent(db, {
      event_id: "attrs-source-map-sources-file-only-current-final",
      type: "artifact",
      source: "ci",
      artifact_id: "artifact-attrs-source-map-sources-file-only-current-final",
      attributes: {
        artifact_id:
          "artifact-attrs-source-map-sources-file-only-current-final",
        file: `${absoluteRoot}/dist/only-sources.js`,
        sources: [`${absoluteRoot}/src/only-sources.ts`],
      },
    });

    const raw = readRawEvent(
      db,
      "attrs-source-map-sources-file-only-current-final",
    );
    const rawText = JSON.stringify(raw);
    expect(rawText).not.toContain(absoluteRoot);
    expect(rawText).toContain("[source-map-host_path:");

    const record = db
      .prepare("SELECT metadata FROM event_records WHERE event_id = ?")
      .get("attrs-source-map-sources-file-only-current-final") as
      | { metadata: string }
      | undefined;
    const metadataText = record?.metadata ?? "";
    expect(metadataText).not.toContain(absoluteRoot);
    expect(metadataText).toContain("[source-map-host_path:");

    const sourceMap = db
      .prepare(
        "SELECT file, source_count, has_sources_content FROM source_maps WHERE id = ?",
      )
      .get("artifact-attrs-source-map-sources-file-only-current-final") as
      | { file: string; source_count: number; has_sources_content: number }
      | undefined;
    expect(sourceMap).toMatchObject({
      source_count: 1,
      has_sources_content: 0,
    });
    expect(sourceMap?.file).toStartWith("[source-map-host_path:");
    const source = db
      .prepare(
        "SELECT source_path, has_content, content_hash FROM source_map_sources WHERE source_map_id = ?",
      )
      .get("artifact-attrs-source-map-sources-file-only-current-final") as
      | {
          source_path: string;
          has_content: number;
          content_hash: string | null;
        }
      | undefined;
    expect(source).toMatchObject({ has_content: 0, content_hash: null });
    expect(source?.source_path).toStartWith("[source-map-host_path:");

    db.run("DELETE FROM event_records");
    db.run("DELETE FROM source_map_sources");
    db.run("DELETE FROM source_maps");
    db.run("DELETE FROM artifacts");
    const rebuilt = rebuildEventStoreIndex(db);
    expect(rebuilt.errors).toEqual([]);
    expect(rebuilt.skipped_events).toBe(0);
    expect(verifyEventStore(db).ok).toBe(true);
    const rebuiltRecord = db
      .prepare("SELECT metadata FROM event_records WHERE event_id = ?")
      .get("attrs-source-map-sources-file-only-current-final") as
      | { metadata: string }
      | undefined;
    expect(rebuiltRecord?.metadata ?? "").not.toContain(absoluteRoot);
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM source_maps WHERE id = ?")
        .get("artifact-attrs-source-map-sources-file-only-current-final"),
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM source_map_sources WHERE source_map_id = ?",
        )
        .get("artifact-attrs-source-map-sources-file-only-current-final"),
    ).toEqual({ count: 1 });
  });

  it("sanitizes indexed source-map sections before raw append and rebuild", () => {
    const db = createTestDb();
    const absoluteRoot = "/Users/alice/project";
    const sourceContentCanary =
      "OPENLOGS_INDEXED_SECTIONS_SOURCE_CONTENT_CANARY";
    const mappingsCanary = "OPENLOGS_INDEXED_SECTIONS_MAPPINGS_CANARY";
    const rawJsonCanary = "OPENLOGS_INDEXED_SECTIONS_RAW_JSON_CANARY";
    const nameCanary = "innerName";

    ingestUniversalEvent(db, {
      type: "artifact",
      event_id: "indexed-sections-root-source-map-current",
      source: "ci",
      body: {
        artifact: {
          artifact_id: "artifact-indexed-sections-root-source-map-current",
          artifact_type: "source_map",
          path: "dist/sections.js.map",
          version: 3,
          file: `${absoluteRoot}/dist/sections.js`,
          sections: [
            {
              offset: { line: 0, column: 0 },
              map: {
                version: 3,
                file: `${absoluteRoot}/dist/inner.js`,
                sourceRoot: absoluteRoot,
                sources: [`${absoluteRoot}/src/inner.ts`],
                sourcesContent: [sourceContentCanary],
                names: [nameCanary],
                mappings: mappingsCanary,
                raw_json: rawJsonCanary,
              },
            },
          ],
          unsafe_custom_payload: sourceContentCanary,
        },
      },
    });

    const forbidden = [
      absoluteRoot,
      sourceContentCanary,
      mappingsCanary,
      rawJsonCanary,
      nameCanary,
      '"sections"',
      '"sourcesContent"',
      '"raw_json"',
      '"mappings"',
      "unsafe_custom_payload",
    ];
    const assertClean = (value: unknown) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      for (const item of forbidden) expect(text).not.toContain(item);
    };

    assertClean(readRawEvent(db, "indexed-sections-root-source-map-current"));
    const record = db
      .prepare("SELECT metadata FROM event_records WHERE event_id = ?")
      .get("indexed-sections-root-source-map-current") as
      | { metadata: string }
      | undefined;
    assertClean(record?.metadata ?? "");
    const artifact = db
      .prepare("SELECT metadata FROM artifacts WHERE id = ?")
      .get("artifact-indexed-sections-root-source-map-current") as
      | { metadata: string }
      | undefined;
    assertClean(artifact?.metadata ?? "");
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM source_map_sources WHERE source_map_id = ?",
        )
        .get("artifact-indexed-sections-root-source-map-current"),
    ).toEqual({ count: 0 });
    expect(
      db
        .prepare("SELECT source_count, metadata FROM source_maps WHERE id = ?")
        .get("artifact-indexed-sections-root-source-map-current"),
    ).toMatchObject({ source_count: 0 });

    db.run("DELETE FROM event_records");
    db.run("DELETE FROM source_map_sources");
    db.run("DELETE FROM source_maps");
    db.run("DELETE FROM artifacts");
    const rebuilt = rebuildEventStoreIndex(db);
    expect(rebuilt.errors).toEqual([]);
    expect(rebuilt.skipped_events).toBe(0);
    expect(verifyEventStore(db).ok).toBe(true);
    const rebuiltRecord = db
      .prepare("SELECT metadata FROM event_records WHERE event_id = ?")
      .get("indexed-sections-root-source-map-current") as
      | { metadata: string }
      | undefined;
    assertClean(rebuiltRecord?.metadata ?? "");
    const rebuiltArtifact = db
      .prepare("SELECT metadata FROM artifacts WHERE id = ?")
      .get("artifact-indexed-sections-root-source-map-current") as
      | { metadata: string }
      | undefined;
    assertClean(rebuiltArtifact?.metadata ?? "");
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM source_maps WHERE id = ?")
        .get("artifact-indexed-sections-root-source-map-current"),
    ).toEqual({ count: 1 });
  });

  it("drops producer redaction objects from source-map artifact metadata", () => {
    const db = createTestDb();
    const absoluteRoot = "/Users/alice/project";
    const sourceContentCanary =
      "OPENLOGS_REDACTION_BYPASS_SOURCE_CONTENT_CANARY";
    const mappingsCanary = "OPENLOGS_REDACTION_BYPASS_MAPPINGS_CANARY";
    const rawJsonCanary = "OPENLOGS_REDACTION_BYPASS_RAW_JSON_CANARY";

    ingestUniversalEvent(db, {
      type: "artifact",
      event_id: "source-map-redaction-bypass-current",
      source: "ci",
      body: {
        artifact: {
          artifact_id: "artifact-source-map-redaction-bypass-current",
          artifact_type: "source_map",
          path: "dist/redaction.js.map",
          version: 3,
          file: `${absoluteRoot}/dist/redaction.js`,
          sources: [`${absoluteRoot}/src/redaction.ts`],
          sourcesContent: [sourceContentCanary],
          mappings: mappingsCanary,
          raw_json: rawJsonCanary,
          redaction: {
            sourceRoot: absoluteRoot,
            sourcesContent: [sourceContentCanary],
            mappings: mappingsCanary,
            raw_json: rawJsonCanary,
          },
        },
      },
    });

    const forbidden = [
      absoluteRoot,
      sourceContentCanary,
      mappingsCanary,
      rawJsonCanary,
      '"sourcesContent"',
      '"raw_json"',
      '"redaction"',
      '"mappings"',
    ];
    const assertClean = (value: unknown) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      for (const item of forbidden) expect(text).not.toContain(item);
    };

    assertClean(readRawEvent(db, "source-map-redaction-bypass-current"));
    const record = db
      .prepare("SELECT metadata FROM event_records WHERE event_id = ?")
      .get("source-map-redaction-bypass-current") as
      | { metadata: string }
      | undefined;
    assertClean(record?.metadata ?? "");
    const artifact = db
      .prepare("SELECT metadata FROM artifacts WHERE id = ?")
      .get("artifact-source-map-redaction-bypass-current") as
      | { metadata: string }
      | undefined;
    assertClean(artifact?.metadata ?? "");

    db.run("DELETE FROM event_records");
    db.run("DELETE FROM source_map_sources");
    db.run("DELETE FROM source_maps");
    db.run("DELETE FROM artifacts");
    const rebuilt = rebuildEventStoreIndex(db);
    expect(rebuilt.errors).toEqual([]);
    expect(rebuilt.skipped_events).toBe(0);
    expect(verifyEventStore(db).ok).toBe(true);
    const rebuiltRecord = db
      .prepare("SELECT metadata FROM event_records WHERE event_id = ?")
      .get("source-map-redaction-bypass-current") as
      | { metadata: string }
      | undefined;
    assertClean(rebuiltRecord?.metadata ?? "");
    const rebuiltArtifact = db
      .prepare("SELECT metadata FROM artifacts WHERE id = ?")
      .get("artifact-source-map-redaction-bypass-current") as
      | { metadata: string }
      | undefined;
    assertClean(rebuiltArtifact?.metadata ?? "");
  });

  it("sanitizes source-map artifact allowlisted scalars before raw append and rebuild", () => {
    const db = createTestDb();
    const absoluteRoot = "/Users/alice/project";
    const canary =
      "OPENLOGS_ALLOWLIST_SCALAR_SOURCE_CONTENT_SHOULD_NOT_PERSIST";
    const eventId = "scalar-smuggle-source-map-artifact";
    const forbidden = [
      absoluteRoot,
      canary,
      `${absoluteRoot}/src/secret.ts:${canary}`,
      `${absoluteRoot}/src/changed.ts:${canary}`,
    ];
    const assertClean = (value: unknown) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      for (const item of forbidden) expect(text).not.toContain(item);
    };

    ingestUniversalEvent(db, {
      type: "artifact",
      event_id: eventId,
      source: "ci",
      body: {
        artifact: {
          artifact_id: eventId,
          path: "dist/app.js.map",
          artifact_type: `${absoluteRoot}/src/secret.ts:${canary}`,
          type: "source_map",
          changed: `${absoluteRoot}/src/changed.ts:${canary}`,
          category: `${absoluteRoot}/src/category.ts:${canary}`,
          scanner: canary,
          tool: canary,
          framework: canary,
          script: `build ${absoluteRoot}/src/script.ts ${canary}`,
          source_map: {
            version: 3,
            sources: ["src/app.ts"],
            sourcesContent: [canary],
            mappings: "AAAA",
          },
        },
      },
    });

    assertClean(readRawEvent(db, eventId));
    expect(JSON.stringify(readRawEvent(db, eventId))).toContain(
      "[source-map-scalar:",
    );

    const record = db
      .prepare(
        "SELECT artifact_id, metadata FROM event_records WHERE event_id = ?",
      )
      .get(eventId) as
      | { artifact_id: string | null; metadata: string }
      | undefined;
    expect(record?.artifact_id).toBe(eventId);
    assertClean(record);
    expect(record?.metadata).toContain('"artifact_type":"source_map"');
    expect(record?.metadata).toContain("[source-map-scalar:");

    const artifact = db
      .prepare(
        "SELECT id, artifact_type, path, metadata FROM artifacts WHERE id = ?",
      )
      .get(eventId) as
      | {
          id: string;
          artifact_type: string | null;
          path: string | null;
          metadata: string;
        }
      | undefined;
    expect(artifact?.artifact_type).toBe("source_map");
    expect(artifact?.path).toBe("dist/app.js.map");
    assertClean(artifact);
    expect(artifact?.metadata).toContain("[source-map-scalar:");

    db.run("DELETE FROM event_records");
    db.run("DELETE FROM source_map_sources");
    db.run("DELETE FROM source_maps");
    db.run("DELETE FROM artifacts");
    const rebuilt = rebuildEventStoreIndex(db);
    expect(rebuilt.errors).toEqual([]);
    expect(rebuilt.skipped_events).toBe(0);
    expect(verifyEventStore(db).ok).toBe(true);

    const rebuiltRecord = db
      .prepare(
        "SELECT artifact_id, metadata FROM event_records WHERE event_id = ?",
      )
      .get(eventId) as
      | { artifact_id: string | null; metadata: string }
      | undefined;
    expect(rebuiltRecord?.artifact_id).toBe(eventId);
    assertClean(rebuiltRecord);
    expect(rebuiltRecord?.metadata).toContain('"artifact_type":"source_map"');
    expect(rebuiltRecord?.metadata).toContain("[source-map-scalar:");

    const rebuiltArtifact = db
      .prepare(
        "SELECT id, artifact_type, path, metadata FROM artifacts WHERE id = ?",
      )
      .get(eventId) as
      | {
          id: string;
          artifact_type: string | null;
          path: string | null;
          metadata: string;
        }
      | undefined;
    expect(rebuiltArtifact?.artifact_type).toBe("source_map");
    expect(rebuiltArtifact?.path).toBe("dist/app.js.map");
    assertClean(rebuiltArtifact);
    expect(rebuiltArtifact?.metadata).toContain("[source-map-scalar:");
  });

  it("sanitizes top-level source-map artifact scalar attributes before raw append and rebuild", () => {
    const db = createTestDb();
    const canary =
      "OPENLOGS_ATTRIBUTE_SCALAR_SOURCE_CONTENT_SHOULD_NOT_PERSIST";
    const eventId = "attribute-scalar-source-map-leak";
    const assertClean = (value: unknown) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      expect(text).not.toContain(canary);
    };

    ingestUniversalEvent(db, {
      type: "artifact",
      event_id: eventId,
      source: "ci",
      attributes: {
        scanner: canary,
        artifact_type: canary,
      },
      body: {
        artifact: {
          artifact_id: eventId,
          artifact_type: "source_map",
          path: "dist/app.js.map",
          source_map: {
            version: 3,
            sources: ["src/app.ts"],
            sourcesContent: [canary],
            mappings: "AAAA",
          },
        },
      },
    });

    const raw = readRawEvent(db, eventId);
    assertClean(raw);
    expect(JSON.stringify(raw)).toContain("[source-map-scalar:");

    const record = db
      .prepare(
        "SELECT artifact_id, metadata FROM event_records WHERE event_id = ?",
      )
      .get(eventId) as
      | { artifact_id: string | null; metadata: string }
      | undefined;
    expect(record?.artifact_id).toBe(eventId);
    assertClean(record);
    expect(record?.metadata).toContain('"artifact_type":"source_map"');

    const artifact = db
      .prepare("SELECT id, artifact_type, metadata FROM artifacts WHERE id = ?")
      .get(eventId) as
      | { id: string; artifact_type: string | null; metadata: string }
      | undefined;
    expect(artifact?.artifact_type).toBe("source_map");
    assertClean(artifact);
    expect(artifact?.metadata).toContain("[source-map-scalar:");

    db.run("DELETE FROM event_records");
    db.run("DELETE FROM source_map_sources");
    db.run("DELETE FROM source_maps");
    db.run("DELETE FROM artifacts");
    const rebuilt = rebuildEventStoreIndex(db);
    expect(rebuilt.errors).toEqual([]);
    expect(rebuilt.skipped_events).toBe(0);
    expect(verifyEventStore(db).ok).toBe(true);

    const rebuiltRecord = db
      .prepare(
        "SELECT artifact_id, metadata FROM event_records WHERE event_id = ?",
      )
      .get(eventId) as
      | { artifact_id: string | null; metadata: string }
      | undefined;
    expect(rebuiltRecord?.artifact_id).toBe(eventId);
    assertClean(rebuiltRecord);
    expect(rebuiltRecord?.metadata).toContain('"artifact_type":"source_map"');

    const rebuiltArtifact = db
      .prepare("SELECT id, artifact_type, metadata FROM artifacts WHERE id = ?")
      .get(eventId) as
      | { id: string; artifact_type: string | null; metadata: string }
      | undefined;
    expect(rebuiltArtifact?.artifact_type).toBe("source_map");
    assertClean(rebuiltArtifact);
    expect(rebuiltArtifact?.metadata).toContain("[source-map-scalar:");
  });

  it("sanitizes legacy raw root path-only source-map artifacts during rebuild", () => {
    const db = createTestDb();
    const absoluteRoot = "/tmp/open-logs-legacy-root-path-only";
    const cases = [
      {
        eventId: "legacy-root-path-only-attributes",
        artifactId: "legacy-root-path-only-attributes-artifact",
        artifact: {
          artifact_id: "legacy-root-path-only-attributes-artifact",
          artifact_type: "source_map",
          path: `${absoluteRoot}/attributes/dist/app.js.map`,
          version: 3,
          sources: [`${absoluteRoot}/attributes/src/app.ts`],
          mappings: "AAAA",
        },
        location: "attributes",
      },
      {
        eventId: "legacy-root-path-only-nested-body",
        artifactId: "legacy-root-path-only-nested-body-artifact",
        artifact: {
          artifact_id: "legacy-root-path-only-nested-body-artifact",
          artifact_type: "source_map",
          path: `${absoluteRoot}/nested-body/dist/app.js.map`,
          version: 3,
          sources: [`${absoluteRoot}/nested-body/src/app.ts`],
          mappings: "AAAA",
        },
        location: "nested_body",
      },
      {
        eventId: "legacy-root-path-only-root-body",
        artifactId: "legacy-root-path-only-root-body-artifact",
        artifact: {
          artifact_id: "legacy-root-path-only-root-body-artifact",
          artifact_type: "source_map",
          path: `${absoluteRoot}/root-body/dist/app.js.map`,
          version: 3,
          file: `${absoluteRoot}/root-body/dist/app.js`,
          sources: [`${absoluteRoot}/root-body/src/app.ts`],
          sourcesContent: ["OPENLOGS_LEGACY_BODY_ROOT_CANARY"],
          mappings: "AAAA",
          raw_json: "OPENLOGS_LEGACY_BODY_ROOT_CANARY",
        },
        location: "root_body",
      },
    ] as const;

    for (const item of cases) {
      appendRawEvent(db, {
        schema_version: 1,
        event_id: item.eventId,
        event_time: "2026-06-18T00:00:00.000Z",
        ingest_time: "2026-06-18T00:00:00.000Z",
        type: "artifact",
        source: "legacy",
        privacy: "internal",
        body:
          item.location === "nested_body"
            ? { artifact: item.artifact }
            : item.location === "root_body"
              ? item.artifact
              : {},
        attributes: item.location === "attributes" ? item.artifact : {},
      });
    }

    const rebuilt = rebuildEventStoreIndex(db);
    expect(rebuilt.errors).toEqual([]);
    expect(rebuilt.skipped_events).toBe(0);
    expect(verifyEventStore(db).ok).toBe(true);

    for (const item of cases) {
      const record = db
        .prepare(
          "SELECT artifact_id, metadata FROM event_records WHERE event_id = ?",
        )
        .get(item.eventId) as
        | { artifact_id: string | null; metadata: string }
        | undefined;
      expect(record?.artifact_id).toBe(item.artifactId);
      expect(record?.metadata ?? "").not.toContain(absoluteRoot);
      expect(record?.metadata ?? "").not.toContain('"mappings"');
      expect(record?.metadata ?? "").not.toContain(
        "OPENLOGS_LEGACY_BODY_ROOT_CANARY",
      );
      expect(record?.metadata ?? "").not.toContain("sourcesContent");
      expect(record?.metadata ?? "").not.toContain("raw_json");

      const artifact = db
        .prepare("SELECT path, metadata FROM artifacts WHERE id = ?")
        .get(item.artifactId) as
        | { path: string | null; metadata: string }
        | undefined;
      expect(artifact?.path).toStartWith("[source-map-host_path:");
      expect(artifact?.metadata).not.toContain(absoluteRoot);
      expect(artifact?.metadata).not.toContain('"mappings"');
      expect(artifact?.metadata).not.toContain(
        "OPENLOGS_LEGACY_BODY_ROOT_CANARY",
      );
      expect(artifact?.metadata).not.toContain("sourcesContent");
      expect(artifact?.metadata).not.toContain("raw_json");

      const sourceMap = db
        .prepare(
          "SELECT source_map_path, source_count, mappings_length FROM source_maps WHERE id = ?",
        )
        .get(item.artifactId) as
        | {
            source_map_path: string | null;
            source_count: number;
            mappings_length: number;
          }
        | undefined;
      expect(sourceMap).toMatchObject({
        source_count: 1,
        mappings_length: 4,
      });
      expect(sourceMap?.source_map_path).toStartWith("[source-map-host_path:");
      expect(sourceMap?.source_map_path).not.toContain(absoluteRoot);

      const source = db
        .prepare(
          "SELECT source_path FROM source_map_sources WHERE source_map_id = ?",
        )
        .get(item.artifactId) as { source_path: string } | undefined;
      expect(source?.source_path).toStartWith("[source-map-host_path:");
      expect(source?.source_path).not.toContain(absoluteRoot);
    }
  });

  it("sanitizes source-map identifiers before raw append and rebuild", () => {
    const db = createTestDb();
    const liveAbsoluteId =
      "/tmp/open-logs-live-source-map-id-path/dist/app.js.map";
    const legacyAbsoluteId =
      "/tmp/open-logs-legacy-source-map-id-path/dist/app.js.map";
    const liveJavascriptAbsoluteId =
      "/tmp/open-logs-live-source-map-id-path/dist/app.js";
    const legacyJavascriptAbsoluteId =
      "/tmp/open-logs-legacy-source-map-id-path/dist/legacy.js";
    const liveEventId = "source-map-id-path-live";
    const legacyEventId = "source-map-id-path-legacy";
    const forbidden = [
      liveAbsoluteId,
      legacyAbsoluteId,
      liveJavascriptAbsoluteId,
      legacyJavascriptAbsoluteId,
    ];
    const assertNoForbidden = (value: unknown) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      for (const item of forbidden) expect(text).not.toContain(item);
    };

    ingestUniversalEvent(db, {
      type: "artifact",
      event_id: liveEventId,
      source: "ci",
      body: {
        artifact: {
          artifact_id: "artifact-source-map-id-path-live",
          artifact_type: "source_map",
          path: "dist/app.js.map",
          source_map: {
            source_map_id: liveAbsoluteId,
            source_map_artifact_id: liveAbsoluteId,
            source_map_path: "dist/app.js.map",
            javascript_artifact_id: liveJavascriptAbsoluteId,
            javascript_path: liveJavascriptAbsoluteId,
            version: 3,
            sources: ["src/app.ts"],
            mappings: "AAAA",
          },
        },
      },
    });

    appendRawEvent(db, {
      schema_version: 1,
      event_id: legacyEventId,
      event_time: "2026-06-18T00:00:00.000Z",
      ingest_time: "2026-06-18T00:00:00.000Z",
      type: "artifact",
      source: "legacy",
      privacy: "internal",
      body: {
        artifact: {
          artifact_id: "artifact-source-map-id-path-legacy",
          artifact_type: "source_map",
          path: "dist/legacy.js.map",
          source_map: {
            source_map_id: legacyAbsoluteId,
            source_map_artifact_id: legacyAbsoluteId,
            source_map_path: "dist/legacy.js.map",
            javascript_artifact_id: legacyJavascriptAbsoluteId,
            javascript_path: legacyJavascriptAbsoluteId,
            version: 3,
            sources: ["src/legacy.ts"],
            mappings: "AAAA",
          },
        },
      },
      attributes: {},
    });

    assertNoForbidden(readRawEvent(db, liveEventId));
    const liveRecord = db
      .prepare(
        "SELECT artifact_id, metadata FROM event_records WHERE event_id = ?",
      )
      .get(liveEventId) as
      | { artifact_id: string | null; metadata: string }
      | undefined;
    expect(liveRecord?.artifact_id).toBe("artifact-source-map-id-path-live");
    assertNoForbidden(liveRecord?.metadata ?? "");

    const liveArtifact = db
      .prepare("SELECT id, metadata FROM artifacts WHERE id = ?")
      .get("artifact-source-map-id-path-live") as
      | { id: string; metadata: string }
      | undefined;
    expect(liveArtifact?.id).toBe("artifact-source-map-id-path-live");
    assertNoForbidden(liveArtifact?.metadata ?? "");

    const liveSourceMap = db
      .prepare(
        "SELECT id, source_map_artifact_id, javascript_artifact_id, source_map_path, javascript_path, metadata FROM source_maps WHERE event_id = ?",
      )
      .get(liveEventId) as
      | {
          id: string;
          source_map_artifact_id: string;
          javascript_artifact_id: string;
          source_map_path: string;
          javascript_path: string;
          metadata: string;
        }
      | undefined;
    expect(liveSourceMap?.id).toStartWith("[source-map-id:");
    expect(liveSourceMap?.source_map_artifact_id).toStartWith(
      "[source-map-id:",
    );
    expect(liveSourceMap?.javascript_artifact_id).toStartWith(
      "[source-map-id:",
    );
    expect(liveSourceMap?.source_map_path).toBe("dist/app.js.map");
    expect(liveSourceMap?.javascript_path).toStartWith(
      "[source-map-host_path:",
    );
    assertNoForbidden(liveSourceMap);

    const liveSourceRows = db
      .prepare(
        "SELECT source_map_id, source_path, metadata FROM source_map_sources WHERE source_map_id = ?",
      )
      .all(liveSourceMap?.id ?? "") as Array<{
      source_map_id: string;
      source_path: string;
      metadata: string;
    }>;
    expect(liveSourceRows).toHaveLength(1);
    expect(liveSourceRows[0]?.source_map_id).toStartWith("[source-map-id:");
    expect(liveSourceRows[0]?.source_path).toBe("src/app.ts");
    assertNoForbidden(liveSourceRows);

    db.run("DELETE FROM event_records");
    db.run("DELETE FROM source_map_sources");
    db.run("DELETE FROM source_maps");
    db.run("DELETE FROM artifacts");
    const rebuilt = rebuildEventStoreIndex(db);
    expect(rebuilt.errors).toEqual([]);
    expect(rebuilt.skipped_events).toBe(0);
    expect(verifyEventStore(db).ok).toBe(true);

    const rebuiltRecords = db
      .prepare(
        "SELECT event_id, artifact_id, metadata FROM event_records WHERE event_id IN (?, ?) ORDER BY event_id",
      )
      .all(liveEventId, legacyEventId) as Array<{
      event_id: string;
      artifact_id: string | null;
      metadata: string;
    }>;
    expect(rebuiltRecords).toHaveLength(2);
    assertNoForbidden(rebuiltRecords);

    const rebuiltArtifacts = db
      .prepare(
        "SELECT id, metadata FROM artifacts WHERE id IN (?, ?) ORDER BY id",
      )
      .all(
        "artifact-source-map-id-path-live",
        "artifact-source-map-id-path-legacy",
      ) as Array<{ id: string; metadata: string }>;
    expect(rebuiltArtifacts).toHaveLength(2);
    assertNoForbidden(rebuiltArtifacts);

    const rebuiltSourceMaps = db
      .prepare(
        "SELECT id, event_id, source_map_artifact_id, javascript_artifact_id, source_map_path, javascript_path, metadata FROM source_maps WHERE event_id IN (?, ?) ORDER BY event_id",
      )
      .all(liveEventId, legacyEventId) as Array<{
      id: string;
      event_id: string;
      source_map_artifact_id: string;
      javascript_artifact_id: string;
      source_map_path: string;
      javascript_path: string;
      metadata: string;
    }>;
    expect(rebuiltSourceMaps).toHaveLength(2);
    for (const sourceMap of rebuiltSourceMaps) {
      expect(sourceMap.id).toStartWith("[source-map-id:");
      expect(sourceMap.source_map_artifact_id).toStartWith("[source-map-id:");
      expect(sourceMap.javascript_artifact_id).toStartWith("[source-map-id:");
      expect(sourceMap.javascript_path).toStartWith("[source-map-host_path:");
    }
    assertNoForbidden(rebuiltSourceMaps);

    const rebuiltSourceRows = db
      .prepare(
        "SELECT source_map_id, source_path, metadata FROM source_map_sources ORDER BY source_map_id, ordinal",
      )
      .all() as Array<{
      source_map_id: string;
      source_path: string;
      metadata: string;
    }>;
    expect(rebuiltSourceRows).toHaveLength(2);
    for (const row of rebuiltSourceRows) {
      expect(row.source_map_id).toStartWith("[source-map-id:");
    }
    expect(rebuiltSourceRows.map((row) => row.source_path).sort()).toEqual([
      "src/app.ts",
      "src/legacy.ts",
    ]);
    assertNoForbidden(rebuiltSourceRows);
  });

  it("sanitizes source-map artifact identifiers before raw append and rebuild", () => {
    const db = createTestDb();
    const liveAbsoluteArtifactId =
      "/tmp/open-logs-live-artifact-id-path/dist/app.js.map";
    const legacyAbsoluteArtifactId =
      "/tmp/open-logs-legacy-artifact-id-path/dist/app.js.map";
    const liveEventId = "live-artifact-id-path-source-map";
    const legacyEventId = "legacy-artifact-id-path-source-map";
    const forbidden = [liveAbsoluteArtifactId, legacyAbsoluteArtifactId];
    const assertNoForbidden = (value: unknown) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      for (const item of forbidden) expect(text).not.toContain(item);
    };

    ingestUniversalEvent(db, {
      type: "artifact",
      event_id: liveEventId,
      source: "ci",
      artifact_id: liveAbsoluteArtifactId,
      body: {
        artifact: {
          artifact_id: liveAbsoluteArtifactId,
          artifact_type: "source_map",
          path: "dist/app.js.map",
          version: 3,
          sources: ["src/app.ts"],
          mappings: "AAAA",
        },
      },
    });

    appendRawEvent(db, {
      schema_version: 1,
      event_id: legacyEventId,
      event_time: "2026-06-18T00:00:00.000Z",
      ingest_time: "2026-06-18T00:00:00.000Z",
      type: "artifact",
      source: "legacy",
      privacy: "internal",
      body: {
        artifact: {
          artifact_id: legacyAbsoluteArtifactId,
          artifact_type: "source_map",
          path: "dist/legacy.js.map",
          version: 3,
          sources: ["src/legacy.ts"],
          mappings: "AAAA",
        },
      },
      attributes: {
        artifact_id: legacyAbsoluteArtifactId,
      },
    });

    const liveRaw = readRawEvent(db, liveEventId);
    assertNoForbidden(liveRaw);
    expect(JSON.stringify(liveRaw)).toContain("[source-map-id:");

    const liveRecord = db
      .prepare(
        "SELECT artifact_id, metadata FROM event_records WHERE event_id = ?",
      )
      .get(liveEventId) as
      | { artifact_id: string | null; metadata: string }
      | undefined;
    expect(liveRecord?.artifact_id).toStartWith("[source-map-id:");
    assertNoForbidden(liveRecord);

    const liveArtifact = db
      .prepare("SELECT id, path, metadata FROM artifacts")
      .get() as
      | { id: string; path: string | null; metadata: string }
      | undefined;
    expect(liveArtifact?.id).toStartWith("[source-map-id:");
    expect(liveArtifact?.path).toBe("dist/app.js.map");
    assertNoForbidden(liveArtifact);

    const liveSourceMap = db
      .prepare(
        "SELECT id, source_map_artifact_id FROM source_maps WHERE event_id = ?",
      )
      .get(liveEventId) as
      | { id: string; source_map_artifact_id: string }
      | undefined;
    expect(liveSourceMap?.id).toStartWith("[source-map-id:");
    expect(liveSourceMap?.source_map_artifact_id).toStartWith(
      "[source-map-id:",
    );
    assertNoForbidden(liveSourceMap);

    db.run("DELETE FROM event_records");
    db.run("DELETE FROM source_map_sources");
    db.run("DELETE FROM source_maps");
    db.run("DELETE FROM artifacts");
    const rebuilt = rebuildEventStoreIndex(db);
    expect(rebuilt.errors).toEqual([]);
    expect(rebuilt.skipped_events).toBe(0);
    expect(verifyEventStore(db).ok).toBe(true);

    const rebuiltRecords = db
      .prepare(
        "SELECT event_id, artifact_id, metadata FROM event_records WHERE event_id IN (?, ?) ORDER BY event_id",
      )
      .all(liveEventId, legacyEventId) as Array<{
      event_id: string;
      artifact_id: string | null;
      metadata: string;
    }>;
    expect(rebuiltRecords).toHaveLength(2);
    for (const record of rebuiltRecords) {
      expect(record.artifact_id).toStartWith("[source-map-id:");
    }
    assertNoForbidden(rebuiltRecords);

    const rebuiltArtifacts = db
      .prepare("SELECT id, path, metadata FROM artifacts ORDER BY id")
      .all() as Array<{ id: string; path: string | null; metadata: string }>;
    expect(rebuiltArtifacts).toHaveLength(2);
    for (const artifact of rebuiltArtifacts) {
      expect(artifact.id).toStartWith("[source-map-id:");
      expect(artifact.path).toMatch(/^dist\/(app|legacy)\.js\.map$/);
    }
    assertNoForbidden(rebuiltArtifacts);

    const rebuiltSourceMaps = db
      .prepare(
        "SELECT id, event_id, source_map_artifact_id FROM source_maps WHERE event_id IN (?, ?) ORDER BY event_id",
      )
      .all(liveEventId, legacyEventId) as Array<{
      id: string;
      event_id: string;
      source_map_artifact_id: string;
    }>;
    expect(rebuiltSourceMaps).toHaveLength(2);
    for (const sourceMap of rebuiltSourceMaps) {
      expect(sourceMap.id).toStartWith("[source-map-id:");
      expect(sourceMap.source_map_artifact_id).toStartWith("[source-map-id:");
    }
    assertNoForbidden(rebuiltSourceMaps);

    const rebuiltSourceRows = db
      .prepare(
        "SELECT source_map_id, source_path FROM source_map_sources ORDER BY source_map_id, ordinal",
      )
      .all() as Array<{ source_map_id: string; source_path: string }>;
    expect(rebuiltSourceRows).toHaveLength(2);
    for (const row of rebuiltSourceRows) {
      expect(row.source_map_id).toStartWith("[source-map-id:");
    }
    assertNoForbidden(rebuiltSourceRows);
  });

  it("uses bounded fallback IDs for source-map artifacts without producer IDs", () => {
    const db = createTestDb();
    const liveEventId =
      "/tmp/open-logs-event-id-fallback-live\0/dist/app.js.map";
    const legacyEventId =
      "/tmp/open-logs-event-id-fallback-legacy\0/dist/app.js.map";
    const forbidden = [liveEventId, legacyEventId];
    const assertNoForbidden = (value: unknown) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      for (const item of forbidden) expect(text).not.toContain(item);
    };

    ingestUniversalEvent(db, {
      type: "artifact",
      event_id: liveEventId,
      source: "ci",
      body: {
        artifact_type: "source_map",
        path: "dist/app.js.map",
        version: 3,
        sources: ["src/app.ts"],
        mappings: "AAAA",
      },
    });

    appendRawEvent(db, {
      schema_version: 1,
      event_id: legacyEventId,
      event_time: "2026-06-18T00:00:00.000Z",
      ingest_time: "2026-06-18T00:00:00.000Z",
      type: "artifact",
      source: "legacy",
      privacy: "internal",
      body: {
        artifact_type: "source_map",
        path: "dist/legacy.js.map",
        version: 3,
        sources: ["src/legacy.ts"],
        mappings: "AAAA",
      },
      attributes: {},
    });

    const liveArtifact = db
      .prepare("SELECT id, path, metadata FROM artifacts")
      .get() as
      | { id: string; path: string | null; metadata: string }
      | undefined;
    expect(liveArtifact?.id).toStartWith("[source-map-id:");
    expect(liveArtifact?.id).not.toBe(liveEventId);
    expect(liveArtifact?.path).toBe("dist/app.js.map");
    assertNoForbidden(liveArtifact);

    const liveSourceMap = db
      .prepare(
        "SELECT id, source_map_artifact_id FROM source_maps WHERE event_id = ?",
      )
      .get(liveEventId) as
      | { id: string; source_map_artifact_id: string }
      | undefined;
    expect(liveSourceMap?.id).toStartWith("[source-map-id:");
    expect(liveSourceMap?.source_map_artifact_id).toBe(liveSourceMap?.id);
    expect(liveSourceMap?.id).not.toBe(liveEventId);
    assertNoForbidden(liveSourceMap);

    const liveSource = db
      .prepare("SELECT source_map_id FROM source_map_sources")
      .get() as { source_map_id: string } | undefined;
    expect(liveSource?.source_map_id).toBe(liveSourceMap?.id);
    assertNoForbidden(liveSource);

    db.run("DELETE FROM event_records");
    db.run("DELETE FROM source_map_sources");
    db.run("DELETE FROM source_maps");
    db.run("DELETE FROM artifacts");
    const rebuilt = rebuildEventStoreIndex(db);
    expect(rebuilt.errors).toEqual([]);
    expect(rebuilt.skipped_events).toBe(0);
    expect(verifyEventStore(db).ok).toBe(true);

    const rebuiltArtifacts = db
      .prepare("SELECT id, path, metadata FROM artifacts ORDER BY path")
      .all() as Array<{ id: string; path: string | null; metadata: string }>;
    expect(rebuiltArtifacts).toHaveLength(2);
    for (const artifact of rebuiltArtifacts) {
      expect(artifact.id).toStartWith("[source-map-id:");
      expect(artifact.id).not.toBe(liveEventId);
      expect(artifact.id).not.toBe(legacyEventId);
    }
    assertNoForbidden(rebuiltArtifacts);

    const rebuiltSourceMaps = db
      .prepare(
        "SELECT id, event_id, source_map_artifact_id FROM source_maps ORDER BY event_id",
      )
      .all() as Array<{
      id: string;
      event_id: string;
      source_map_artifact_id: string;
    }>;
    expect(rebuiltSourceMaps).toHaveLength(2);
    for (const sourceMap of rebuiltSourceMaps) {
      expect(sourceMap.id).toStartWith("[source-map-id:");
      expect(sourceMap.source_map_artifact_id).toBe(sourceMap.id);
      expect(sourceMap.id).not.toBe(sourceMap.event_id);
    }
    assertNoForbidden(rebuiltSourceMaps);

    const rebuiltSourceRows = db
      .prepare(
        "SELECT source_map_id FROM source_map_sources ORDER BY source_map_id",
      )
      .all() as Array<{ source_map_id: string }>;
    expect(rebuiltSourceRows).toHaveLength(2);
    for (const row of rebuiltSourceRows) {
      expect(row.source_map_id).toStartWith("[source-map-id:");
      expect(rebuiltSourceMaps.map((sourceMap) => sourceMap.id)).toContain(
        row.source_map_id,
      );
    }
    assertNoForbidden(rebuiltSourceRows);
  });

  it("projects root-body source-map artifacts consistently before and after rebuild", () => {
    const db = createTestDb();
    const eventId = "root-body-source-map-live-rebuild-parity";
    const artifactId = "root-body-map-id-live-rebuild-parity";

    ingestUniversalEvent(db, {
      type: "artifact",
      event_id: eventId,
      source: "ci",
      body: {
        artifact_id: artifactId,
        artifact_type: "source_map",
        path: "dist/root-body.js.map",
        version: 3,
        sources: ["src/root-body.ts"],
        mappings: "AAAA",
      },
    });

    const readSnapshot = () => {
      const sourceMap = db
        .prepare(
          "SELECT id, source_map_path, metadata FROM source_maps WHERE event_id = ?",
        )
        .get(eventId) as
        | { id: string; source_map_path: string | null; metadata: string }
        | undefined;
      const artifact = db
        .prepare("SELECT id, path, metadata FROM artifacts WHERE id = ?")
        .get(artifactId) as
        | { id: string; path: string | null; metadata: string }
        | undefined;
      const record = db
        .prepare(
          "SELECT artifact_id, metadata FROM event_records WHERE event_id = ?",
        )
        .get(eventId) as
        | { artifact_id: string | null; metadata: string }
        | undefined;
      return {
        source_map_path: sourceMap?.source_map_path,
        source_map_metadata: JSON.parse(sourceMap?.metadata ?? "{}"),
        artifact_path: artifact?.path,
        artifact_metadata: JSON.parse(artifact?.metadata ?? "{}"),
        record_artifact_id: record?.artifact_id,
        record_metadata: JSON.parse(record?.metadata ?? "{}"),
      };
    };

    const live = readSnapshot();
    expect(live).toMatchObject({
      source_map_path: "dist/root-body.js.map",
      artifact_path: "dist/root-body.js.map",
      record_artifact_id: artifactId,
    });
    expect(live.source_map_metadata).toMatchObject({
      source_map_path: "dist/root-body.js.map",
      source_count: 1,
      mappings_length: 4,
    });
    expect(live.artifact_metadata).toMatchObject({
      artifact_id: artifactId,
      artifact_type: "source_map",
      path: "dist/root-body.js.map",
      source_map: {
        source_count: 1,
        mappings_length: 4,
      },
    });
    expect(live.record_metadata).toMatchObject(live.artifact_metadata);

    db.run("DELETE FROM event_records");
    db.run("DELETE FROM source_map_sources");
    db.run("DELETE FROM source_maps");
    db.run("DELETE FROM artifacts");
    const rebuilt = rebuildEventStoreIndex(db);
    expect(rebuilt.errors).toEqual([]);
    expect(rebuilt.skipped_events).toBe(0);
    expect(verifyEventStore(db).ok).toBe(true);

    const replay = readSnapshot();
    expect(replay).toEqual(live);
  });

  it("sanitizes source-map content hash scalars before raw append and rebuild", () => {
    const db = createTestDb();
    const absoluteRoot = "/Users/alice/project";
    const canary = "OPENLOGS_CONTENT_HASH_SOURCE_BODY_SHOULD_NOT_PERSIST";
    const liveEventId = "source-map-content-hash-smuggle-live";
    const legacyEventId = "source-map-content-hash-smuggle-legacy";
    const forbidden = [absoluteRoot, canary];
    const assertNoForbidden = (value: unknown) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      for (const item of forbidden) expect(text).not.toContain(item);
    };

    ingestUniversalEvent(db, {
      type: "artifact",
      event_id: liveEventId,
      source: "ci",
      body: {
        artifact: {
          artifact_id: "artifact-source-map-content-hash-smuggle-live",
          artifact_type: "source_map",
          path: "dist/content-hash.js.map",
          content_hash: `${canary}:${absoluteRoot}/src/secret.ts`,
          source_map: {
            source_map_id: "source-map-content-hash-smuggle-live",
            source_map_artifact_id:
              "artifact-source-map-content-hash-smuggle-live",
            source_map_path: "dist/content-hash.js.map",
            version: 3,
            content_hash: `${canary}:source-map:${absoluteRoot}/src/secret.ts`,
            sources: [
              {
                source_path: "src/content-hash.ts",
                content_hash: `${canary}:source:${absoluteRoot}/src/secret.ts`,
              },
            ],
            sourcesContent: [canary],
            mappings: "AAAA",
          },
        },
      },
    });

    appendRawEvent(db, {
      schema_version: 1,
      event_id: legacyEventId,
      event_time: "2026-06-18T00:00:00.000Z",
      ingest_time: "2026-06-18T00:00:00.000Z",
      type: "artifact",
      source: "legacy",
      privacy: "internal",
      body: {
        artifact: {
          artifact_id: "artifact-source-map-content-hash-smuggle-legacy",
          artifact_type: "source_map",
          path: "dist/content-hash-legacy.js.map",
          content_hash: `${canary}:legacy:${absoluteRoot}/src/secret.ts`,
          source_map: {
            source_map_id: "source-map-content-hash-smuggle-legacy",
            source_map_artifact_id:
              "artifact-source-map-content-hash-smuggle-legacy",
            source_map_path: "dist/content-hash-legacy.js.map",
            version: 3,
            content_hash: `${canary}:legacy-source-map:${absoluteRoot}/src/secret.ts`,
            sources: [
              {
                source_path: "src/content-hash-legacy.ts",
                content_hash: `${canary}:legacy-source:${absoluteRoot}/src/secret.ts`,
              },
            ],
            sourcesContent: [canary],
            mappings: "AAAA",
          },
        },
      },
      attributes: {},
    });

    assertNoForbidden(readRawEvent(db, liveEventId));
    const liveRecord = db
      .prepare("SELECT metadata FROM event_records WHERE event_id = ?")
      .get(liveEventId) as { metadata: string } | undefined;
    assertNoForbidden(liveRecord?.metadata ?? "");

    const liveArtifact = db
      .prepare("SELECT content_hash, metadata FROM artifacts WHERE id = ?")
      .get("artifact-source-map-content-hash-smuggle-live") as
      | { content_hash: string | null; metadata: string }
      | undefined;
    expect(liveArtifact?.content_hash).toStartWith("[source-map-content-hash:");
    assertNoForbidden(liveArtifact);

    const liveSourceMap = db
      .prepare(
        "SELECT content_hash, metadata FROM source_maps WHERE event_id = ?",
      )
      .get(liveEventId) as
      | { content_hash: string | null; metadata: string }
      | undefined;
    expect(liveSourceMap?.content_hash).toStartWith(
      "[source-map-content-hash:",
    );
    assertNoForbidden(liveSourceMap);

    const liveSource = db
      .prepare(
        "SELECT content_hash FROM source_map_sources WHERE source_map_id = ?",
      )
      .get("source-map-content-hash-smuggle-live") as
      | { content_hash: string | null }
      | undefined;
    expect(liveSource?.content_hash).toMatch(/^[a-f0-9]{64}$/);
    assertNoForbidden(liveSource);

    db.run("DELETE FROM event_records");
    db.run("DELETE FROM source_map_sources");
    db.run("DELETE FROM source_maps");
    db.run("DELETE FROM artifacts");
    const rebuilt = rebuildEventStoreIndex(db);
    expect(rebuilt.errors).toEqual([]);
    expect(rebuilt.skipped_events).toBe(0);
    expect(verifyEventStore(db).ok).toBe(true);

    const rebuiltRecords = db
      .prepare(
        "SELECT event_id, metadata FROM event_records WHERE event_id IN (?, ?) ORDER BY event_id",
      )
      .all(liveEventId, legacyEventId) as Array<{
      event_id: string;
      metadata: string;
    }>;
    expect(rebuiltRecords).toHaveLength(2);
    assertNoForbidden(rebuiltRecords);

    const rebuiltArtifacts = db
      .prepare("SELECT id, content_hash, metadata FROM artifacts ORDER BY id")
      .all() as Array<{
      id: string;
      content_hash: string | null;
      metadata: string;
    }>;
    expect(rebuiltArtifacts).toHaveLength(2);
    for (const artifact of rebuiltArtifacts) {
      expect(artifact.content_hash).toStartWith("[source-map-content-hash:");
    }
    assertNoForbidden(rebuiltArtifacts);

    const rebuiltSourceMaps = db
      .prepare(
        "SELECT id, content_hash, metadata FROM source_maps ORDER BY event_id",
      )
      .all() as Array<{
      id: string;
      content_hash: string | null;
      metadata: string;
    }>;
    expect(rebuiltSourceMaps).toHaveLength(2);
    for (const sourceMap of rebuiltSourceMaps) {
      expect(sourceMap.content_hash).toStartWith("[source-map-content-hash:");
    }
    assertNoForbidden(rebuiltSourceMaps);

    const rebuiltSources = db
      .prepare(
        "SELECT source_map_id, source_path, content_hash FROM source_map_sources ORDER BY source_map_id",
      )
      .all() as Array<{
      source_map_id: string;
      source_path: string;
      content_hash: string | null;
    }>;
    expect(rebuiltSources).toHaveLength(2);
    for (const source of rebuiltSources) {
      expect(source.content_hash).toMatch(/^[a-f0-9]{64}$/);
    }
    assertNoForbidden(rebuiltSources);
  });

  it("indexes test report build events without creating process or run projections", () => {
    const db = createTestDb();
    ingestUniversalEvent(db, {
      type: "build",
      event_id: "external-test-report-event",
      event_time: "2026-06-16T08:00:00.000Z",
      source: "test",
      process_id: "proc-external-test-report",
      run_id: "run-external-test-report",
      attributes: {
        category: "test_report",
        scanner: "logs-run-junit-v1",
        path: "test-results/junit.xml",
      },
      body: {
        test_report: {
          report_id: "report-external-test-report",
          path: "test-results/junit.xml",
          parser: "junit-xml-v1",
          parse_status: "parsed",
          tests: 1,
          failures: 0,
          errors: 0,
          skipped: 0,
        },
      },
    });

    const record = db
      .prepare(
        "SELECT run_id, process_id, metadata FROM event_records WHERE event_id = ?",
      )
      .get("external-test-report-event") as {
      run_id: string | null;
      process_id: string | null;
      metadata: string;
    } | null;
    expect(record?.run_id).toBe("run-external-test-report");
    expect(record?.process_id).toBe("proc-external-test-report");
    expect(JSON.parse(record?.metadata ?? "{}")).toMatchObject({
      category: "test_report",
      report_id: "report-external-test-report",
      tests: 1,
      path: "test-results/junit.xml",
    });
    expect(
      db
        .prepare("SELECT id FROM runs WHERE id = ?")
        .get("run-external-test-report"),
    ).toBeNull();
    expect(
      db
        .prepare("SELECT id FROM processes WHERE id = ?")
        .get("proc-external-test-report"),
    ).toBeNull();
    expect(
      db
        .prepare(
          "SELECT id, event_id, run_id, process_id, path, parser, parse_status, tests, failures, errors, skipped, case_stored_count FROM test_reports WHERE id = ?",
        )
        .get("report-external-test-report"),
    ).toMatchObject({
      id: "report-external-test-report",
      event_id: "external-test-report-event",
      run_id: "run-external-test-report",
      process_id: "proc-external-test-report",
      path: "test-results/junit.xml",
      parser: "junit-xml-v1",
      parse_status: "parsed",
      tests: 1,
      failures: 0,
      errors: 0,
      skipped: 0,
      case_stored_count: 0,
    });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM test_cases WHERE report_id = ?")
        .get("report-external-test-report"),
    ).toEqual({ count: 0 });

    db.run("DELETE FROM event_records");
    const rebuilt = rebuildEventStoreIndex(db);
    expect(rebuilt.errors).toEqual([]);
    expect(rebuilt.skipped_events).toBe(0);
    expect(
      db
        .prepare("SELECT id FROM runs WHERE id = ?")
        .get("run-external-test-report"),
    ).toBeNull();
    expect(
      db
        .prepare("SELECT id FROM processes WHERE id = ?")
        .get("proc-external-test-report"),
    ).toBeNull();
    expect(
      db
        .prepare("SELECT metadata FROM event_records WHERE event_id = ?")
        .get("external-test-report-event"),
    ).toMatchObject({
      metadata: expect.stringContaining("report-external-test-report"),
    });
    expect(
      db
        .prepare(
          "SELECT id, event_id, run_id, process_id, path, tests FROM test_reports WHERE id = ?",
        )
        .get("report-external-test-report"),
    ).toMatchObject({
      id: "report-external-test-report",
      event_id: "external-test-report-event",
      run_id: "run-external-test-report",
      process_id: "proc-external-test-report",
      path: "test-results/junit.xml",
      tests: 1,
    });
    expect(verifyEventStore(db).ok).toBe(true);
  });

  it("keeps arbitrary external test report bodies out of SQLite metadata projections", () => {
    const db = createTestDb();
    ingestUniversalEvent(db, {
      type: "build",
      event_id: "external-test-report-privacy-event",
      event_time: "2026-06-16T08:05:00.000Z",
      source: "test",
      process_id: "proc-external-test-report-privacy",
      run_id: "run-external-test-report-privacy",
      attributes: {
        category: "test_report",
        scanner: "external-junit",
        path: "test-results/privacy.xml",
      },
      body: {
        test_report: {
          report_id: "report-external-test-report-privacy",
          path: "test-results/privacy.xml",
          format: "junit_xml",
          parser: "external-junit",
          parse_status: "parsed",
          tests: 2,
          failures: 1,
          errors: 0,
          skipped: 0,
          suite_count: 1,
          testcase_count: 2,
          raw_xml: "<testsuite>raw xml should not persist</testsuite>",
          "system-out": "suite stdout body should not persist",
          suites: [
            {
              name: "external suite",
              cases: [
                {
                  name: "fails externally",
                  classname: "external.Case",
                  file: "src/external.test.ts",
                  status: "failed",
                  time_seconds: 0.12,
                  failure: {
                    message: "non-secret failure body should not persist",
                  },
                  "system-out": "case stdout body should not persist",
                  raw_xml:
                    "<testcase>case raw xml should not persist</testcase>",
                },
              ],
            },
          ],
        },
      },
    });

    const forbidden = [
      "non-secret failure body should not persist",
      "suite stdout body should not persist",
      "case stdout body should not persist",
      "raw xml should not persist",
    ];
    const readMetadataText = () => {
      const record = db
        .prepare("SELECT metadata FROM event_records WHERE event_id = ?")
        .get("external-test-report-privacy-event") as {
        metadata: string;
      } | null;
      const report = db
        .prepare("SELECT metadata FROM test_reports WHERE id = ?")
        .get("report-external-test-report-privacy") as {
        metadata: string;
      } | null;
      const testcase = db
        .prepare("SELECT metadata FROM test_cases WHERE report_id = ?")
        .get("report-external-test-report-privacy") as {
        metadata: string;
      } | null;
      return [
        record?.metadata ?? "",
        report?.metadata ?? "",
        testcase?.metadata ?? "",
      ].join("\n");
    };

    const caseRow = db
      .prepare(
        "SELECT name, classname, file, status, time_seconds FROM test_cases WHERE report_id = ?",
      )
      .get("report-external-test-report-privacy");
    expect(caseRow).toEqual({
      name: "fails externally",
      classname: "external.Case",
      file: "src/external.test.ts",
      status: "failed",
      time_seconds: 0.12,
    });
    expect(
      db
        .prepare("SELECT case_stored_count FROM test_reports WHERE id = ?")
        .get("report-external-test-report-privacy"),
    ).toEqual({ case_stored_count: 1 });
    let metadataText = readMetadataText();
    expect(metadataText).toContain("bounded_raw_cases");
    for (const value of forbidden) expect(metadataText).not.toContain(value);

    db.run("DELETE FROM event_records");
    const rebuilt = rebuildEventStoreIndex(db);
    expect(rebuilt.errors).toEqual([]);
    expect(rebuilt.skipped_events).toBe(0);
    metadataText = readMetadataText();
    expect(metadataText).toContain("bounded_raw_cases");
    for (const value of forbidden) expect(metadataText).not.toContain(value);
    expect(verifyEventStore(db).ok).toBe(true);
  });

  it("enriches projection placeholders from later universal events", () => {
    const db = createTestDb();
    const project = db
      .prepare(
        "INSERT INTO projects (name) VALUES ('placeholder-enrich') RETURNING id",
      )
      .get() as { id: string };

    ingestUniversalEvent(db, {
      type: "artifact",
      event_id: "universal-artifact-before-release",
      source: "ci",
      release_id: "release-placeholder",
      artifact_id: "artifact-placeholder",
      attributes: {
        artifact_type: "bundle",
        path: "dist/app.js",
      },
    });
    ingestUniversalEvent(db, {
      type: "release",
      event_id: "universal-release-after-artifact",
      source: "ci",
      project_id: project.id,
      app_id: "app-placeholder",
      release_id: "release-placeholder",
      attributes: {
        version: "1.2.3",
        commit_sha: "abcdef123456",
        build_id: "build-placeholder",
      },
    });

    const release = db
      .prepare(
        "SELECT project_id, app_id, version, commit_sha, build_id FROM releases WHERE id = ?",
      )
      .get("release-placeholder") as {
      project_id: string | null;
      app_id: string | null;
      version: string | null;
      commit_sha: string | null;
      build_id: string | null;
    } | null;
    expect(release).toEqual({
      project_id: project.id,
      app_id: "app-placeholder",
      version: "1.2.3",
      commit_sha: "abcdef123456",
      build_id: "build-placeholder",
    });

    ingestUniversalEvent(db, {
      type: "network",
      event_id: "universal-trace-placeholder",
      event_time: "2026-06-16T08:00:10.000Z",
      source: "browser",
      project_id: project.id,
      app_id: "app-placeholder",
      trace_id: "trace-placeholder",
      message: "fetch in trace",
    });
    ingestUniversalEvent(db, {
      type: "span",
      event_id: "universal-trace-detail-span",
      event_time: "2026-06-16T08:00:11.000Z",
      source: "otel",
      project_id: project.id,
      app_id: "app-placeholder",
      trace_id: "trace-placeholder",
      span_id: "span-placeholder",
      attributes: {
        name: "trace placeholder span",
        operation: "http.client",
        started_at: "2026-06-16T08:00:00.000Z",
        ended_at: "2026-06-16T08:00:12.000Z",
        status: "ok",
      },
    });

    const trace = db
      .prepare(
        "SELECT project_id, app_id, root_span_id, started_at, ended_at, status FROM traces WHERE id = ?",
      )
      .get("trace-placeholder") as {
      project_id: string | null;
      app_id: string | null;
      root_span_id: string | null;
      started_at: string | null;
      ended_at: string | null;
      status: string | null;
    } | null;
    expect(trace).toEqual({
      project_id: project.id,
      app_id: "app-placeholder",
      root_span_id: "span-placeholder",
      started_at: "2026-06-16T08:00:00.000Z",
      ended_at: "2026-06-16T08:00:12.000Z",
      status: "ok",
    });

    ingestUniversalEvent(db, {
      type: "network",
      event_id: "universal-session-placeholder",
      event_time: "2026-06-16T08:00:10.000Z",
      source: "browser",
      project_id: project.id,
      app_id: "app-placeholder",
      session_id: "session-placeholder",
      message: "fetch in session",
    });
    ingestUniversalEvent(db, {
      type: "session",
      event_id: "universal-session-detail",
      event_time: "2026-06-16T08:00:11.000Z",
      source: "browser",
      project_id: project.id,
      app_id: "app-placeholder",
      session_id: "session-placeholder",
      attributes: {
        started_at: "2026-06-16T08:00:00.000Z",
        ended_at: "2026-06-16T08:00:12.000Z",
        status: "healthy",
        user_hash: "user-placeholder",
      },
    });

    const session = db
      .prepare(
        "SELECT project_id, app_id, user_hash, started_at, ended_at, status FROM sessions WHERE id = ?",
      )
      .get("session-placeholder") as {
      project_id: string | null;
      app_id: string | null;
      user_hash: string | null;
      started_at: string | null;
      ended_at: string | null;
      status: string | null;
    } | null;
    expect(session).toEqual({
      project_id: project.id,
      app_id: "app-placeholder",
      user_hash: "user-placeholder",
      started_at: "2026-06-16T08:00:00.000Z",
      ended_at: "2026-06-16T08:00:12.000Z",
      status: "healthy",
    });
  });
});
