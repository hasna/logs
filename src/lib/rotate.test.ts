import { describe, expect, it } from "bun:test"
import { createTestDb } from "../db/index.ts"
import { ingestBatch } from "./ingest.ts"
import { rotateLogs, rotateByProject } from "./rotate.ts"

describe("rotateLogs", () => {
  it("does nothing when under maxRows", () => {
    const db = createTestDb()
    ingestBatch(db, [{ level: "info", message: "a" }, { level: "info", message: "b" }])
    const deleted = rotateLogs(db, 100)
    expect(deleted).toBe(0)
  })

  it("deletes oldest when over maxRows", () => {
    const db = createTestDb()
    ingestBatch(db, Array.from({ length: 10 }, (_, i) => ({ level: "info" as const, message: `msg ${i}` })))
    const deleted = rotateLogs(db, 5)
    expect(deleted).toBe(5)
    const remaining = (db.prepare("SELECT COUNT(*) as c FROM logs").get() as { c: number }).c
    expect(remaining).toBe(5)
  })
})

describe("rotateByProject", () => {
  it("only rotates logs for the specified project", () => {
    const db = createTestDb()
    const p1 = db.prepare("INSERT INTO projects (name) VALUES ('p1') RETURNING id").get() as { id: string }
    const p2 = db.prepare("INSERT INTO projects (name) VALUES ('p2') RETURNING id").get() as { id: string }
    ingestBatch(db, Array.from({ length: 8 }, () => ({ level: "info" as const, message: "x", project_id: p1.id })))
    ingestBatch(db, Array.from({ length: 5 }, () => ({ level: "info" as const, message: "y", project_id: p2.id })))
    rotateByProject(db, p1.id, 3)
    const p1count = (db.prepare("SELECT COUNT(*) as c FROM logs WHERE project_id = ?").get(p1.id) as { c: number }).c
    const p2count = (db.prepare("SELECT COUNT(*) as c FROM logs WHERE project_id = ?").get(p2.id) as { c: number }).c
    expect(p1count).toBe(3)
    expect(p2count).toBe(5) // untouched
  })
})
