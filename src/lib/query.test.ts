import { describe, expect, it } from "bun:test"
import { createTestDb } from "../db/index.ts"
import { ingestBatch } from "./ingest.ts"
import { getLogContext, searchLogs, tailLogs } from "./query.ts"

function seed(db: ReturnType<typeof createTestDb>) {
  ingestBatch(db, [
    { level: "error", message: "DB connection failed", service: "api", trace_id: "t1" },
    { level: "warn", message: "Slow query detected", service: "api", trace_id: "t1" },
    { level: "info", message: "User login", service: "auth" },
    { level: "debug", message: "Cache miss", service: "cache" },
    { level: "fatal", message: "Out of memory", service: "worker" },
  ])
}

describe("searchLogs", () => {
  it("returns all logs without filters", () => {
    const db = createTestDb()
    seed(db)
    const rows = searchLogs(db, {})
    expect(rows.length).toBe(5)
  })

  it("filters by level", () => {
    const db = createTestDb()
    seed(db)
    const rows = searchLogs(db, { level: "error" })
    expect(rows.every(r => r.level === "error")).toBe(true)
  })

  it("filters by multiple levels", () => {
    const db = createTestDb()
    seed(db)
    const rows = searchLogs(db, { level: ["error", "fatal"] })
    expect(rows).toHaveLength(2)
  })

  it("filters by service", () => {
    const db = createTestDb()
    seed(db)
    const rows = searchLogs(db, { service: "api" })
    expect(rows).toHaveLength(2)
  })

  it("full-text search on message", () => {
    const db = createTestDb()
    seed(db)
    const rows = searchLogs(db, { text: "connection" })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.message).toContain("connection")
  })

  it("filters by trace_id", () => {
    const db = createTestDb()
    seed(db)
    const rows = searchLogs(db, { trace_id: "t1" })
    expect(rows).toHaveLength(2)
  })

  it("respects limit", () => {
    const db = createTestDb()
    seed(db)
    const rows = searchLogs(db, { limit: 2 })
    expect(rows).toHaveLength(2)
  })

  it("returns results ordered by timestamp desc", () => {
    const db = createTestDb()
    seed(db)
    const rows = searchLogs(db, {})
    expect(rows[0]!.timestamp >= rows[rows.length - 1]!.timestamp).toBe(true)
  })
})

describe("tailLogs", () => {
  it("returns n most recent logs", () => {
    const db = createTestDb()
    seed(db)
    const rows = tailLogs(db, undefined, 3)
    expect(rows).toHaveLength(3)
  })

  it("filters by project_id", () => {
    const db = createTestDb()
    const rows = tailLogs(db, "nonexistent")
    expect(rows).toHaveLength(0)
  })
})

describe("getLogContext", () => {
  it("returns all logs for a trace_id in asc order", () => {
    const db = createTestDb()
    seed(db)
    const rows = getLogContext(db, "t1")
    expect(rows).toHaveLength(2)
    expect(rows[0]!.timestamp <= rows[1]!.timestamp).toBe(true)
  })

  it("returns empty for unknown trace_id", () => {
    const db = createTestDb()
    const rows = getLogContext(db, "unknown")
    expect(rows).toHaveLength(0)
  })
})
