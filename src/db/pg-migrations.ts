/**
 * PostgreSQL migrations for open-logs cloud sync.
 *
 * Equivalent to the SQLite schema in index.ts + migrations/, translated for PostgreSQL.
 */

export const PG_MIGRATIONS: string[] = [
  // Migration 1: projects table
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    name TEXT NOT NULL UNIQUE,
    github_repo TEXT,
    base_url TEXT,
    description TEXT,
    github_description TEXT,
    github_branch TEXT,
    github_sha TEXT,
    last_synced_at TEXT,
    max_rows INTEGER NOT NULL DEFAULT 100000,
    debug_ttl_hours INTEGER NOT NULL DEFAULT 24,
    info_ttl_hours INTEGER NOT NULL DEFAULT 168,
    warn_ttl_hours INTEGER NOT NULL DEFAULT 720,
    error_ttl_hours INTEGER NOT NULL DEFAULT 2160,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  // Migration 2: pages table
  `CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    path TEXT NOT NULL DEFAULT '/',
    name TEXT,
    last_scanned_at TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    UNIQUE(project_id, url)
  )`,

  // Migration 3: logs table
  `CREATE TABLE IF NOT EXISTS logs (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    timestamp TEXT NOT NULL DEFAULT NOW()::text,
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
  )`,

  `CREATE INDEX IF NOT EXISTS idx_logs_project_level_ts ON logs(project_id, level, timestamp DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_logs_trace ON logs(trace_id)`,

  `CREATE INDEX IF NOT EXISTS idx_logs_service ON logs(service)`,

  `CREATE INDEX IF NOT EXISTS idx_logs_page ON logs(page_id)`,

  `CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC)`,

  // Migration 4: scan_jobs table
  `CREATE TABLE IF NOT EXISTS scan_jobs (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
    schedule TEXT NOT NULL DEFAULT '*/30 * * * *',
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    last_run_at TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  // Migration 5: scan_runs table
  `CREATE TABLE IF NOT EXISTS scan_runs (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    job_id TEXT NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
    page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
    started_at TEXT NOT NULL DEFAULT NOW()::text,
    finished_at TEXT,
    status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed')),
    logs_collected INTEGER NOT NULL DEFAULT 0,
    errors_found INTEGER NOT NULL DEFAULT 0,
    perf_score REAL
  )`,

  // Migration 6: performance_snapshots table
  `CREATE TABLE IF NOT EXISTS performance_snapshots (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    timestamp TEXT NOT NULL DEFAULT NOW()::text,
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
  )`,

  `CREATE INDEX IF NOT EXISTS idx_perf_project_ts ON performance_snapshots(project_id, timestamp DESC)`,

  `CREATE INDEX IF NOT EXISTS idx_perf_page ON performance_snapshots(page_id)`,

  // Migration 7: alert_rules table
  `CREATE TABLE IF NOT EXISTS alert_rules (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    service TEXT,
    level TEXT NOT NULL DEFAULT 'error' CHECK(level IN ('debug','info','warn','error','fatal')),
    threshold_count INTEGER NOT NULL DEFAULT 10,
    window_seconds INTEGER NOT NULL DEFAULT 60,
    action TEXT NOT NULL DEFAULT 'webhook' CHECK(action IN ('webhook','log')),
    webhook_url TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    last_fired_at TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE INDEX IF NOT EXISTS idx_alert_rules_project ON alert_rules(project_id)`,

  // Migration 8: issues table
  `CREATE TABLE IF NOT EXISTS issues (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL,
    level TEXT NOT NULL,
    service TEXT,
    message_template TEXT NOT NULL,
    first_seen TEXT NOT NULL DEFAULT NOW()::text,
    last_seen TEXT NOT NULL DEFAULT NOW()::text,
    count INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','ignored')),
    UNIQUE(project_id, fingerprint)
  )`,

  `CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id, status)`,

  `CREATE INDEX IF NOT EXISTS idx_issues_fingerprint ON issues(fingerprint)`,

  // Migration 9: page_auth table
  `CREATE TABLE IF NOT EXISTS page_auth (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    page_id TEXT NOT NULL UNIQUE REFERENCES pages(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('cookie','bearer','basic')),
    credentials TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  // Migration 10: feedback table
  `CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    message TEXT NOT NULL,
    email TEXT,
    category TEXT DEFAULT 'general',
    version TEXT,
    machine_id TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,
];
