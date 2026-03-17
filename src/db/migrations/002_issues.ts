import type { Database } from "bun:sqlite"

export function migrateIssues(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS issues (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL,
      level TEXT NOT NULL,
      service TEXT,
      message_template TEXT NOT NULL,
      first_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_seen TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      count INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','ignored')),
      UNIQUE(project_id, fingerprint)
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id, status)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_issues_fingerprint ON issues(fingerprint)`)
}
