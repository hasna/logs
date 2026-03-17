import { describe, expect, it } from "bun:test"
import { createTestDb } from "../db/index.ts"
import { ingestBatch } from "./ingest.ts"
import { summarizeLogs } from "./summarize.ts"

describe("summarizeLogs", () => {
  it("returns warn/error/fatal counts grouped by service", () => {
    const db = createTestDb()
    ingestBatch(db, [
      { level: "error", message: "e1", service: "api" },
      { level: "error", message: "e2", service: "api" },
      { level: "warn", message: "w1", service: "db" },
      { level: "info", message: "i1", service: "api" },  // excluded
      { level: "debug", message: "d1", service: "api" }, // excluded
    ])
    const summary = summarizeLogs(db)
    expect(summary.length).toBe(2)
    const api = summary.find(s => s.service === "api" && s.level === "error")
    expect(api?.count).toBe(2)
    const db2 = summary.find(s => s.service === "db")
    expect(db2?.count).toBe(1)
  })

  it("excludes info/debug from summary", () => {
    const db = createTestDb()
    ingestBatch(db, [
      { level: "info", message: "ok" },
      { level: "debug", message: "trace" },
    ])
    const summary = summarizeLogs(db)
    expect(summary).toHaveLength(0)
  })

  it("returns empty for no logs", () => {
    const db = createTestDb()
    expect(summarizeLogs(db)).toHaveLength(0)
  })
})
