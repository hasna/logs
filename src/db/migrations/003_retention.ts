import type { Database } from "bun:sqlite"

const RETENTION_COLUMNS = [
  "max_rows INTEGER NOT NULL DEFAULT 100000",
  "debug_ttl_hours INTEGER NOT NULL DEFAULT 24",
  "info_ttl_hours INTEGER NOT NULL DEFAULT 168",
  "warn_ttl_hours INTEGER NOT NULL DEFAULT 720",
  "error_ttl_hours INTEGER NOT NULL DEFAULT 2160",
]

export function migrateRetention(db: Database): void {
  for (const col of RETENTION_COLUMNS) {
    try { db.run(`ALTER TABLE projects ADD COLUMN ${col}`) } catch { /* already exists */ }
  }
}
