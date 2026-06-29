import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDb } from "./index.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("db migrations", () => {
  it("creates all tables", () => {
    const db = createTestDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("projects");
    expect(names).toContain("pages");
    expect(names).toContain("logs");
    expect(names).toContain("event_segments");
    expect(names).toContain("event_records");
    expect(names).toContain("machines");
    expect(names).toContain("repositories");
    expect(names).toContain("apps");
    expect(names).toContain("processes");
    expect(names).toContain("runs");
    expect(names).toContain("event_sources");
    expect(names).toContain("traces");
    expect(names).toContain("spans");
    expect(names).toContain("sessions");
    expect(names).toContain("releases");
    expect(names).toContain("artifacts");
    expect(names).toContain("source_maps");
    expect(names).toContain("source_map_sources");
    expect(names).toContain("test_reports");
    expect(names).toContain("test_cases");
    expect(names).toContain("projection_offsets");
    expect(names).toContain("sync_cursors");
    expect(names).toContain("scan_jobs");
    expect(names).toContain("scan_runs");
    expect(names).toContain("performance_snapshots");
    expect(names).toContain("logs_fts");
  });

  it("creates indexes", () => {
    const db = createTestDb();
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as { name: string }[];
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_logs_project_level_ts");
    expect(names).toContain("idx_logs_trace");
    expect(names).toContain("idx_logs_service");
    expect(names).toContain("idx_event_records_time");
    expect(names).toContain("idx_event_records_trace");
    expect(names).toContain("idx_event_records_machine_time");
    expect(names).toContain("idx_event_records_run_time");
    expect(names).toContain("idx_source_maps_run");
    expect(names).toContain("idx_source_map_sources_id");
    expect(names).toContain("idx_source_map_sources_path");
    expect(names).toContain("idx_test_reports_run_time");
    expect(names).toContain("idx_test_cases_run_status");
  });

  it("gives source_map_sources a sync-compatible id primary key", () => {
    const db = createTestDb();
    const columns = db
      .prepare("PRAGMA table_info(source_map_sources)")
      .all() as Array<{ name: string; pk: number }>;
    const id = columns.find((column) => column.name === "id");
    expect(id?.pk).toBe(1);
    expect(columns.map((column) => column.name)).toContain("source_map_id");
    expect(columns.map((column) => column.name)).toContain("ordinal");
  });

  it("is idempotent (migrate twice)", () => {
    const db = createTestDb();
    expect(() => {
      db.run(
        "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, github_repo TEXT, base_url TEXT, description TEXT, github_description TEXT, github_branch TEXT, github_sha TEXT, last_synced_at TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
      );
    }).not.toThrow();
  });

  it("creates private local data directories and database files", () => {
    const root = mkdtempSync(join(tmpdir(), "open-logs-db-perms-"));
    const dataDir = join(root, "logs");
    const dbPath = join(dataDir, "logs.db");
    try {
      const script = `
        import { statSync } from "node:fs";
        import { getDb, closeDb } from "./src/db/index.ts";
        const db = getDb();
        db.query("SELECT 1").get();
        closeDb();
        console.log(JSON.stringify({
          dirMode: statSync(${JSON.stringify(dataDir)}).mode & 0o777,
          dbMode: statSync(${JSON.stringify(dbPath)}).mode & 0o777,
        }));
      `;
      const result = spawnSync("bun", ["-e", script], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HASNA_LOGS_DATA_DIR: dataDir,
          HASNA_LOGS_DB_PATH: dbPath,
          LOGS_DATA_DIR: "",
          LOGS_DB_PATH: "",
        },
      });

      expect(result.status).toBe(0);
      const modes = JSON.parse(result.stdout) as {
        dirMode: number;
        dbMode: number;
      };
      expect(modes.dirMode).toBe(0o700);
      expect(modes.dbMode).toBe(0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tightens permissions while migrating legacy ~/.logs data", () => {
    const home = mkdtempSync(join(tmpdir(), "open-logs-legacy-perms-"));
    const oldDir = join(home, ".logs");
    const oldNested = join(oldDir, "segments");
    const newDir = join(home, ".hasna", "logs");
    const newDb = join(newDir, "logs.db");
    const newSegment = join(newDir, "segments", "segment.jsonl");
    try {
      mkdirSync(oldNested, { recursive: true, mode: 0o755 });
      writeFileSync(join(oldDir, "logs.db"), "");
      writeFileSync(join(oldNested, "segment.jsonl"), "{}\n");
      chmodSync(join(oldDir, "logs.db"), 0o644);
      chmodSync(join(oldNested, "segment.jsonl"), 0o644);

      const script = `
        import { statSync } from "node:fs";
        import { getLogsDataDir } from "./src/db/index.ts";
        const dataDir = getLogsDataDir();
        console.log(JSON.stringify({
          dataDir,
          dirMode: statSync(${JSON.stringify(newDir)}).mode & 0o777,
          dbMode: statSync(${JSON.stringify(newDb)}).mode & 0o777,
          nestedDirMode: statSync(${JSON.stringify(join(newDir, "segments"))}).mode & 0o777,
          segmentMode: statSync(${JSON.stringify(newSegment)}).mode & 0o777,
        }));
      `;
      const result = spawnSync("bun", ["-e", script], {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          HASNA_LOGS_DATA_DIR: "",
          HASNA_LOGS_DB_PATH: "",
          LOGS_DATA_DIR: "",
          LOGS_DB_PATH: "",
        },
      });

      expect(result.status).toBe(0);
      const modes = JSON.parse(result.stdout) as {
        dataDir: string;
        dirMode: number;
        dbMode: number;
        nestedDirMode: number;
        segmentMode: number;
      };
      expect(modes.dataDir).toBe(newDir);
      expect(modes.dirMode).toBe(0o700);
      expect(modes.dbMode).toBe(0o600);
      expect(modes.nestedDirMode).toBe(0o700);
      expect(modes.segmentMode).toBe(0o600);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
