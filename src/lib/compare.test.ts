import { describe, expect, it } from "bun:test"
import { createTestDb } from "../db/index.ts"
import { ingestBatch } from "./ingest.ts"
import { compare } from "./compare.ts"

function seedProject(db: ReturnType<typeof createTestDb>) {
  return db.prepare("INSERT INTO projects (name) VALUES ('app') RETURNING id").get() as { id: string }
}

describe("compare", () => {
  it("detects new errors in window B", () => {
    const db = createTestDb()
    const p = seedProject(db)
    const dayAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString()
    const halfDayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    const now = new Date().toISOString()

    // Window A: old error
    db.prepare("INSERT INTO logs (project_id, level, message, service, timestamp) VALUES (?, 'error', 'old bug', 'api', ?)").run(p.id, dayAgo)
    // Window B: new error
    db.prepare("INSERT INTO logs (project_id, level, message, service, timestamp) VALUES (?, 'error', 'new bug', 'api', ?)").run(p.id, now)

    const result = compare(db, p.id, dayAgo, halfDayAgo, halfDayAgo, now)
    expect(result.new_errors.some(e => e.message === "new bug")).toBe(true)
    expect(result.resolved_errors.some(e => e.message === "old bug")).toBe(true)
  })

  it("returns empty diff when no changes", () => {
    const db = createTestDb()
    const p = seedProject(db)
    const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString()
    const mid = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    const now = new Date().toISOString()
    const result = compare(db, p.id, since, mid, mid, now)
    expect(result.new_errors).toHaveLength(0)
    expect(result.resolved_errors).toHaveLength(0)
  })

  it("has correct structure", () => {
    const db = createTestDb()
    const p = seedProject(db)
    const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString()
    const mid = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    const now = new Date().toISOString()
    const result = compare(db, p.id, since, mid, mid, now)
    expect(result).toHaveProperty("project_id")
    expect(result).toHaveProperty("new_errors")
    expect(result).toHaveProperty("resolved_errors")
    expect(result).toHaveProperty("error_delta_by_service")
    expect(result).toHaveProperty("summary")
  })
})
