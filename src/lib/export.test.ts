import { describe, expect, it } from "bun:test"
import { createTestDb } from "../db/index.ts"
import { ingestBatch } from "./ingest.ts"
import { exportToCsv, exportToJson } from "./export.ts"

function seed(db: ReturnType<typeof createTestDb>) {
  ingestBatch(db, [
    { level: "error", message: "boom", service: "api" },
    { level: "info", message: "ok", service: "web" },
    { level: "warn", message: 'has "quotes"', service: "db" },
  ])
}

describe("exportToJson", () => {
  it("exports all logs as JSON array", () => {
    const db = createTestDb()
    seed(db)
    const chunks: string[] = []
    const count = exportToJson(db, {}, s => chunks.push(s))
    expect(count).toBe(3)
    const parsed = JSON.parse(chunks.join(""))
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toHaveLength(3)
  })

  it("filters by level", () => {
    const db = createTestDb()
    seed(db)
    const chunks: string[] = []
    const count = exportToJson(db, { level: "error" }, s => chunks.push(s))
    expect(count).toBe(1)
    const parsed = JSON.parse(chunks.join(""))
    expect(parsed[0].level).toBe("error")
  })
})

describe("exportToCsv", () => {
  it("exports CSV with header", () => {
    const db = createTestDb()
    seed(db)
    const chunks: string[] = []
    const count = exportToCsv(db, {}, s => chunks.push(s))
    expect(count).toBe(3)
    const csv = chunks.join("")
    expect(csv).toContain("id,timestamp,level")
    expect(csv).toContain("error")
    expect(csv).toContain("boom")
  })

  it("escapes CSV quotes", () => {
    const db = createTestDb()
    seed(db)
    const chunks: string[] = []
    exportToCsv(db, { level: "warn" }, s => chunks.push(s))
    const csv = chunks.join("")
    expect(csv).toContain('"has ""quotes"""')
  })

  it("filters by service", () => {
    const db = createTestDb()
    seed(db)
    const chunks: string[] = []
    const count = exportToCsv(db, { service: "api" }, s => chunks.push(s))
    expect(count).toBe(1)
  })
})
