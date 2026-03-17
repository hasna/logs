import { describe, expect, it } from "bun:test"
import { createTestDb } from "../db/index.ts"
import { ingestBatch } from "./ingest.ts"
import { runRetentionForProject, setRetentionPolicy } from "./retention.ts"

function seedProject(db: ReturnType<typeof createTestDb>, name = "app") {
  return db.prepare("INSERT INTO projects (name) VALUES (?) RETURNING id").get(name) as { id: string }
}

describe("retention", () => {
  it("does nothing when under max_rows", () => {
    const db = createTestDb()
    const p = seedProject(db)
    ingestBatch(db, Array.from({ length: 5 }, () => ({ level: "info" as const, message: "x", project_id: p.id })))
    const result = runRetentionForProject(db, p.id)
    expect(result.deleted).toBe(0)
  })

  it("enforces max_rows", () => {
    const db = createTestDb()
    const p = seedProject(db)
    setRetentionPolicy(db, p.id, { max_rows: 3 })
    ingestBatch(db, Array.from({ length: 10 }, () => ({ level: "info" as const, message: "x", project_id: p.id })))
    runRetentionForProject(db, p.id)
    const count = (db.prepare("SELECT COUNT(*) as c FROM logs WHERE project_id = ?").get(p.id) as { c: number }).c
    expect(count).toBeLessThanOrEqual(3)
  })

  it("returns 0 for unknown project", () => {
    const db = createTestDb()
    expect(runRetentionForProject(db, "nope").deleted).toBe(0)
  })

  it("setRetentionPolicy updates project config", () => {
    const db = createTestDb()
    const p = seedProject(db)
    setRetentionPolicy(db, p.id, { max_rows: 500, debug_ttl_hours: 1 })
    const proj = db.prepare("SELECT max_rows, debug_ttl_hours FROM projects WHERE id = ?").get(p.id) as { max_rows: number; debug_ttl_hours: number }
    expect(proj.max_rows).toBe(500)
    expect(proj.debug_ttl_hours).toBe(1)
  })
})
