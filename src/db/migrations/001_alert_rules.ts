import type { Database } from "bun:sqlite"

export function migrateAlertRules(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS alert_rules (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      service TEXT,
      level TEXT NOT NULL DEFAULT 'error' CHECK(level IN ('debug','info','warn','error','fatal')),
      threshold_count INTEGER NOT NULL DEFAULT 10,
      window_seconds INTEGER NOT NULL DEFAULT 60,
      action TEXT NOT NULL DEFAULT 'webhook' CHECK(action IN ('webhook','log')),
      webhook_url TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_fired_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_alert_rules_project ON alert_rules(project_id)`)
}
