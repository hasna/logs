import type { Database } from "bun:sqlite"

export function migratePageAuth(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS page_auth (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      page_id TEXT NOT NULL UNIQUE REFERENCES pages(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('cookie','bearer','basic')),
      credentials TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `)
}
