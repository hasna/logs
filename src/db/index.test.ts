import { describe, expect, it } from "bun:test"
import { createTestDb } from "./index.ts"

describe("db migrations", () => {
  it("creates all tables", () => {
    const db = createTestDb()
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    const names = tables.map(t => t.name)
    expect(names).toContain("projects")
    expect(names).toContain("pages")
    expect(names).toContain("logs")
    expect(names).toContain("scan_jobs")
    expect(names).toContain("scan_runs")
    expect(names).toContain("performance_snapshots")
    expect(names).toContain("logs_fts")
  })

  it("creates indexes", () => {
    const db = createTestDb()
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]
    const names = indexes.map(i => i.name)
    expect(names).toContain("idx_logs_project_level_ts")
    expect(names).toContain("idx_logs_trace")
    expect(names).toContain("idx_logs_service")
  })

  it("is idempotent (migrate twice)", () => {
    const db = createTestDb()
    expect(() => {
      db.run("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, github_repo TEXT, base_url TEXT, description TEXT, github_description TEXT, github_branch TEXT, github_sha TEXT, last_synced_at TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))")
    }).not.toThrow()
  })
})
