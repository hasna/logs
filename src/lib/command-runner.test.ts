import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDb } from "../db/index.ts";
import { runCommand } from "./command-runner.ts";
import {
  getEventRecord,
  readRawEvent,
  rebuildEventStoreIndex,
  replayRawEvents,
  verifyEventStore,
} from "./event-store.ts";
import { REDACTED } from "./redaction.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("command runner", () => {
  it("captures process lifecycle and stdout/stderr as raw-backed telemetry", async () => {
    const db = createTestDb();
    const result = await runCommand(
      db,
      [
        process.execPath,
        "-e",
        "console.log('runner-out'); console.error('runner-err'); setTimeout(() => process.exit(2), 80)",
      ],
      {
        cwd: repoRoot,
        tee: false,
        service: "runner-test",
        environment: "test",
      },
    );

    expect(result.exit_code).toBe(2);
    expect(result.status).toBe("failed");
    expect(result.stdout_lines).toBe(1);
    expect(result.stderr_lines).toBe(1);
    expect(result.run_id).toStartWith("run_");
    expect(result.process_id).toStartWith("proc_");
    expect(result.resource_usage.sampler).toBe(
      process.platform === "linux" ? "linux-procfs" : "unsupported",
    );
    if (process.platform === "linux") {
      expect(result.resource_usage.available).toBe(true);
      expect(result.resource_usage.sample_count).toBeGreaterThan(0);
      expect(result.resource_usage.rss_bytes_peak).toBeGreaterThan(0);
    }

    const processRow = db
      .prepare("SELECT * FROM processes WHERE id = ?")
      .get(result.process_id) as {
      id: string;
      pid: number;
      exit_code: number;
      ended_at: string | null;
      machine_id: string | null;
      repo_id: string | null;
      app_id: string | null;
    } | null;
    const runRow = db
      .prepare("SELECT * FROM runs WHERE id = ?")
      .get(result.run_id) as {
      id: string;
      process_id: string;
      status: string;
      exit_code: number;
    } | null;
    expect(processRow?.exit_code).toBe(2);
    expect(processRow?.ended_at).toBeTruthy();
    const machineId = processRow?.machine_id;
    const appId = processRow?.app_id;
    expect(machineId).toStartWith("machine_");
    expect(appId).toStartWith("app_");
    if (!machineId || !appId)
      throw new Error(
        "Expected command runner to detect machine and app identity",
      );
    expect(runRow).toMatchObject({
      process_id: result.process_id,
      status: "failed",
      exit_code: 2,
    });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM machines WHERE id = ?")
        .get(machineId) as { count: number },
    ).toEqual({ count: 1 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM apps WHERE id = ?")
        .get(appId) as { count: number },
    ).toEqual({ count: 1 });
    if (processRow?.repo_id) {
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM repositories WHERE id = ?")
          .get(processRow.repo_id) as { count: number },
      ).toEqual({ count: 1 });
    }

    const logs = db
      .prepare(
        "SELECT message, level, source, service FROM logs ORDER BY timestamp ASC",
      )
      .all() as Array<{
      message: string;
      level: string;
      source: string;
      service: string;
    }>;
    logs.sort((a, b) => a.message.localeCompare(b.message));
    expect(logs).toEqual([
      {
        message: "runner-err",
        level: "error",
        source: "cli",
        service: "runner-test",
      },
      {
        message: "runner-out",
        level: "info",
        source: "cli",
        service: "runner-test",
      },
    ]);

    const stdoutRecord = getEventRecord(db, `${result.run_id}-stdout-1`);
    const stderrRecord = getEventRecord(db, `${result.run_id}-stderr-1`);
    expect(stdoutRecord).toMatchObject({
      run_id: result.run_id,
      process_id: result.process_id,
      event_type: "log",
      machine_id: processRow?.machine_id,
      app_id: processRow?.app_id,
    });
    expect(stderrRecord).toMatchObject({
      run_id: result.run_id,
      process_id: result.process_id,
      event_type: "log",
      machine_id: processRow?.machine_id,
      app_id: processRow?.app_id,
    });

    const stdoutRaw = readRawEvent(db, `${result.run_id}-stdout-1`);
    expect(stdoutRaw?.body?.log).toMatchObject({
      message: "runner-out",
      source: "cli",
      process_id: result.process_id,
      run_id: result.run_id,
      environment: "test",
    });

    const processEvents = db
      .prepare(
        "SELECT event_id, event_type, source_event_id, message FROM event_records WHERE run_id = ? AND event_type = 'process' AND source_event_id LIKE ? ORDER BY event_time ASC",
      )
      .all(result.run_id, `${result.run_id}:process:%`) as Array<{
      event_id: string;
      event_type: string;
      source_event_id: string;
      message: string;
    }>;
    expect(processEvents).toHaveLength(3);
    expect(processEvents.map((event) => event.source_event_id)).toEqual(
      expect.arrayContaining([
        `${result.run_id}:process:start`,
        `${result.run_id}:process:exit`,
        `${result.run_id}:process:tree`,
      ]),
    );
    expect(
      processEvents.find(
        (event) => event.source_event_id === `${result.run_id}:process:start`,
      )?.message,
    ).toContain("Process started");
    expect(
      processEvents.find(
        (event) => event.source_event_id === `${result.run_id}:process:exit`,
      )?.message,
    ).toContain("Process exited 2");

    const resourceRecord = getEventRecord(db, `${result.run_id}-resource`);
    expect(resourceRecord).toMatchObject({
      run_id: result.run_id,
      process_id: result.process_id,
      event_type: "metric",
      source: "cli",
      severity: "info",
      machine_id: processRow?.machine_id,
      app_id: processRow?.app_id,
    });
    expect(resourceRecord?.source_event_id).toBe(
      `${result.run_id}:process:resource_usage`,
    );
    const resourceMetadata = JSON.parse(
      resourceRecord?.metadata ?? "{}",
    ) as Record<string, unknown>;
    expect(resourceMetadata).toMatchObject({
      category: "process_resource_usage",
      metric_name: "process.resource.peak_rss",
      metric_kind: "gauge",
      metric_unit: "bytes",
      sampler: result.resource_usage.sampler,
      resource_available: result.resource_usage.available,
      sample_count: result.resource_usage.sample_count,
    });
    expect(resourceMetadata.command).toBeUndefined();
    expect(resourceMetadata.cwd).toBeUndefined();
    const resourceRaw = readRawEvent(db, `${result.run_id}-resource`);
    expect(resourceRaw).toMatchObject({
      type: "metric",
      source: "cli",
      process_id: result.process_id,
      run_id: result.run_id,
      attributes: {
        category: "process_resource_usage",
        metric_name: "process.resource.peak_rss",
      },
    });
    const resourceBody = resourceRaw?.body as
      | Record<string, unknown>
      | undefined;
    const metricValue =
      result.resource_usage.rss_bytes_peak ??
      result.resource_usage.rss_bytes_last;
    expect(resourceBody).toMatchObject({
      name: "process.resource.peak_rss",
      value: metricValue,
      kind: "gauge",
      unit: "bytes",
    });
    expect(resourceBody?.command).toBeUndefined();
    expect(resourceBody?.cwd).toBeUndefined();
    expect(resourceRaw?.attributes?.command).toBeUndefined();
    expect(resourceRaw?.attributes?.cwd).toBeUndefined();
    const processResource = resourceRaw?.body?.process_resource as
      | Record<string, unknown>
      | undefined;
    expect(processResource).toMatchObject({
      sampler: result.resource_usage.sampler,
      available: result.resource_usage.available,
      sample_count: result.resource_usage.sample_count,
    });
    expect(processResource?.command).toBeUndefined();
    expect(processResource?.cwd).toBeUndefined();
    const treeRecord = getEventRecord(db, `${result.run_id}-process-tree`);
    expect(treeRecord).toMatchObject({
      run_id: result.run_id,
      process_id: result.process_id,
      event_type: "process",
      source: "cli",
      severity: "info",
      machine_id: processRow?.machine_id,
      app_id: processRow?.app_id,
    });
    expect(treeRecord?.source_event_id).toBe(`${result.run_id}:process:tree`);
    const treeMetadata = JSON.parse(treeRecord?.metadata ?? "{}") as Record<
      string,
      unknown
    >;
    expect(treeMetadata).toMatchObject({
      category: "process_tree",
      sampler: result.process_tree.sampler,
      tree_available: result.process_tree.available,
      sample_count: result.process_tree.sample_count,
    });
    expect(treeMetadata.command).toBeUndefined();
    expect(treeMetadata.cwd).toBeUndefined();
    const treeRaw = readRawEvent(db, `${result.run_id}-process-tree`);
    expect(treeRaw).toMatchObject({
      type: "process",
      source: "cli",
      process_id: result.process_id,
      run_id: result.run_id,
      attributes: {
        category: "process_tree",
      },
    });
    const treeBody = treeRaw?.body?.process_tree as
      | Record<string, unknown>
      | undefined;
    expect(treeBody).toMatchObject({
      sampler: result.process_tree.sampler,
      available: result.process_tree.available,
      sample_count: result.process_tree.sample_count,
      descendant_count_peak: result.process_tree.descendant_count_peak,
    });
    expect(treeBody?.command).toBeUndefined();
    expect(treeBody?.cwd).toBeUndefined();
    expect(treeRaw?.attributes?.command).toBeUndefined();
    expect(treeRaw?.attributes?.cwd).toBeUndefined();
    const updatedProcessMetadata = JSON.parse(
      (
        db
          .prepare("SELECT metadata FROM processes WHERE id = ?")
          .get(result.process_id) as { metadata: string }
      ).metadata,
    ) as Record<string, unknown>;
    expect(updatedProcessMetadata.resource_usage).toMatchObject({
      sampler: result.resource_usage.sampler,
      sample_count: result.resource_usage.sample_count,
    });
    expect(updatedProcessMetadata.process_tree).toMatchObject({
      sampler: result.process_tree.sampler,
      sample_count: result.process_tree.sample_count,
    });
    expect(verifyEventStore(db).ok).toBe(true);
  });

  it("captures bounded child process tree telemetry without command payloads", async () => {
    const db = createTestDb();
    const result = await runCommand(
      db,
      [
        process.execPath,
        "-e",
        [
          "const { spawn } = require('node:child_process');",
          "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1000)'], { stdio: 'ignore' });",
          "child.on('error', (error) => { console.error(error.message); process.exit(2); });",
          "setTimeout(() => child.kill('SIGTERM'), 450);",
          "child.on('exit', () => process.exit(0));",
          "setTimeout(() => process.exit(3), 900);",
        ].join(" "),
      ],
      {
        cwd: repoRoot,
        tee: false,
        service: "runner-tree-test",
        environment: "test",
      },
    );

    expect(result.exit_code).toBe(0);
    expect(result.process_tree.sampler).toBe(
      process.platform === "linux" ? "linux-procfs" : "unsupported",
    );
    if (process.platform === "linux") {
      expect(result.process_tree.available).toBe(true);
      expect(result.process_tree.sample_count).toBeGreaterThan(0);
      expect(result.process_tree.direct_child_count_peak).toBeGreaterThan(0);
      expect(result.process_tree.descendant_count_peak).toBeGreaterThan(0);
      expect(result.process_tree.observed_pid_count).toBeGreaterThan(0);
      expect(result.process_tree.peak_tree.length).toBeGreaterThan(0);
      expect(
        result.process_tree.peak_tree.some((node) => node.depth === 1),
      ).toBe(true);
    }

    const treeRecord = getEventRecord(db, `${result.run_id}-process-tree`);
    expect(treeRecord).toMatchObject({
      event_type: "process",
      source_event_id: `${result.run_id}:process:tree`,
      run_id: result.run_id,
      process_id: result.process_id,
    });
    const treeMetadata = JSON.parse(treeRecord?.metadata ?? "{}") as Record<
      string,
      unknown
    >;
    expect(treeMetadata).toMatchObject({
      category: "process_tree",
      sampler: result.process_tree.sampler,
      sample_count: result.process_tree.sample_count,
      descendant_count_peak: result.process_tree.descendant_count_peak,
    });
    expect(treeMetadata.command).toBeUndefined();
    expect(treeMetadata.cwd).toBeUndefined();

    const treeRaw = readRawEvent(db, `${result.run_id}-process-tree`);
    const processTree = treeRaw?.body?.process_tree as
      | Record<string, unknown>
      | undefined;
    expect(processTree).toMatchObject({
      sampler: result.process_tree.sampler,
      sample_count: result.process_tree.sample_count,
      descendant_count_peak: result.process_tree.descendant_count_peak,
    });
    expect(processTree?.command).toBeUndefined();
    expect(processTree?.cwd).toBeUndefined();
    expect(treeRaw?.attributes?.command).toBeUndefined();
    expect(treeRaw?.attributes?.cwd).toBeUndefined();
    const peakTree = processTree?.peak_tree as Array<Record<string, unknown>>;
    if (process.platform === "linux") {
      expect(peakTree.length).toBeGreaterThan(0);
      expect(peakTree.some((node) => node.depth === 1)).toBe(true);
    }
    for (const node of peakTree ?? []) {
      expect(node.command).toBeUndefined();
      expect(node.cwd).toBeUndefined();
    }
    expect(verifyEventStore(db).ok).toBe(true);
  });

  it("discovers build artifacts as raw events and SQLite metadata", async () => {
    const db = createTestDb();
    const tempDir = mkdtempSync(join(tmpdir(), "open-logs-artifacts-"));
    const sourceContentCanary =
      "OPENLOGS_SOURCE_MAP_CONTENT_SHOULD_NOT_PERSIST";
    try {
      mkdirSync(join(tempDir, "dist"), { recursive: true });
      writeFileSync(join(tempDir, "dist", "old.js"), "old", "utf8");
      writeFileSync(
        join(tempDir, "source-map-source.txt"),
        sourceContentCanary,
        "utf8",
      );

      const result = await runCommand(
        db,
        [
          process.execPath,
          "-e",
          [
            "const fs = require('node:fs');",
            "fs.mkdirSync('dist', { recursive: true });",
            "const sourceContent = fs.readFileSync('source-map-source.txt', 'utf8');",
            "fs.writeFileSync('dist/app.js', \"console.log('built');\\n\");",
            "fs.writeFileSync('dist/app.js.map', JSON.stringify({ version: 3, file: 'app.js', sources: ['src/app.ts'], sourcesContent: [sourceContent], names: ['boot'], mappings: 'AAAA' }));",
            "fs.writeFileSync('dist/old.js', \"console.log('modified');\\n\");",
          ].join(" "),
          "build",
        ],
        {
          cwd: tempDir,
          tee: false,
          service: "artifact-build-test",
          environment: "test",
        },
      );

      expect(result.exit_code).toBe(0);
      expect(result.run_type).toBe("build");
      expect(result.artifacts).toMatchObject({
        scanner: "common-output-roots",
        available: true,
        discovered_count: 3,
        emitted_count: 3,
        truncated: false,
      });
      expect(result.artifacts.scanned_roots).toContain("dist");
      const artifactsByPath = new Map(
        result.artifacts.artifacts.map((artifact) => [artifact.path, artifact]),
      );
      expect([...artifactsByPath.keys()].sort()).toEqual([
        "dist/app.js",
        "dist/app.js.map",
        "dist/old.js",
      ]);
      expect(artifactsByPath.get("dist/app.js")).toMatchObject({
        artifact_type: "javascript",
        changed: "created",
      });
      expect(artifactsByPath.get("dist/app.js.map")).toMatchObject({
        artifact_type: "source_map",
        changed: "created",
      });
      const sourceMapArtifact = artifactsByPath.get("dist/app.js.map");
      if (!sourceMapArtifact?.source_map)
        throw new Error("expected source map metadata");
      expect(sourceMapArtifact.source_map).toMatchObject({
        source_map_artifact_id: sourceMapArtifact.artifact_id,
        source_map_path: "dist/app.js.map",
        javascript_artifact_id: artifactsByPath.get("dist/app.js")?.artifact_id,
        javascript_path: "dist/app.js",
        linked_by: "adjacent_path",
        version: 3,
        validation_status: "parsed",
        validation_error: null,
        file: "app.js",
        source_root: null,
        source_count: 1,
        names_count: 1,
        mappings_length: 4,
        has_sources_content: true,
        truncated: false,
        source_storage_policy: "paths_and_hashes_only",
      });
      expect(sourceMapArtifact.source_map.sources).toHaveLength(1);
      expect(sourceMapArtifact.source_map.sources[0]).toMatchObject({
        ordinal: 0,
        source_path: "src/app.ts",
        has_content: true,
      });
      expect(sourceMapArtifact.source_map.sources[0]?.content_hash).toMatch(
        /^[a-f0-9]{64}$/,
      );
      expect(artifactsByPath.get("dist/old.js")).toMatchObject({
        artifact_type: "javascript",
        changed: "modified",
      });

      for (const artifact of result.artifacts.artifacts) {
        expect(artifact.path).not.toStartWith(tempDir);
        expect(artifact.content_hash).toMatch(/^[a-f0-9]{64}$/);
        const record = getEventRecord(db, artifact.artifact_id);
        expect(record).toMatchObject({
          event_type: "artifact",
          source: "build",
          source_event_id: `${result.run_id}:artifact:${artifact.artifact_id}`,
          artifact_id: artifact.artifact_id,
          run_id: result.run_id,
          process_id: result.process_id,
          privacy_tier: "internal",
        });
        const metadata = JSON.parse(record?.metadata ?? "{}") as Record<
          string,
          unknown
        >;
        expect(metadata).toMatchObject({
          category: "build_artifact",
          scanner: "common-output-roots",
          path: artifact.path,
          content_hash: artifact.content_hash,
          changed: artifact.changed,
        });
        const raw = readRawEvent(db, artifact.artifact_id);
        expect(raw).toMatchObject({
          type: "artifact",
          source: "build",
          run_id: result.run_id,
          process_id: result.process_id,
          attributes: {
            category: "build_artifact",
            path: artifact.path,
          },
        });
        const rawArtifact = raw?.body?.artifact as
          | Record<string, unknown>
          | undefined;
        expect(rawArtifact).toMatchObject({
          artifact_id: artifact.artifact_id,
          artifact_type: artifact.artifact_type,
          path: artifact.path,
          content_hash: artifact.content_hash,
        });
        expect(rawArtifact?.content).toBeUndefined();
        expect(rawArtifact?.sourcesContent).toBeUndefined();
        expect(JSON.stringify(raw)).not.toContain("console.log('built')");
        expect(JSON.stringify(raw)).not.toContain("console.log('modified')");
        expect(JSON.stringify(raw)).not.toContain(sourceContentCanary);
      }

      const rows = db
        .prepare(
          "SELECT id, artifact_type, path, content_hash, size_bytes, metadata FROM artifacts ORDER BY path",
        )
        .all() as Array<{
        id: string;
        artifact_type: string;
        path: string;
        content_hash: string | null;
        size_bytes: number;
        metadata: string;
      }>;
      expect(rows.map((row) => row.path)).toEqual([
        "dist/app.js",
        "dist/app.js.map",
        "dist/old.js",
      ]);
      for (const row of rows) {
        const artifact = artifactsByPath.get(row.path);
        expect(row).toMatchObject({
          id: artifact?.artifact_id,
          artifact_type: artifact?.artifact_type,
          content_hash: artifact?.content_hash,
          size_bytes: artifact?.size_bytes,
        });
        const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
        expect(metadata.category).toBe("build_artifact");
        expect(JSON.stringify(metadata)).not.toContain(sourceContentCanary);
      }
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM source_maps").get(),
      ).toEqual({ count: 1 });
      const javascriptArtifact = artifactsByPath.get("dist/app.js");
      if (!javascriptArtifact) throw new Error("expected JavaScript artifact");
      expect(
        db
          .prepare("SELECT id FROM source_maps WHERE id = ?")
          .get(javascriptArtifact.artifact_id),
      ).toBeNull();
      const sourceMapRow = db
        .prepare(
          `
            SELECT
              id, source_map_artifact_id, javascript_artifact_id,
              source_map_path, javascript_path, version, validation_status,
              validation_error, source_count, names_count, mappings_length,
              has_sources_content, truncated, metadata
            FROM source_maps
            WHERE id = ?
          `,
        )
        .get(sourceMapArtifact.artifact_id) as
        | {
            id: string;
            source_map_artifact_id: string;
            javascript_artifact_id: string | null;
            source_map_path: string;
            javascript_path: string;
            version: number;
            validation_status: string;
            validation_error: string | null;
            source_count: number;
            names_count: number;
            mappings_length: number;
            has_sources_content: number;
            truncated: number;
            metadata: string;
          }
        | undefined;
      expect(sourceMapRow).toMatchObject({
        id: sourceMapArtifact.artifact_id,
        source_map_artifact_id: sourceMapArtifact.artifact_id,
        javascript_artifact_id: artifactsByPath.get("dist/app.js")?.artifact_id,
        source_map_path: "dist/app.js.map",
        javascript_path: "dist/app.js",
        version: 3,
        validation_status: "parsed",
        validation_error: null,
        source_count: 1,
        names_count: 1,
        mappings_length: 4,
        has_sources_content: 1,
        truncated: 0,
      });
      const sourceMapMetadata = JSON.parse(
        sourceMapRow?.metadata ?? "{}",
      ) as Record<string, unknown>;
      expect(sourceMapMetadata.source_storage_policy).toBe(
        "paths_and_hashes_only",
      );
      expect(JSON.stringify(sourceMapMetadata)).not.toContain(
        sourceContentCanary,
      );
      const sourceRows = db
        .prepare(
          "SELECT source_map_id, ordinal, source_path, has_content, content_hash, metadata FROM source_map_sources ORDER BY ordinal",
        )
        .all() as Array<{
        source_map_id: string;
        ordinal: number;
        source_path: string;
        has_content: number;
        content_hash: string | null;
        metadata: string;
      }>;
      expect(sourceRows).toHaveLength(1);
      expect(sourceRows[0]).toMatchObject({
        source_map_id: sourceMapArtifact.artifact_id,
        ordinal: 0,
        source_path: "src/app.ts",
        has_content: 1,
      });
      expect(sourceRows[0]?.content_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(sourceRows)).not.toContain(sourceContentCanary);

      const rebuilt = rebuildEventStoreIndex(db);
      expect(rebuilt.errors).toEqual([]);
      expect(rebuilt.skipped_events).toBe(0);
      const rebuiltRows = db
        .prepare("SELECT path, artifact_type FROM artifacts ORDER BY path")
        .all() as Array<{ path: string; artifact_type: string }>;
      expect(rebuiltRows).toEqual([
        { path: "dist/app.js", artifact_type: "javascript" },
        { path: "dist/app.js.map", artifact_type: "source_map" },
        { path: "dist/old.js", artifact_type: "javascript" },
      ]);
      const rebuiltSourceMap = db
        .prepare(
          "SELECT javascript_path, validation_status, source_count FROM source_maps WHERE id = ?",
        )
        .get(sourceMapArtifact.artifact_id) as
        | {
            javascript_path: string;
            validation_status: string;
            source_count: number;
          }
        | undefined;
      expect(rebuiltSourceMap).toEqual({
        javascript_path: "dist/app.js",
        validation_status: "parsed",
        source_count: 1,
      });
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM source_maps").get(),
      ).toEqual({ count: 1 });
      expect(
        db
          .prepare(
            "SELECT source_path FROM source_map_sources WHERE source_map_id = ?",
          )
          .get(sourceMapArtifact.artifact_id),
      ).toEqual({ source_path: "src/app.ts" });
      expect(verifyEventStore(db).ok).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("sanitizes source-map host paths and links file-field maps", async () => {
    const db = createTestDb();
    const tempDir = mkdtempSync(join(tmpdir(), "open-logs-sm-file-field-"));
    const sourceContentCanary =
      "OPENLOGS_SOURCE_MAP_FILE_FIELD_CONTENT_SHOULD_NOT_PERSIST";
    try {
      mkdirSync(join(tempDir, "dist"), { recursive: true });
      writeFileSync(
        join(tempDir, "source-map-source.txt"),
        sourceContentCanary,
        "utf8",
      );

      const result = await runCommand(
        db,
        [
          process.execPath,
          "-e",
          [
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            "fs.mkdirSync('dist', { recursive: true });",
            "const sourceContent = fs.readFileSync('source-map-source.txt', 'utf8');",
            "const absoluteSource = path.join(process.cwd(), 'src', 'app.ts');",
            "fs.writeFileSync('dist/app.js', \"console.log('file-field');\\n\");",
            "fs.writeFileSync('dist/app.map', JSON.stringify({ version: 3, file: 'app.js', sourceRoot: process.cwd(), sources: [absoluteSource], sourcesContent: [sourceContent], names: ['boot'], mappings: 'AAAA' }));",
          ].join(" "),
          "build",
        ],
        {
          cwd: tempDir,
          tee: false,
          service: "source-map-file-field-test",
          environment: "test",
        },
      );

      expect(result.exit_code).toBe(0);
      const artifactsByPath = new Map(
        result.artifacts.artifacts.map((artifact) => [artifact.path, artifact]),
      );
      const javascriptArtifact = artifactsByPath.get("dist/app.js");
      const sourceMapArtifact = artifactsByPath.get("dist/app.map");
      if (!javascriptArtifact || !sourceMapArtifact?.source_map)
        throw new Error("expected JavaScript and source-map artifacts");

      expect(sourceMapArtifact.source_map).toMatchObject({
        source_map_path: "dist/app.map",
        javascript_path: "dist/app.js",
        javascript_artifact_id: javascriptArtifact.artifact_id,
        linked_by: "file_field",
        file: "app.js",
        validation_status: "parsed",
        has_sources_content: true,
      });
      expect(sourceMapArtifact.source_map.source_root).toStartWith(
        "[source-map-host_path:",
      );
      expect(sourceMapArtifact.source_map.sources).toHaveLength(1);
      expect(sourceMapArtifact.source_map.sources[0]?.source_path).toStartWith(
        "[source-map-host_path:",
      );
      expect(sourceMapArtifact.source_map.sources[0]?.content_hash).toMatch(
        /^[a-f0-9]{64}$/,
      );
      expect(JSON.stringify(sourceMapArtifact.source_map)).not.toContain(
        sourceContentCanary,
      );
      expect(JSON.stringify(sourceMapArtifact.source_map)).not.toContain(
        tempDir,
      );

      const raw = readRawEvent(db, sourceMapArtifact.artifact_id);
      const rawText = JSON.stringify(raw);
      expect(rawText).not.toContain(sourceContentCanary);
      expect(rawText).not.toContain(tempDir);
      expect(rawText).not.toContain("sourcesContent");
      expect(rawText).not.toContain('"mappings"');
      expect(rawText).toContain("mappings_length");

      const row = db
        .prepare(
          "SELECT javascript_artifact_id, javascript_path, source_root, file FROM source_maps WHERE id = ?",
        )
        .get(sourceMapArtifact.artifact_id) as
        | {
            javascript_artifact_id: string;
            javascript_path: string;
            source_root: string;
            file: string;
          }
        | undefined;
      expect(row).toMatchObject({
        javascript_artifact_id: javascriptArtifact.artifact_id,
        javascript_path: "dist/app.js",
        file: "app.js",
      });
      expect(row?.source_root).toStartWith("[source-map-host_path:");
      expect(JSON.stringify(row)).not.toContain(tempDir);

      const sourceRow = db
        .prepare(
          "SELECT id, ordinal, source_path, has_content, content_hash FROM source_map_sources WHERE source_map_id = ?",
        )
        .get(sourceMapArtifact.artifact_id) as
        | {
            id: string;
            ordinal: number;
            source_path: string;
            has_content: number;
            content_hash: string | null;
          }
        | undefined;
      expect(sourceRow?.id).toStartWith("srcmap_source_");
      expect(sourceRow).toMatchObject({
        ordinal: 0,
        has_content: 1,
      });
      expect(sourceRow?.source_path).toStartWith("[source-map-host_path:");
      expect(sourceRow?.content_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(sourceRow)).not.toContain(sourceContentCanary);
      expect(JSON.stringify(sourceRow)).not.toContain(tempDir);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("redacts artifact paths before result and process metadata persistence", async () => {
    const db = createTestDb();
    const tempDir = mkdtempSync(join(tmpdir(), "open-logs-artifact-redact-"));
    const secret = "OPENLOGS_SECRET_CANARY_ARTIFACT_PATH_12345";
    try {
      const result = await runCommand(
        db,
        [
          process.execPath,
          "-e",
          [
            "const fs = require('node:fs');",
            "fs.mkdirSync('dist', { recursive: true });",
            "fs.writeFileSync(`dist/${process.env.ARTIFACT_NAME}.js`, 'artifact secret path test');",
          ].join(" "),
          "build",
        ],
        {
          cwd: tempDir,
          tee: false,
          service: "artifact-redaction-test",
          environment: "test",
          env: { ...process.env, ARTIFACT_NAME: secret },
        },
      );

      expect(result.exit_code).toBe(0);
      expect(result.artifacts.discovered_count).toBe(1);
      const resultDump = JSON.stringify(result);
      expect(resultDump).not.toContain(secret);
      expect(resultDump).toContain(REDACTED);

      const processMetadata = (
        db
          .prepare("SELECT metadata FROM processes WHERE id = ?")
          .get(result.process_id) as { metadata: string }
      ).metadata;
      const runMetadata = (
        db
          .prepare("SELECT metadata FROM runs WHERE id = ?")
          .get(result.run_id) as {
          metadata: string;
        }
      ).metadata;
      expect(processMetadata).not.toContain(secret);
      expect(runMetadata).not.toContain(secret);
      expect(processMetadata).toContain(REDACTED);
      expect(runMetadata).toContain(REDACTED);

      const artifactRecord = db
        .prepare(
          "SELECT message, metadata FROM event_records WHERE event_type = 'artifact' AND run_id = ?",
        )
        .get(result.run_id) as { message: string; metadata: string } | null;
      expect(artifactRecord?.message).not.toContain(secret);
      expect(artifactRecord?.metadata).not.toContain(secret);
      expect(artifactRecord?.metadata).toContain(REDACTED);
      expect(JSON.stringify(replayRawEvents(db))).not.toContain(secret);
      expect(verifyEventStore(db).ok).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("discovers JUnit test reports as raw-backed run metadata", async () => {
    const db = createTestDb();
    const tempDir = mkdtempSync(join(tmpdir(), "open-logs-junit-"));
    try {
      const result = await runCommand(
        db,
        [
          process.execPath,
          "-e",
          [
            "const fs = require('node:fs');",
            "fs.mkdirSync('test-results', { recursive: true });",
            'fs.writeFileSync(\'test-results/junit.xml\', `<?xml version="1.0" encoding="UTF-8"?>',
            '<testsuites tests="4" failures="1" errors="1" skipped="1" time="1.5">',
            '<testsuite name="unit suite" tests="4" failures="1" errors="1" skipped="1" time="1.5">',
            '<testcase classname="unit.Math" name="adds" file="src/math.test.ts" time="0.1"/>',
            '<testcase classname="unit.Math" name="fails" file="src/math.test.ts" time="0.2"><failure message="expected true">failure body is intentionally ignored</failure></testcase>',
            '<testcase classname="unit.Api" name="throws" file="src/api.test.ts" time="0.3"><error message="boom">error body is intentionally ignored</error></testcase>',
            '<testcase classname="unit.Skip" name="skips" file="src/skip.test.ts" time="0.4"><skipped/></testcase>',
            "<system-out>stdout body is intentionally ignored</system-out>",
            "</testsuite></testsuites>`);",
          ].join(" "),
          "test",
        ],
        {
          cwd: tempDir,
          tee: false,
          service: "junit-test",
          environment: "test",
        },
      );

      expect(result.exit_code).toBe(0);
      expect(result.run_type).toBe("test");
      expect(result.test_reports).toMatchObject({
        scanner: "common-test-report-roots",
        available: true,
        discovered_count: 1,
        emitted_count: 1,
        truncated: false,
      });
      expect(result.test_reports.scanned_roots).toContain("test-results");
      const report = result.test_reports.reports[0];
      if (!report) throw new Error("Expected parsed JUnit report");
      expect(report).toMatchObject({
        path: "test-results/junit.xml",
        format: "junit_xml",
        parser: "junit-xml-v1",
        parse_status: "parsed",
        tests: 4,
        failures: 1,
        errors: 1,
        skipped: 1,
        suite_count: 1,
        testcase_count: 4,
        changed: "created",
      });
      expect(report.content_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(report.suites).toHaveLength(1);
      expect(report.suites[0]).toMatchObject({
        name: "unit suite",
        tests: 4,
        failures: 1,
        errors: 1,
        skipped: 1,
        testcase_count: 4,
      });
      expect(
        report.suites[0]?.cases.map((testcase) => testcase.status),
      ).toEqual(["failed", "error", "skipped"]);

      const reportRecord = getEventRecord(db, report.report_id);
      expect(reportRecord).toMatchObject({
        event_type: "build",
        source: "test",
        severity: "error",
        source_event_id: `${result.run_id}:test_report:${report.report_id}`,
        run_id: result.run_id,
        process_id: result.process_id,
        privacy_tier: "internal",
      });
      const metadata = JSON.parse(reportRecord?.metadata ?? "{}") as Record<
        string,
        unknown
      >;
      expect(metadata).toMatchObject({
        category: "test_report",
        report_format: "junit_xml",
        parser: "junit-xml-v1",
        parse_status: "parsed",
        path: "test-results/junit.xml",
        tests: 4,
        failures: 1,
        errors: 1,
        skipped: 1,
        suite_count: 1,
        testcase_count: 4,
      });
      const raw = readRawEvent(db, report.report_id);
      expect(raw).toMatchObject({
        type: "build",
        source: "test",
        run_id: result.run_id,
        process_id: result.process_id,
        attributes: {
          category: "test_report",
          path: "test-results/junit.xml",
          tests: 4,
          failures: 1,
          errors: 1,
          skipped: 1,
        },
      });
      const rawReport = raw?.body?.test_report as
        | Record<string, unknown>
        | undefined;
      expect(rawReport).toMatchObject({
        report_id: report.report_id,
        path: "test-results/junit.xml",
        tests: 4,
        failures: 1,
        errors: 1,
        skipped: 1,
      });
      expect(JSON.stringify(raw)).not.toContain(
        "failure body is intentionally ignored",
      );
      expect(JSON.stringify(raw)).not.toContain(
        "stdout body is intentionally ignored",
      );

      const reportProjection = db
        .prepare(
          "SELECT id, event_id, run_id, process_id, path, parser, parse_status, tests, failures, errors, skipped, suite_count, testcase_count, case_stored_count, truncated FROM test_reports WHERE id = ?",
        )
        .get(report.report_id) as Record<string, unknown> | null;
      expect(reportProjection).toMatchObject({
        id: report.report_id,
        event_id: report.report_id,
        run_id: result.run_id,
        process_id: result.process_id,
        path: "test-results/junit.xml",
        parser: "junit-xml-v1",
        parse_status: "parsed",
        tests: 4,
        failures: 1,
        errors: 1,
        skipped: 1,
        suite_count: 1,
        testcase_count: 4,
        case_stored_count: 3,
        truncated: 0,
      });
      const caseRows = db
        .prepare(
          "SELECT report_id, run_id, suite_name, name, classname, file, status, time_seconds FROM test_cases WHERE report_id = ? ORDER BY suite_index, case_index",
        )
        .all(report.report_id) as Array<Record<string, unknown>>;
      expect(caseRows).toEqual([
        {
          report_id: report.report_id,
          run_id: result.run_id,
          suite_name: "unit suite",
          name: "fails",
          classname: "unit.Math",
          file: "src/math.test.ts",
          status: "failed",
          time_seconds: 0.2,
        },
        {
          report_id: report.report_id,
          run_id: result.run_id,
          suite_name: "unit suite",
          name: "throws",
          classname: "unit.Api",
          file: "src/api.test.ts",
          status: "error",
          time_seconds: 0.3,
        },
        {
          report_id: report.report_id,
          run_id: result.run_id,
          suite_name: "unit suite",
          name: "skips",
          classname: "unit.Skip",
          file: "src/skip.test.ts",
          status: "skipped",
          time_seconds: 0.4,
        },
      ]);

      const summaryRaw = readRawEvent(db, `${result.run_id}-summary`);
      const lifecycle = summaryRaw?.body?.lifecycle as
        | Record<string, unknown>
        | undefined;
      expect(lifecycle?.test_reports).toMatchObject({
        discovered_count: 1,
        emitted_count: 1,
      });
      const summaryMetadata = JSON.parse(
        getEventRecord(db, `${result.run_id}-summary`)?.metadata ?? "{}",
      ) as Record<string, unknown>;
      expect(summaryMetadata).toMatchObject({
        test_report_count: 1,
        test_report_tests: 4,
        test_report_failures: 1,
        test_report_errors: 1,
        test_report_skipped: 1,
      });

      const runMetadataBefore = JSON.parse(
        (
          db
            .prepare("SELECT metadata FROM runs WHERE id = ?")
            .get(result.run_id) as { metadata: string }
        ).metadata,
      ) as Record<string, unknown>;
      expect(runMetadataBefore.test_reports).toMatchObject({
        discovered_count: 1,
        emitted_count: 1,
      });

      const rebuilt = rebuildEventStoreIndex(db);
      expect(rebuilt.errors).toEqual([]);
      expect(rebuilt.skipped_events).toBe(0);
      const rebuiltRecord = getEventRecord(db, report.report_id);
      expect(rebuiltRecord).toMatchObject({
        event_type: "build",
        source_event_id: `${result.run_id}:test_report:${report.report_id}`,
      });
      const rebuiltRunMetadata = JSON.parse(
        (
          db
            .prepare("SELECT metadata FROM runs WHERE id = ?")
            .get(result.run_id) as { metadata: string }
        ).metadata,
      ) as Record<string, unknown>;
      expect(rebuiltRunMetadata.test_reports).toMatchObject({
        discovered_count: 1,
        emitted_count: 1,
      });
      expect(
        db
          .prepare(
            "SELECT id, event_id, run_id, case_stored_count FROM test_reports WHERE id = ?",
          )
          .get(report.report_id),
      ).toMatchObject({
        id: report.report_id,
        event_id: report.report_id,
        run_id: result.run_id,
        case_stored_count: 3,
      });
      expect(
        db
          .prepare(
            "SELECT status FROM test_cases WHERE report_id = ? ORDER BY suite_index, case_index",
          )
          .all(report.report_id),
      ).toEqual([
        { status: "failed" },
        { status: "error" },
        { status: "skipped" },
      ]);
      expect(verifyEventStore(db).ok).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("redacts JUnit report paths and parsed attributes without storing report bodies", async () => {
    const db = createTestDb();
    const tempDir = mkdtempSync(join(tmpdir(), "open-logs-junit-redact-"));
    const secret = "OPENLOGS_SECRET_CANARY_JUNIT_REPORT_24680";
    try {
      const result = await runCommand(
        db,
        [
          process.execPath,
          "-e",
          [
            "const fs = require('node:fs');",
            "const secret = process.env.JUNIT_CANARY;",
            "fs.mkdirSync('test-results', { recursive: true });",
            'fs.writeFileSync(`test-results/junit-${secret}.xml`, `<?xml version="1.0"?>',
            '<testsuites tests="1" failures="1" errors="0" skipped="0">',
            '<testsuite name="suite ${secret}" tests="1" failures="1" errors="0" skipped="0">',
            '<properties><property name="api_key" value="${secret}"/></properties>',
            '<testcase classname="class ${secret}" name="case ${secret}" file="src/${secret}.test.ts">',
            '<failure message="failure ${secret}">failure body ${secret}</failure>',
            "<system-out>stdout ${secret}</system-out>",
            "<system-err>stderr ${secret}</system-err>",
            "</testcase></testsuite></testsuites>`);",
          ].join(" "),
          "test",
        ],
        {
          cwd: tempDir,
          tee: false,
          service: "junit-redaction-test",
          environment: "test",
          env: { ...process.env, JUNIT_CANARY: secret },
        },
      );

      expect(result.exit_code).toBe(0);
      expect(result.test_reports.discovered_count).toBe(1);
      const resultDump = JSON.stringify(result);
      expect(resultDump).not.toContain(secret);
      expect(resultDump).toContain(REDACTED);

      const report = result.test_reports.reports[0];
      if (!report) throw new Error("Expected redacted JUnit report");
      const record = getEventRecord(db, report.report_id);
      expect(record?.message).not.toContain(secret);
      expect(record?.metadata).not.toContain(secret);
      expect(record?.metadata).toContain(REDACTED);
      const rawDump = JSON.stringify(readRawEvent(db, report.report_id));
      expect(rawDump).not.toContain(secret);
      expect(rawDump).not.toContain("failure body");
      expect(rawDump).not.toContain("stdout");
      expect(rawDump).not.toContain("stderr");
      expect(rawDump).toContain(REDACTED);

      const processMetadata = (
        db
          .prepare("SELECT metadata FROM processes WHERE id = ?")
          .get(result.process_id) as { metadata: string }
      ).metadata;
      const runMetadata = (
        db
          .prepare("SELECT metadata FROM runs WHERE id = ?")
          .get(result.run_id) as { metadata: string }
      ).metadata;
      expect(processMetadata).not.toContain(secret);
      expect(runMetadata).not.toContain(secret);
      expect(processMetadata).toContain(REDACTED);
      expect(runMetadata).toContain(REDACTED);
      expect(JSON.stringify(replayRawEvents(db))).not.toContain(secret);
      expect(verifyEventStore(db).ok).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects unsafe JUnit DTD and entity declarations", async () => {
    const db = createTestDb();
    const tempDir = mkdtempSync(join(tmpdir(), "open-logs-junit-unsafe-"));
    try {
      const result = await runCommand(
        db,
        [
          process.execPath,
          "-e",
          [
            "const fs = require('node:fs');",
            "fs.mkdirSync('test-results', { recursive: true });",
            "fs.writeFileSync('test-results/junit.xml', `<?xml version=\"1.0\"?>",
            '<!DOCTYPE testsuite [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>',
            '<testsuite tests="1" failures="0" errors="0" skipped="0">',
            '<testcase classname="unsafe" name="&xxe;"/>',
            "</testsuite>`);",
          ].join(" "),
          "test",
        ],
        { cwd: tempDir, tee: false, environment: "test" },
      );

      expect(result.exit_code).toBe(0);
      const report = result.test_reports.reports[0];
      expect(report).toMatchObject({
        parse_status: "unsafe",
        parse_error:
          "test report contains disallowed DTD or entity declarations",
        tests: 0,
        failures: 0,
        errors: 0,
        skipped: 0,
      });
      const raw = readRawEvent(db, report?.report_id ?? "");
      expect(raw?.body?.test_report).toMatchObject({
        parse_status: "unsafe",
        tests: 0,
      });
      expect(JSON.stringify(raw)).not.toContain("file:///etc/passwd");
      expect(JSON.stringify(raw)).not.toContain("&xxe;");
      expect(verifyEventStore(db).ok).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves raw stream chunks with byte metadata and observed ordering", async () => {
    const db = createTestDb();
    const result = await runCommand(
      db,
      [
        process.execPath,
        "-e",
        "process.stdout.write(Buffer.from([0,255,10])); process.stderr.write(Buffer.from([69,82,82,10]))",
      ],
      {
        cwd: repoRoot,
        tee: false,
        service: "chunk-test",
        environment: "test",
      },
    );

    expect(result.exit_code).toBe(0);
    expect(result.stdout_chunks).toBeGreaterThanOrEqual(1);
    expect(result.stderr_chunks).toBeGreaterThanOrEqual(1);
    expect(result.summary.chunk_count).toBe(
      result.stdout_chunks + result.stderr_chunks,
    );
    expect(result.summary.byte_count).toBe(
      result.stdout_bytes + result.stderr_bytes,
    );

    const stdoutChunkRecord = getEventRecord(
      db,
      `${result.run_id}-stdout-chunk-1`,
    );
    expect(stdoutChunkRecord).toMatchObject({
      event_type: "process",
      source: "cli",
      run_id: result.run_id,
      process_id: result.process_id,
    });
    const stdoutChunkRaw = readRawEvent(db, `${result.run_id}-stdout-chunk-1`);
    const stdoutChunk = stdoutChunkRaw?.body?.process_stream_chunk as
      | Record<string, unknown>
      | undefined;
    expect(stdoutChunk).toMatchObject({
      stream: "stdout",
      chunk_sequence: 1,
      observed_sequence: 1,
      original_byte_length: 3,
      stored_byte_length: 3,
      contains_invalid_utf8: true,
      ends_with_newline: true,
    });
    expect([
      ...Buffer.from(String(stdoutChunk?.data_base64), "base64"),
    ]).toEqual([0, 255, 10]);

    const stderrChunkRaw = readRawEvent(db, `${result.run_id}-stderr-chunk-1`);
    const stderrChunk = stderrChunkRaw?.body?.process_stream_chunk as
      | Record<string, unknown>
      | undefined;
    expect(stderrChunk?.stream).toBe("stderr");
    expect(Number(stderrChunk?.observed_sequence)).toBeGreaterThan(0);
    expect(verifyEventStore(db).ok).toBe(true);
  });

  it("ignores unknown project IDs before identity and log persistence", async () => {
    const db = createTestDb();
    const result = await runCommand(
      db,
      [process.execPath, "-e", "console.log('unknown-project-ok')"],
      {
        cwd: repoRoot,
        tee: false,
        service: "unknown-project-test",
        environment: "test",
        project_id: "missing-project",
      },
    );

    expect(result.exit_code).toBe(0);
    const log = db
      .prepare("SELECT project_id, message FROM logs WHERE message = ?")
      .get("unknown-project-ok") as {
      project_id: string | null;
      message: string;
    } | null;
    expect(log).toEqual({ project_id: null, message: "unknown-project-ok" });
    const processRow = db
      .prepare("SELECT app_id FROM processes WHERE id = ?")
      .get(result.process_id) as { app_id: string | null } | null;
    if (processRow?.app_id) {
      const app = db
        .prepare("SELECT project_id FROM apps WHERE id = ?")
        .get(processRow.app_id) as { project_id: string | null } | null;
      expect(app?.project_id).toBeNull();
    }
  });

  it("classifies build and test output into queryable lifecycle metadata", async () => {
    const db = createTestDb();
    const result = await runCommand(
      db,
      [
        process.execPath,
        "-e",
        "console.log('PASS unit suite'); console.log('Local: http://localhost:5173/'); console.error('src/app.ts(1,2): error TS2322: not assignable'); process.exit(1)",
        "test",
      ],
      { cwd: repoRoot, tee: false, environment: "test" },
    );

    expect(result.run_type).toBe("test");
    expect(result.package_manager).toBe("bun");
    expect(result.tool).toBe("test");
    expect(result.status).toBe("failed");
    expect(result.summary.line_count).toBe(3);
    expect(result.summary.error_lines).toBe(1);
    expect(result.summary.compiler_error_lines).toBe(1);
    expect(result.summary.test_success_lines).toBe(1);
    expect(result.summary.server_ready_lines).toBe(1);
    expect(result.summary.detected_urls).toContain("http://localhost:5173/");
    expect(result.summary.detected_ports).toContain(5173);
    expect(result.summary.diagnostic_codes).toContain("TS2322");

    const diagnosticLog = db
      .prepare(
        "SELECT level, source, service, metadata FROM logs WHERE message LIKE '%TS2322%'",
      )
      .get() as {
      level: string;
      source: string;
      service: string;
      metadata: string;
    } | null;
    expect(diagnosticLog?.level).toBe("error");
    expect(diagnosticLog?.source).toBe("test");
    expect(diagnosticLog?.service).toBe("test");
    const diagnosticMetadata = JSON.parse(
      diagnosticLog?.metadata ?? "{}",
    ) as Record<string, unknown>;
    expect(diagnosticMetadata).toMatchObject({
      event_type: "process_stream",
      run_type: "test",
      tool: "test",
      package_manager: "bun",
      line_category: "compiler_diagnostic",
      line_severity: "error",
    });
    expect(diagnosticMetadata.diagnostic_codes).toEqual(["TS2322"]);

    const serverLog = db
      .prepare(
        "SELECT level, source, metadata FROM logs WHERE message LIKE 'Local:%'",
      )
      .get() as { level: string; source: string; metadata: string } | null;
    expect(serverLog?.level).toBe("info");
    expect(serverLog?.source).toBe("test");
    const serverMetadata = JSON.parse(serverLog?.metadata ?? "{}") as Record<
      string,
      unknown
    >;
    expect(serverMetadata.line_category).toBe("server_ready");
    expect(serverMetadata.detected_urls).toEqual(["http://localhost:5173/"]);
    expect(serverMetadata.detected_ports).toEqual([5173]);

    const summaryRecord = getEventRecord(db, `${result.run_id}-summary`);
    expect(summaryRecord).toMatchObject({
      event_type: "build",
      source: "test",
      severity: "error",
      run_id: result.run_id,
      process_id: result.process_id,
    });
    expect(summaryRecord?.message).toContain("Test run failed");
    const summaryMetadata = JSON.parse(
      summaryRecord?.metadata ?? "{}",
    ) as Record<string, unknown>;
    expect(summaryMetadata).toMatchObject({
      category: "command_run_summary",
      run_type: "test",
      tool: "test",
      package_manager: "bun",
      status: "failed",
      exit_code: 1,
      compiler_error_lines: 1,
      test_success_lines: 1,
      server_ready_lines: 1,
    });

    const rawSummary = readRawEvent(db, `${result.run_id}-summary`);
    const lifecycle = rawSummary?.body?.lifecycle as
      | { summary?: Record<string, unknown>; kind?: string }
      | undefined;
    expect(lifecycle?.kind).toBe("test");
    expect(lifecycle?.summary?.diagnostic_codes).toEqual(["TS2322"]);

    const runRow = db
      .prepare("SELECT run_type, metadata FROM runs WHERE id = ?")
      .get(result.run_id) as { run_type: string; metadata: string } | null;
    expect(runRow?.run_type).toBe("test");
    const runMetadata = JSON.parse(runRow?.metadata ?? "{}") as Record<
      string,
      unknown
    >;
    expect(runMetadata.summary).toMatchObject({
      compiler_error_lines: 1,
      server_ready_lines: 1,
    });
    expect(verifyEventStore(db).ok).toBe(true);
  });

  it("rebuilds command-runner final status from raw process and lifecycle events", async () => {
    const commandDb = createTestDb();
    const commandResult = await runCommand(
      commandDb,
      [process.execPath, "-e", "process.exit(0)"],
      {
        cwd: repoRoot,
        tee: false,
        environment: "test",
      },
    );

    expect(commandResult.run_type).toBe("command");
    expect(commandResult.status).toBe("completed");
    const commandRebuilt = rebuildEventStoreIndex(commandDb);
    expect(commandRebuilt.errors).toEqual([]);
    expect(commandRebuilt.skipped_events).toBe(0);
    const commandRun = commandDb
      .prepare(
        "SELECT run_type, status, ended_at, exit_code FROM runs WHERE id = ?",
      )
      .get(commandResult.run_id) as {
      run_type: string | null;
      status: string | null;
      ended_at: string | null;
      exit_code: number | null;
    } | null;
    expect(commandRun).toEqual({
      run_type: "command",
      status: "completed",
      ended_at: commandResult.ended_at,
      exit_code: 0,
    });

    const db = createTestDb();
    const result = await runCommand(
      db,
      [process.execPath, "-e", "process.exit(0)", "test"],
      {
        cwd: repoRoot,
        tee: false,
        environment: "test",
      },
    );

    expect(result.run_type).toBe("test");
    expect(result.status).toBe("completed");
    const before = db
      .prepare("SELECT run_type, status, exit_code FROM runs WHERE id = ?")
      .get(result.run_id) as {
      run_type: string | null;
      status: string | null;
      exit_code: number | null;
    } | null;
    expect(before).toEqual({
      run_type: "test",
      status: "completed",
      exit_code: 0,
    });

    const rebuilt = rebuildEventStoreIndex(db);
    expect(rebuilt.errors).toEqual([]);
    expect(rebuilt.skipped_events).toBe(0);

    const after = db
      .prepare(
        "SELECT run_type, status, ended_at, exit_code FROM runs WHERE id = ?",
      )
      .get(result.run_id) as {
      run_type: string | null;
      status: string | null;
      ended_at: string | null;
      exit_code: number | null;
    } | null;
    expect(after).toEqual({
      run_type: "test",
      status: "completed",
      ended_at: result.ended_at,
      exit_code: 0,
    });

    const processRow = db
      .prepare("SELECT ended_at, exit_code FROM processes WHERE id = ?")
      .get(result.process_id) as {
      ended_at: string | null;
      exit_code: number | null;
    } | null;
    expect(processRow).toEqual({ ended_at: result.ended_at, exit_code: 0 });
    expect(verifyEventStore(db).ok).toBe(true);
  });

  it("finalizes interrupted dev-server runs through an abort signal", async () => {
    const db = createTestDb();
    const controller = new AbortController();
    const running = runCommand(
      db,
      [process.execPath, "-e", "setTimeout(() => {}, 10000)", "dev"],
      {
        cwd: repoRoot,
        tee: false,
        environment: "test",
        signal: controller.signal,
      },
    );

    await Bun.sleep(50);
    controller.abort("SIGTERM");
    const result = await running;

    expect(result.run_type).toBe("dev-server");
    expect(result.status).toBe("failed");
    expect(result.signal).toBe("SIGTERM");
    const runRow = db
      .prepare("SELECT status, ended_at, metadata FROM runs WHERE id = ?")
      .get(result.run_id) as {
      status: string;
      ended_at: string | null;
      metadata: string;
    } | null;
    expect(runRow?.status).toBe("failed");
    expect(runRow?.ended_at).toBeTruthy();
    const runMetadata = JSON.parse(runRow?.metadata ?? "{}") as Record<
      string,
      unknown
    >;
    expect(runMetadata.signal).toBe("SIGTERM");
    expect(runMetadata.summary).toMatchObject({ line_count: 0 });

    const summaryRecord = getEventRecord(db, `${result.run_id}-summary`);
    expect(summaryRecord).toMatchObject({
      event_type: "build",
      source: "cli",
      severity: "error",
      run_id: result.run_id,
      process_id: result.process_id,
    });
    expect(summaryRecord?.message).toContain("Dev server failed");
    const summaryMetadata = JSON.parse(
      summaryRecord?.metadata ?? "{}",
    ) as Record<string, unknown>;
    expect(summaryMetadata).toMatchObject({
      category: "command_run_summary",
      run_type: "dev-server",
      status: "failed",
      signal: "SIGTERM",
    });
    expect(verifyEventStore(db).ok).toBe(true);
  });

  it("redacts command and stream canaries before raw and SQLite persistence", async () => {
    const db = createTestDb();
    const secret = "OPENLOGS_SECRET_CANARY_process_67890";
    const assignmentSecret = "ABCD123456789";
    const splitArgSecret = "hunter2Value123";
    const prefixedSplitArgSecret = "dbPasswordValue456";
    await runCommand(
      db,
      [
        process.execPath,
        "-e",
        [
          `const assignment = "ABCD" + "123456789"`,
          `process.stdout.write("OPENLOGS_SECRET_")`,
          `setTimeout(() => process.stdout.write("CANARY_process_67890\\n"), 20)`,
          `setTimeout(() => process.stderr.write("token="), 40)`,
          `setTimeout(() => process.stderr.write(assignment + "\\n"), 60)`,
          `setTimeout(() => process.stdout.write(Buffer.concat([Buffer.from("token=${secret} "), Buffer.from([255, 10])])), 80)`,
        ].join("; "),
        "--password",
        splitArgSecret,
        "--db-password",
        prefixedSplitArgSecret,
      ],
      {
        cwd: repoRoot,
        tee: false,
        service: "redaction-test",
        environment: "test",
      },
    );

    const rawDump = JSON.stringify(replayRawEvents(db));
    const logsDump = JSON.stringify(db.prepare("SELECT * FROM logs").all());
    const processesDump = JSON.stringify(
      db.prepare("SELECT command, metadata FROM processes").all(),
    );
    const runsDump = JSON.stringify(
      db.prepare("SELECT name, metadata FROM runs").all(),
    );

    expect(rawDump).not.toContain(secret);
    expect(rawDump).not.toContain(assignmentSecret);
    expect(rawDump).not.toContain(splitArgSecret);
    expect(rawDump).not.toContain(prefixedSplitArgSecret);
    expect(logsDump).not.toContain(secret);
    expect(logsDump).not.toContain(assignmentSecret);
    expect(logsDump).not.toContain(splitArgSecret);
    expect(logsDump).not.toContain(prefixedSplitArgSecret);
    expect(processesDump).not.toContain(secret);
    expect(processesDump).not.toContain(assignmentSecret);
    expect(processesDump).not.toContain(splitArgSecret);
    expect(processesDump).not.toContain(prefixedSplitArgSecret);
    expect(runsDump).not.toContain(secret);
    expect(runsDump).not.toContain(assignmentSecret);
    expect(runsDump).not.toContain(splitArgSecret);
    expect(runsDump).not.toContain(prefixedSplitArgSecret);

    const decodedChunks = replayRawEvents(db)
      .flatMap((item) => {
        const chunk = item.event.body?.process_stream_chunk as
          | { data_base64?: unknown }
          | undefined;
        if (typeof chunk?.data_base64 !== "string") return [];
        return [Buffer.from(chunk.data_base64, "base64").toString("utf8")];
      })
      .join("\n");
    expect(decodedChunks).not.toContain(secret);
    expect(decodedChunks).not.toContain("OPENLOGS_SECRET_CANARY_process_67890");
    expect(decodedChunks).not.toContain(`token=${assignmentSecret}`);
    expect(decodedChunks).not.toContain(assignmentSecret);
    expect(decodedChunks).not.toContain(splitArgSecret);
    expect(decodedChunks).not.toContain(prefixedSplitArgSecret);
    expect(decodedChunks).toContain(REDACTED);
    expect(rawDump).toContain(REDACTED);
    expect(logsDump).toContain(REDACTED);
    expect(processesDump).toContain(REDACTED);
    expect(runsDump).toContain(REDACTED);
    expect(verifyEventStore(db).ok).toBe(true);
  });
});
