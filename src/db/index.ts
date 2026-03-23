import { Database } from "bun:sqlite"
import { join } from "node:path"
import { existsSync, mkdirSync, cpSync } from "node:fs"
import { migrateAlertRules } from "./migrations/001_alert_rules.ts"
import { migrateIssues } from "./migrations/002_issues.ts"
import { migrateRetention } from "./migrations/003_retention.ts"
import { migratePageAuth } from "./migrations/004_page_auth.ts"

function resolveDataDir(): string {
  const explicit = process.env.HASNA_LOGS_DATA_DIR ?? process.env.LOGS_DATA_DIR
  if (explicit) return explicit

  const home = process.env.HOME ?? "~"
  const newDir = join(home, ".hasna", "logs")
  const oldDir = join(home, ".logs")

  // Auto-migrate: copy old data to new location if needed
  if (!existsSync(newDir) && existsSync(oldDir)) {
    mkdirSync(join(home, ".hasna"), { recursive: true })
    cpSync(oldDir, newDir, { recursive: true })
  }

  return newDir
}

const DATA_DIR = resolveDataDir()
const DB_PATH = process.env.HASNA_LOGS_DB_PATH ?? process.env.LOGS_DB_PATH ?? join(DATA_DIR, "logs.db")

let _db: Database | null = null

export function getDb(): Database {
  if (_db) return _db
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  _db = new Database(DB_PATH)
  _db.run("PRAGMA journal_mode=WAL")
  _db.run("PRAGMA foreign_keys=ON")
  migrate(_db)
  return _db
}

export function closeDb(): void {
  _db?.close()
  _db = null
}

export function createTestDb(): Database {
  const db = new Database(":memory:")
  db.run("PRAGMA journal_mode=WAL")
  db.run("PRAGMA foreign_keys=ON")
  migrate(db)
  return db
}

function migrate(db: Database): void {
  db.run(`
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
  `)

  db.run(`
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
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS logs (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
      level TEXT NOT NULL CHECK(level IN ('debug','info','warn','error','fatal')),
      source TEXT NOT NULL DEFAULT 'sdk' CHECK(source IN ('sdk','script','scanner')),
      service TEXT,
      message TEXT NOT NULL,
      trace_id TEXT,
      session_id TEXT,
      agent TEXT,
      url TEXT,
      stack_trace TEXT,
      metadata TEXT
    )
  `)

  db.run(`CREATE INDEX IF NOT EXISTS idx_logs_project_level_ts ON logs(project_id, level, timestamp DESC)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_logs_trace ON logs(trace_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_logs_service ON logs(service)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_logs_page ON logs(page_id)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC)`)

  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS logs_fts USING fts5(
      message, service, stack_trace,
      content=logs, content_rowid=rowid
    )
  `)

  db.run(`
    CREATE TRIGGER IF NOT EXISTS logs_fts_insert AFTER INSERT ON logs BEGIN
      INSERT INTO logs_fts(rowid, message, service, stack_trace)
      VALUES (new.rowid, new.message, new.service, new.stack_trace);
    END
  `)

  db.run(`
    CREATE TRIGGER IF NOT EXISTS logs_fts_delete AFTER DELETE ON logs BEGIN
      INSERT INTO logs_fts(logs_fts, rowid, message, service, stack_trace)
      VALUES ('delete', old.rowid, old.message, old.service, old.stack_trace);
    END
  `)

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
  `)

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
  `)

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
  `)

  db.run(`CREATE INDEX IF NOT EXISTS idx_perf_project_ts ON performance_snapshots(project_id, timestamp DESC)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_perf_page ON performance_snapshots(page_id)`)

  // QoL migrations
  migrateAlertRules(db)
  migrateIssues(db)
  migrateRetention(db)
  migratePageAuth(db)
}
