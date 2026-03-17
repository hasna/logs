import { describe, expect, it, mock } from "bun:test"
import { createTestDb } from "../db/index.ts"
import { createAlertRule, deleteAlertRule, evaluateAlerts, listAlertRules, updateAlertRule } from "./alerts.ts"
import { ingestBatch } from "./ingest.ts"

function seedProject(db: ReturnType<typeof createTestDb>) {
  return db.prepare("INSERT INTO projects (name) VALUES ('app') RETURNING id").get() as { id: string }
}

describe("alert rules CRUD", () => {
  it("creates an alert rule", () => {
    const db = createTestDb()
    const p = seedProject(db)
    const rule = createAlertRule(db, { project_id: p.id, name: "High errors", level: "error", threshold_count: 5, window_seconds: 60 })
    expect(rule.id).toBeTruthy()
    expect(rule.name).toBe("High errors")
    expect(rule.threshold_count).toBe(5)
    expect(rule.enabled).toBe(1)
  })

  it("lists rules for a project", () => {
    const db = createTestDb()
    const p = seedProject(db)
    createAlertRule(db, { project_id: p.id, name: "r1" })
    createAlertRule(db, { project_id: p.id, name: "r2" })
    expect(listAlertRules(db, p.id)).toHaveLength(2)
  })

  it("updates a rule", () => {
    const db = createTestDb()
    const p = seedProject(db)
    const rule = createAlertRule(db, { project_id: p.id, name: "r1" })
    const updated = updateAlertRule(db, rule.id, { enabled: 0, threshold_count: 99 })
    expect(updated?.enabled).toBe(0)
    expect(updated?.threshold_count).toBe(99)
  })

  it("deletes a rule", () => {
    const db = createTestDb()
    const p = seedProject(db)
    const rule = createAlertRule(db, { project_id: p.id, name: "r1" })
    deleteAlertRule(db, rule.id)
    expect(listAlertRules(db, p.id)).toHaveLength(0)
  })
})

describe("alert evaluation", () => {
  it("does not fire when under threshold", async () => {
    const db = createTestDb()
    const p = seedProject(db)
    createAlertRule(db, { project_id: p.id, name: "r", level: "error", threshold_count: 10, window_seconds: 60, action: "log" })
    ingestBatch(db, Array.from({ length: 5 }, () => ({ level: "error" as const, message: "e", project_id: p.id })))
    // No throw = passes
    await expect(evaluateAlerts(db, p.id, null, "error")).resolves.toBeUndefined()
  })

  it("fires when threshold exceeded (log action)", async () => {
    const db = createTestDb()
    const p = seedProject(db)
    createAlertRule(db, { project_id: p.id, name: "r", level: "error", threshold_count: 3, window_seconds: 3600, action: "log" })
    ingestBatch(db, Array.from({ length: 5 }, () => ({ level: "error" as const, message: "e", project_id: p.id })))
    await expect(evaluateAlerts(db, p.id, null, "error")).resolves.toBeUndefined()
    // Verify last_fired_at was set
    const rule = db.prepare("SELECT last_fired_at FROM alert_rules WHERE project_id = ?").get(p.id) as { last_fired_at: string | null }
    expect(rule.last_fired_at).toBeTruthy()
  })
})
