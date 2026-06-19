import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setEventStoreDataDir } from "../lib/event-store.ts";
import { migrateAlertRules } from "./migrations/001_alert_rules.ts";
import { migrateIssues } from "./migrations/002_issues.ts";
import { migrateRetention } from "./migrations/003_retention.ts";
import { migratePageAuth } from "./migrations/004_page_auth.ts";

function resolveDataDir(): string {
  const explicit = process.env.HASNA_LOGS_DATA_DIR ?? process.env.LOGS_DATA_DIR;
  if (explicit) return explicit;

  const home = process.env.HOME ?? "~";
  const newDir = join(home, ".hasna", "logs");
  const oldDir = join(home, ".logs");

  // Auto-migrate: copy old data to new location if needed
  if (!existsSync(newDir) && existsSync(oldDir)) {
    mkdirSync(join(home, ".hasna"), { recursive: true });
    cpSync(oldDir, newDir, { recursive: true });
  }

  return newDir;
}

const DATA_DIR = resolveDataDir();
const DB_PATH =
  process.env.HASNA_LOGS_DB_PATH ??
  process.env.LOGS_DB_PATH ??
  join(DATA_DIR, "logs.db");

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  setEventStoreDataDir(_db, DATA_DIR);
  configureDb(_db);
  runWithBusyRetry(
    _db,
    `CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    message TEXT NOT NULL,
    email TEXT,
    category TEXT DEFAULT 'general',
    version TEXT,
    machine_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  );
  return _db;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}

export function createTestDb(): Database {
  const db = new Database(":memory:");
  setEventStoreDataDir(
    db,
    mkdtempSync(join(tmpdir(), "open-logs-events-test-")),
  );
  configureDb(db);
  return db;
}

function configureDb(db: Database): void {
  db.run("PRAGMA busy_timeout=10000");
  runWithBusyRetry(db, "PRAGMA journal_mode=WAL");
  runWithBusyRetry(db, "PRAGMA foreign_keys=ON");
  migrate(db);
}

function migrate(db: Database): void {
  runWithBusyRetry(
    db,
    `
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      name TEXT NOT NULL UNIQUE,
      github_repo TEXT,
      base_url TEXT,
      description TEXT,
      github_description TEXT,
      github_branch TEXT,
      github_sha TEXT,
      last_synced_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `,
  );

  runWithBusyRetry(
    db,
    `
    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '/',
      name TEXT,
      last_scanned_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(project_id, url)
    )
  `,
  );

  runWithBusyRetry(
    db,
    `
    CREATE TABLE IF NOT EXISTS browser_ingest_tokens (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      name TEXT,
      allowed_origins TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_used_at TEXT
    )
  `,
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_browser_ingest_tokens_project ON browser_ingest_tokens(project_id, enabled)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_browser_ingest_tokens_hash ON browser_ingest_tokens(token_hash)",
  );

  runWithBusyRetry(
    db,
    `
    CREATE TABLE IF NOT EXISTS logs (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
      level TEXT NOT NULL CHECK(level IN ('debug','info','warn','error','fatal')),
      source TEXT NOT NULL DEFAULT 'sdk',
      service TEXT,
      message TEXT NOT NULL,
      trace_id TEXT,
      session_id TEXT,
      agent TEXT,
      url TEXT,
      stack_trace TEXT,
      metadata TEXT
    )
  `,
  );

  db.run(
    "CREATE INDEX IF NOT EXISTS idx_logs_project_level_ts ON logs(project_id, level, timestamp DESC)",
  );
  db.run("CREATE INDEX IF NOT EXISTS idx_logs_trace ON logs(trace_id)");
  db.run("CREATE INDEX IF NOT EXISTS idx_logs_service ON logs(service)");
  db.run("CREATE INDEX IF NOT EXISTS idx_logs_page ON logs(page_id)");
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC)",
  );

  db.run(`
    CREATE TABLE IF NOT EXISTS machines (
      id TEXT PRIMARY KEY,
      hostname TEXT,
      platform TEXT,
      arch TEXT,
      os_release TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS repositories (
      id TEXT PRIMARY KEY,
      root_path TEXT,
      remote_url TEXT,
      branch TEXT,
      commit_sha TEXT,
      dirty INTEGER,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS apps (
      id TEXT PRIMARY KEY,
      repo_id TEXT,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      name TEXT,
      runtime TEXT,
      environment TEXT,
      version TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS processes (
      id TEXT PRIMARY KEY,
      machine_id TEXT,
      repo_id TEXT,
      app_id TEXT,
      pid INTEGER,
      ppid INTEGER,
      command TEXT,
      cwd TEXT,
      started_at TEXT,
      ended_at TEXT,
      exit_code INTEGER,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      process_id TEXT,
      run_type TEXT,
      name TEXT,
      status TEXT,
      started_at TEXT,
      ended_at TEXT,
      exit_code INTEGER,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS event_sources (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      name TEXT,
      version TEXT,
      config_hash TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS traces (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      app_id TEXT,
      root_span_id TEXT,
      started_at TEXT,
      ended_at TEXT,
      status TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS spans (
      id TEXT PRIMARY KEY,
      trace_id TEXT,
      parent_span_id TEXT,
      app_id TEXT,
      process_id TEXT,
      name TEXT,
      operation TEXT,
      status TEXT,
      started_at TEXT,
      ended_at TEXT,
      duration_ms REAL,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      app_id TEXT,
      user_hash TEXT,
      started_at TEXT,
      ended_at TEXT,
      status TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS releases (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      app_id TEXT,
      version TEXT,
      commit_sha TEXT,
      build_id TEXT,
      deployed_at TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      release_id TEXT,
      artifact_type TEXT,
      path TEXT,
      content_hash TEXT,
      size_bytes INTEGER,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS source_maps (
      id TEXT PRIMARY KEY,
      event_id TEXT REFERENCES event_records(event_id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      machine_id TEXT,
      repo_id TEXT,
      app_id TEXT,
      process_id TEXT,
      run_id TEXT,
      environment TEXT,
      source_map_artifact_id TEXT,
      javascript_artifact_id TEXT,
      source_map_path TEXT,
      javascript_path TEXT,
      source_root TEXT,
      file TEXT,
      version INTEGER,
      validation_status TEXT,
      validation_error TEXT,
      source_count INTEGER,
      names_count INTEGER,
      mappings_length INTEGER,
      has_sources_content INTEGER,
      truncated INTEGER,
      content_hash TEXT,
      size_bytes INTEGER,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_source_maps_run ON source_maps(run_id, created_at DESC)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_source_maps_js_path ON source_maps(javascript_path)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_source_maps_status ON source_maps(validation_status)",
  );

  db.run(`
    CREATE TABLE IF NOT EXISTS source_map_sources (
      id TEXT PRIMARY KEY,
      source_map_id TEXT NOT NULL REFERENCES source_maps(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      source_path TEXT,
      has_content INTEGER,
      content_hash TEXT,
      metadata TEXT,
      UNIQUE(source_map_id, ordinal)
    )
  `);
  migrateSourceMapSourcesSyncId(db);
  db.run(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_source_map_sources_id ON source_map_sources(id)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_source_map_sources_path ON source_map_sources(source_path)",
  );

  db.run(`
    CREATE TABLE IF NOT EXISTS test_reports (
      id TEXT PRIMARY KEY,
      event_id TEXT REFERENCES event_records(event_id) ON DELETE CASCADE,
      source_event_id TEXT,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      machine_id TEXT,
      repo_id TEXT,
      app_id TEXT,
      process_id TEXT,
      run_id TEXT,
      environment TEXT,
      source TEXT,
      event_time TEXT,
      path TEXT,
      format TEXT,
      parser TEXT,
      parse_status TEXT,
      parse_error TEXT,
      size_bytes INTEGER,
      content_hash TEXT,
      changed TEXT,
      mtime_ms REAL,
      tests INTEGER,
      failures INTEGER,
      errors INTEGER,
      skipped INTEGER,
      time_seconds REAL,
      suite_count INTEGER,
      testcase_count INTEGER,
      case_stored_count INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS test_cases (
      id TEXT PRIMARY KEY,
      report_id TEXT NOT NULL REFERENCES test_reports(id) ON DELETE CASCADE,
      event_id TEXT REFERENCES event_records(event_id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      machine_id TEXT,
      repo_id TEXT,
      app_id TEXT,
      process_id TEXT,
      run_id TEXT,
      environment TEXT,
      suite_name TEXT,
      suite_index INTEGER,
      case_index INTEGER,
      name TEXT,
      classname TEXT,
      file TEXT,
      status TEXT,
      time_seconds REAL,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);

  db.run(
    "CREATE INDEX IF NOT EXISTS idx_test_reports_run_time ON test_reports(run_id, event_time DESC)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_test_reports_status_time ON test_reports(parse_status, event_time DESC)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_test_reports_path_hash ON test_reports(path, content_hash)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_test_cases_report_status ON test_cases(report_id, status)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_test_cases_run_status ON test_cases(run_id, status)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_test_cases_name ON test_cases(name, classname)",
  );

  db.run(`
    CREATE TABLE IF NOT EXISTS projection_offsets (
      projection_name TEXT PRIMARY KEY,
      segment_id TEXT,
      byte_offset INTEGER NOT NULL DEFAULT 0,
      event_id TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sync_cursors (
      target_id TEXT PRIMARY KEY,
      cursor TEXT,
      last_event_id TEXT,
      last_segment_id TEXT,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS event_segments (
      id TEXT PRIMARY KEY,
      relative_path TEXT NOT NULL UNIQUE,
      manifest_path TEXT,
      byte_length INTEGER NOT NULL DEFAULT 0,
      event_count INTEGER NOT NULL DEFAULT 0,
      first_event_time TEXT,
      last_event_time TEXT,
      segment_hash TEXT,
      sealed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  ensureColumn(db, "event_segments", "manifest_path", "TEXT");
  ensureColumn(db, "event_segments", "segment_hash", "TEXT");

  db.run(`
    CREATE TABLE IF NOT EXISTS event_records (
      event_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL DEFAULT 1,
      source_event_id TEXT,
      event_type TEXT NOT NULL,
      event_time TEXT NOT NULL,
      ingest_time TEXT NOT NULL,
      severity TEXT,
      source TEXT NOT NULL,
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
      log_id TEXT REFERENCES logs(id) ON DELETE SET NULL,
      machine_id TEXT,
      repo_id TEXT,
      app_id TEXT,
      process_id TEXT,
      run_id TEXT,
      trace_id TEXT,
      span_id TEXT,
      parent_span_id TEXT,
      session_id TEXT,
      release_id TEXT,
      environment TEXT,
      artifact_id TEXT,
      privacy_tier TEXT,
      segment_id TEXT NOT NULL REFERENCES event_segments(id) ON DELETE CASCADE,
      segment_path TEXT NOT NULL,
      byte_offset INTEGER NOT NULL,
      byte_length INTEGER NOT NULL,
      record_hash TEXT NOT NULL,
      message TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  ensureColumn(db, "event_records", "source_event_id", "TEXT");
  ensureColumn(db, "event_records", "machine_id", "TEXT");
  ensureColumn(db, "event_records", "repo_id", "TEXT");
  ensureColumn(db, "event_records", "app_id", "TEXT");
  ensureColumn(db, "event_records", "process_id", "TEXT");
  ensureColumn(db, "event_records", "run_id", "TEXT");
  ensureColumn(db, "event_records", "span_id", "TEXT");
  ensureColumn(db, "event_records", "parent_span_id", "TEXT");
  ensureColumn(db, "event_records", "release_id", "TEXT");
  ensureColumn(db, "event_records", "environment", "TEXT");
  ensureColumn(db, "event_records", "artifact_id", "TEXT");
  ensureColumn(db, "event_records", "privacy_tier", "TEXT");

  db.run(
    "CREATE INDEX IF NOT EXISTS idx_event_records_time ON event_records(event_time DESC)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_event_records_type_source ON event_records(event_type, source)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_event_records_project_time ON event_records(project_id, event_time DESC)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_event_records_trace ON event_records(trace_id)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_event_records_segment ON event_records(segment_id)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_event_records_machine_time ON event_records(machine_id, event_time DESC)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_event_records_repo_time ON event_records(repo_id, event_time DESC)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_event_records_app_time ON event_records(app_id, event_time DESC)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_event_records_process_time ON event_records(process_id, event_time DESC)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_event_records_run_time ON event_records(run_id, event_time DESC)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_event_records_span ON event_records(span_id)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_event_records_release_time ON event_records(release_id, event_time DESC)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_event_records_source_event ON event_records(source_event_id)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_event_records_environment ON event_records(environment, event_time DESC)",
  );

  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS logs_fts USING fts5(
      message, service, stack_trace,
      content=logs, content_rowid=rowid
    )
  `);

  db.run(`
    CREATE TRIGGER IF NOT EXISTS logs_fts_insert AFTER INSERT ON logs BEGIN
      INSERT INTO logs_fts(rowid, message, service, stack_trace)
      VALUES (new.rowid, new.message, new.service, new.stack_trace);
    END
  `);

  db.run(`
    CREATE TRIGGER IF NOT EXISTS logs_fts_delete AFTER DELETE ON logs BEGIN
      INSERT INTO logs_fts(logs_fts, rowid, message, service, stack_trace)
      VALUES ('delete', old.rowid, old.message, old.service, old.stack_trace);
    END
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS scan_jobs (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
      schedule TEXT NOT NULL DEFAULT '*/30 * * * *',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_run_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS scan_runs (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      job_id TEXT NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
      page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
      started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      finished_at TEXT,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed')),
      logs_collected INTEGER NOT NULL DEFAULT 0,
      errors_found INTEGER NOT NULL DEFAULT 0,
      perf_score REAL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS performance_snapshots (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
      url TEXT NOT NULL,
      lcp REAL,
      fcp REAL,
      cls REAL,
      tti REAL,
      ttfb REAL,
      score REAL,
      raw_audit TEXT
    )
  `);

  db.run(
    "CREATE INDEX IF NOT EXISTS idx_perf_project_ts ON performance_snapshots(project_id, timestamp DESC)",
  );
  db.run(
    "CREATE INDEX IF NOT EXISTS idx_perf_page ON performance_snapshots(page_id)",
  );

  // QoL migrations
  migrateAlertRules(db);
  migrateIssues(db);
  migrateRetention(db);
  migratePageAuth(db);
}

function migrateSourceMapSourcesSyncId(db: Database): void {
  ensureColumn(db, "source_map_sources", "id", "TEXT");
  const rows = db
    .prepare(`
      SELECT source_map_id, ordinal
      FROM source_map_sources
      WHERE id IS NULL OR id LIKE 'srcmap_source_legacy_%'
    `)
    .all() as Array<{ source_map_id: string; ordinal: number }>;
  if (rows.length === 0) return;

  const update = db.prepare(`
    UPDATE source_map_sources
    SET id = ?
    WHERE source_map_id = ? AND ordinal = ?
  `);
  db.transaction((items: Array<{ source_map_id: string; ordinal: number }>) => {
    for (const row of items) {
      update.run(
        sourceMapSourceRowId(row.source_map_id, row.ordinal),
        row.source_map_id,
        row.ordinal,
      );
    }
  })(rows);
}

function sourceMapSourceRowId(sourceMapId: string, ordinal: number): string {
  return `srcmap_source_${createHash("md5")
    .update(sourceMapId)
    .update(":")
    .update(String(ordinal))
    .digest("hex")}`;
}

function ensureColumn(
  db: Database,
  table: string,
  column: string,
  definition: string,
): void {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (!existing.some((c) => c.name === column)) {
    runWithBusyRetry(
      db,
      `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`,
    );
  }
}

function runWithBusyRetry(db: Database, sql: string): void {
  const started = Date.now();
  while (true) {
    try {
      db.run(sql);
      return;
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() - started > 10_000) throw error;
      sleepSync(25);
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "SQLITE_BUSY",
  );
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
