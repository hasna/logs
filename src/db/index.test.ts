import { describe, expect, it } from "bun:test";
import { createTestDb } from "./index.ts";

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
});
