import { describe, expect, it } from "bun:test"
import { createTestDb } from "../db/index.ts"
import { ingestBatch } from "./ingest.ts"
import { countLogs } from "./count.ts"

describe("countLogs", () => {
  it("counts all logs", () => {
    const db = createTestDb()
    ingestBatch(db, [{ level: "error", message: "e" }, { level: "warn", message: "w" }, { level: "info", message: "i" }])
    const c = countLogs(db, {})
    expect(c.total).toBe(3)
    expect(c.errors).toBe(1)
    expect(c.warns).toBe(1)
    expect(c.fatals).toBe(0)
  })

  it("filters by project", () => {
    const db = createTestDb()
    const p = db.prepare("INSERT INTO projects (name) VALUES ('app') RETURNING id").get() as { id: string }
    ingestBatch(db, [{ level: "error", message: "e", project_id: p.id }, { level: "error", message: "e2" }])
    const c = countLogs(db, { project_id: p.id })
    expect(c.total).toBe(1)
  })

  it("filters by service", () => {
    const db = createTestDb()
    ingestBatch(db, [{ level: "error", message: "e", service: "api" }, { level: "error", message: "e2", service: "db" }])
    expect(countLogs(db, { service: "api" }).total).toBe(1)
  })

  it("returns zero counts for empty db", () => {
    const c = countLogs(createTestDb(), {})
    expect(c.total).toBe(0)
    expect(c.errors).toBe(0)
    expect(c.by_level).toEqual({})
  })

  it("accepts relative since", () => {
    const db = createTestDb()
    ingestBatch(db, [{ level: "error", message: "recent" }])
    const c = countLogs(db, { since: "1h" })
    expect(c.total).toBe(1)
  })
})
