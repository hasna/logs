import { describe, expect, it } from "bun:test"
import { createTestDb } from "../db/index.ts"
import { ingestBatch } from "./ingest.ts"
import { getHealth } from "./health.ts"

describe("getHealth", () => {
  it("returns status ok", () => {
    const db = createTestDb()
    const h = getHealth(db)
    expect(h.status).toBe("ok")
  })

  it("counts total logs", () => {
    const db = createTestDb()
    ingestBatch(db, [{ level: "info", message: "a" }, { level: "error", message: "b" }])
    const h = getHealth(db)
    expect(h.total_logs).toBe(2)
  })

  it("returns logs_by_level breakdown", () => {
    const db = createTestDb()
    ingestBatch(db, [{ level: "info", message: "a" }, { level: "error", message: "b" }, { level: "error", message: "c" }])
    const h = getHealth(db)
    expect(h.logs_by_level["error"]).toBe(2)
    expect(h.logs_by_level["info"]).toBe(1)
  })

  it("counts projects", () => {
    const db = createTestDb()
    db.prepare("INSERT INTO projects (name) VALUES ('p1')").run()
    db.prepare("INSERT INTO projects (name) VALUES ('p2')").run()
    const h = getHealth(db)
    expect(h.projects).toBe(2)
  })

  it("returns uptime_seconds >= 0", () => {
    const h = getHealth(createTestDb())
    expect(h.uptime_seconds).toBeGreaterThanOrEqual(0)
  })

  it("returns newest and oldest log timestamps", () => {
    const db = createTestDb()
    ingestBatch(db, [{ level: "info", message: "first" }, { level: "warn", message: "last" }])
    const h = getHealth(db)
    expect(h.oldest_log).toBeTruthy()
    expect(h.newest_log).toBeTruthy()
  })
})
