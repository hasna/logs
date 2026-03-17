import { describe, expect, it } from "bun:test"
import { createTestDb } from "../db/index.ts"
import { ingestBatch } from "./ingest.ts"
import { diagnose } from "./diagnose.ts"

function seedProject(db: ReturnType<typeof createTestDb>) {
  return db.prepare("INSERT INTO projects (name) VALUES ('app') RETURNING id").get() as { id: string }
}

describe("diagnose", () => {
  it("returns empty diagnosis for project with no logs", () => {
    const db = createTestDb()
    const p = seedProject(db)
    const result = diagnose(db, p.id)
    expect(result.project_id).toBe(p.id)
    expect(result.top_errors).toHaveLength(0)
    expect(result.summary).toContain("No errors")
  })

  it("surfaces top errors", () => {
    const db = createTestDb()
    const p = seedProject(db)
    ingestBatch(db, [
      { level: "error", message: "DB timeout", service: "api", project_id: p.id },
      { level: "error", message: "DB timeout", service: "api", project_id: p.id },
      { level: "error", message: "Auth failed", service: "auth", project_id: p.id },
    ])
    const result = diagnose(db, p.id)
    expect(result.top_errors.length).toBeGreaterThan(0)
    expect(result.top_errors[0]!.message).toBe("DB timeout")
    expect(result.top_errors[0]!.count).toBe(2)
  })

  it("populates summary with error info", () => {
    const db = createTestDb()
    const p = seedProject(db)
    ingestBatch(db, [{ level: "error", message: "boom", service: "api", project_id: p.id }])
    const result = diagnose(db, p.id)
    expect(result.summary).toContain("error")
  })

  it("groups error_rate_by_service", () => {
    const db = createTestDb()
    const p = seedProject(db)
    ingestBatch(db, [
      { level: "error", message: "e1", service: "api", project_id: p.id },
      { level: "info", message: "i1", service: "api", project_id: p.id },
      { level: "warn", message: "w1", service: "db", project_id: p.id },
    ])
    const result = diagnose(db, p.id)
    const api = result.error_rate_by_service.find(s => s.service === "api")
    expect(api?.errors).toBe(1)
    expect(api?.total).toBe(2)
  })
})
