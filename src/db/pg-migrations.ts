/**
 * PostgreSQL migrations for open-logs storage sync.
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

  `CREATE TABLE IF NOT EXISTS browser_ingest_tokens (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    name TEXT,
    allowed_origins TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    last_used_at TEXT
  )`,

  "CREATE INDEX IF NOT EXISTS idx_browser_ingest_tokens_project ON browser_ingest_tokens(project_id, enabled)",

  "CREATE INDEX IF NOT EXISTS idx_browser_ingest_tokens_hash ON browser_ingest_tokens(token_hash)",

  // Migration 3: logs table
  `CREATE TABLE IF NOT EXISTS logs (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    timestamp TEXT NOT NULL DEFAULT NOW()::text,
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
  )`,

  "CREATE INDEX IF NOT EXISTS idx_logs_project_level_ts ON logs(project_id, level, timestamp DESC)",

  "CREATE INDEX IF NOT EXISTS idx_logs_trace ON logs(trace_id)",

  "CREATE INDEX IF NOT EXISTS idx_logs_service ON logs(service)",

  "CREATE INDEX IF NOT EXISTS idx_logs_page ON logs(page_id)",

  "CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC)",

  "ALTER TABLE logs DROP CONSTRAINT IF EXISTS logs_source_check",

  `CREATE TABLE IF NOT EXISTS event_segments (
    id TEXT PRIMARY KEY,
    relative_path TEXT NOT NULL UNIQUE,
    manifest_path TEXT,
    byte_length INTEGER NOT NULL DEFAULT 0,
    event_count INTEGER NOT NULL DEFAULT 0,
    first_event_time TEXT,
    last_event_time TEXT,
    segment_hash TEXT,
    sealed_at TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    updated_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS event_records (
    event_id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL DEFAULT 1,
    source_event_id TEXT,
    event_type TEXT NOT NULL,
    event_time TEXT NOT NULL,
    ingest_time TEXT NOT NULL,
    severity TEXT,
    source TEXT NOT NULL,
    project_id TEXT,
    page_id TEXT,
    log_id TEXT,
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
    segment_id TEXT,
    segment_path TEXT NOT NULL,
    byte_offset INTEGER NOT NULL,
    byte_length INTEGER NOT NULL,
    record_hash TEXT NOT NULL,
    message TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  "CREATE INDEX IF NOT EXISTS idx_event_records_time ON event_records(event_time DESC)",

  "CREATE INDEX IF NOT EXISTS idx_event_records_type_source ON event_records(event_type, source)",

  "CREATE INDEX IF NOT EXISTS idx_event_records_project_time ON event_records(project_id, event_time DESC)",

  "CREATE INDEX IF NOT EXISTS idx_event_records_trace ON event_records(trace_id)",

  "CREATE INDEX IF NOT EXISTS idx_event_records_segment ON event_records(segment_id)",

  "CREATE INDEX IF NOT EXISTS idx_event_records_machine_time ON event_records(machine_id, event_time DESC)",

  "CREATE INDEX IF NOT EXISTS idx_event_records_repo_time ON event_records(repo_id, event_time DESC)",

  "CREATE INDEX IF NOT EXISTS idx_event_records_app_time ON event_records(app_id, event_time DESC)",

  "CREATE INDEX IF NOT EXISTS idx_event_records_process_time ON event_records(process_id, event_time DESC)",

  "CREATE INDEX IF NOT EXISTS idx_event_records_run_time ON event_records(run_id, event_time DESC)",

  "CREATE INDEX IF NOT EXISTS idx_event_records_span ON event_records(span_id)",

  "CREATE INDEX IF NOT EXISTS idx_event_records_release_time ON event_records(release_id, event_time DESC)",

  "CREATE INDEX IF NOT EXISTS idx_event_records_source_event ON event_records(source_event_id)",

  "CREATE INDEX IF NOT EXISTS idx_event_records_environment ON event_records(environment, event_time DESC)",

  `CREATE TABLE IF NOT EXISTS machines (
    id TEXT PRIMARY KEY,
    hostname TEXT,
    platform TEXT,
    arch TEXT,
    os_release TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    last_seen_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY,
    root_path TEXT,
    remote_url TEXT,
    branch TEXT,
    commit_sha TEXT,
    dirty INTEGER,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    last_seen_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS apps (
    id TEXT PRIMARY KEY,
    repo_id TEXT,
    project_id TEXT,
    name TEXT,
    runtime TEXT,
    environment TEXT,
    version TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    last_seen_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS processes (
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
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    process_id TEXT,
    run_type TEXT,
    name TEXT,
    status TEXT,
    started_at TEXT,
    ended_at TEXT,
    exit_code INTEGER,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS event_sources (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    name TEXT,
    version TEXT,
    config_hash TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    last_seen_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS traces (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    app_id TEXT,
    root_span_id TEXT,
    started_at TEXT,
    ended_at TEXT,
    status TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS spans (
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
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    app_id TEXT,
    user_hash TEXT,
    started_at TEXT,
    ended_at TEXT,
    status TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS releases (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    app_id TEXT,
    version TEXT,
    commit_sha TEXT,
    build_id TEXT,
    deployed_at TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    release_id TEXT,
    artifact_type TEXT,
    path TEXT,
    content_hash TEXT,
    size_bytes INTEGER,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS source_maps (
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
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  "CREATE INDEX IF NOT EXISTS idx_source_maps_run ON source_maps(run_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_source_maps_js_path ON source_maps(javascript_path)",
  "CREATE INDEX IF NOT EXISTS idx_source_maps_status ON source_maps(validation_status)",

  `CREATE TABLE IF NOT EXISTS source_map_sources (
    id TEXT PRIMARY KEY,
    source_map_id TEXT NOT NULL REFERENCES source_maps(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    source_path TEXT,
    has_content INTEGER,
    content_hash TEXT,
    metadata TEXT,
    UNIQUE(source_map_id, ordinal)
  )`,

  "ALTER TABLE source_map_sources ADD COLUMN IF NOT EXISTS id TEXT",
  `UPDATE source_map_sources
   SET id = 'srcmap_source_' || md5(source_map_id || ':' || ordinal::text)
   WHERE id IS NULL OR id LIKE 'srcmap_source_legacy_%'`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_source_map_sources_id ON source_map_sources(id)",
  "CREATE INDEX IF NOT EXISTS idx_source_map_sources_path ON source_map_sources(source_path)",

  `CREATE TABLE IF NOT EXISTS test_reports (
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
    mtime_ms DOUBLE PRECISION,
    tests INTEGER,
    failures INTEGER,
    errors INTEGER,
    skipped INTEGER,
    time_seconds DOUBLE PRECISION,
    suite_count INTEGER,
    testcase_count INTEGER,
    case_stored_count INTEGER NOT NULL DEFAULT 0,
    truncated BOOLEAN NOT NULL DEFAULT FALSE,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS test_cases (
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
    time_seconds DOUBLE PRECISION,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  "CREATE INDEX IF NOT EXISTS idx_test_reports_run_time ON test_reports(run_id, event_time DESC)",

  "CREATE INDEX IF NOT EXISTS idx_test_reports_status_time ON test_reports(parse_status, event_time DESC)",

  "CREATE INDEX IF NOT EXISTS idx_test_reports_path_hash ON test_reports(path, content_hash)",

  "CREATE INDEX IF NOT EXISTS idx_test_cases_report_status ON test_cases(report_id, status)",

  "CREATE INDEX IF NOT EXISTS idx_test_cases_run_status ON test_cases(run_id, status)",

  "CREATE INDEX IF NOT EXISTS idx_test_cases_name ON test_cases(name, classname)",

  `CREATE TABLE IF NOT EXISTS projection_offsets (
    projection_name TEXT PRIMARY KEY,
    segment_id TEXT,
    byte_offset INTEGER NOT NULL DEFAULT 0,
    event_id TEXT,
    updated_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  `CREATE TABLE IF NOT EXISTS sync_cursors (
    target_id TEXT PRIMARY KEY,
    cursor TEXT,
    last_event_id TEXT,
    last_segment_id TEXT,
    updated_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

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

  "CREATE INDEX IF NOT EXISTS idx_perf_project_ts ON performance_snapshots(project_id, timestamp DESC)",

  "CREATE INDEX IF NOT EXISTS idx_perf_page ON performance_snapshots(page_id)",

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

  "CREATE INDEX IF NOT EXISTS idx_alert_rules_project ON alert_rules(project_id)",

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

  "CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id, status)",

  "CREATE INDEX IF NOT EXISTS idx_issues_fingerprint ON issues(fingerprint)",

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
