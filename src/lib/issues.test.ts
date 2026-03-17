import { describe, expect, it } from "bun:test"
import { createTestDb } from "../db/index.ts"
import { computeFingerprint, getIssue, listIssues, updateIssueStatus, upsertIssue } from "./issues.ts"

function seedProject(db: ReturnType<typeof createTestDb>) {
  return db.prepare("INSERT INTO projects (name) VALUES ('app') RETURNING id").get() as { id: string }
}

describe("computeFingerprint", () => {
  it("returns consistent hash for same input", () => {
    const a = computeFingerprint("error", "api", "DB connection failed")
    const b = computeFingerprint("error", "api", "DB connection failed")
    expect(a).toBe(b)
  })

  it("returns different hash for different messages", () => {
    const a = computeFingerprint("error", "api", "timeout")
    const b = computeFingerprint("error", "api", "DB error")
    expect(a).not.toBe(b)
  })

  it("normalizes hex IDs in messages", () => {
    const a = computeFingerprint("error", "api", "Error for id abc123def456")
    const b = computeFingerprint("error", "api", "Error for id 000fffaabbcc")
    expect(a).toBe(b)
  })
})

describe("upsertIssue", () => {
  it("creates a new issue", () => {
    const db = createTestDb()
    const p = seedProject(db)
    const issue = upsertIssue(db, { project_id: p.id, level: "error", service: "api", message: "DB timeout" })
    expect(issue.id).toBeTruthy()
    expect(issue.count).toBe(1)
    expect(issue.status).toBe("open")
  })

  it("increments count on duplicate", () => {
    const db = createTestDb()
    const p = seedProject(db)
    upsertIssue(db, { project_id: p.id, level: "error", message: "Same error" })
    upsertIssue(db, { project_id: p.id, level: "error", message: "Same error" })
    const issue = upsertIssue(db, { project_id: p.id, level: "error", message: "Same error" })
    expect(issue.count).toBe(3)
  })

  it("reopens resolved issues", () => {
    const db = createTestDb()
    const p = seedProject(db)
    const issue = upsertIssue(db, { project_id: p.id, level: "error", message: "err" })
    updateIssueStatus(db, issue.id, "resolved")
    const reopened = upsertIssue(db, { project_id: p.id, level: "error", message: "err" })
    expect(reopened.status).toBe("open")
  })
})

describe("listIssues", () => {
  it("filters by project and status", () => {
    const db = createTestDb()
    const p = seedProject(db)
    const issue = upsertIssue(db, { project_id: p.id, level: "error", message: "database connection timed out" })
    updateIssueStatus(db, issue.id, "resolved")
    upsertIssue(db, { project_id: p.id, level: "error", message: "authentication service unavailable" })
    expect(listIssues(db, p.id, "open")).toHaveLength(1)
    expect(listIssues(db, p.id, "resolved")).toHaveLength(1)
    expect(listIssues(db, p.id)).toHaveLength(2)
  })
})

describe("updateIssueStatus", () => {
  it("updates status", () => {
    const db = createTestDb()
    const p = seedProject(db)
    const issue = upsertIssue(db, { project_id: p.id, level: "error", message: "x" })
    const updated = updateIssueStatus(db, issue.id, "ignored")
    expect(updated?.status).toBe("ignored")
  })
})
