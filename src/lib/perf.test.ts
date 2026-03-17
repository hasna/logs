import { describe, expect, it } from "bun:test"
import { createTestDb } from "../db/index.ts"
import { getLatestSnapshot, getPerfTrend, saveSnapshot, scoreLabel } from "./perf.ts"

function seedProject(db: ReturnType<typeof createTestDb>) {
  return db.prepare("INSERT INTO projects (name) VALUES ('app') RETURNING id").get() as { id: string }
}

describe("perf", () => {
  it("saves and retrieves a snapshot", () => {
    const db = createTestDb()
    const p = seedProject(db)
    const snap = saveSnapshot(db, { project_id: p.id, url: "https://app.com", lcp: 1200, fcp: 800, cls: 0.05, tti: 2000, ttfb: 100, score: 91, raw_audit: null, page_id: null })
    expect(snap.id).toBeTruthy()
    expect(snap.score).toBe(91)
    const latest = getLatestSnapshot(db, p.id)
    expect(latest?.id).toBe(snap.id)
  })

  it("returns null when no snapshot exists", () => {
    const db = createTestDb()
    const p = seedProject(db)
    expect(getLatestSnapshot(db, p.id)).toBeNull()
  })

  it("returns trend in desc order", () => {
    const db = createTestDb()
    const p = seedProject(db)
    saveSnapshot(db, { project_id: p.id, url: "https://app.com", lcp: 1000, fcp: 700, cls: 0.03, tti: 1800, ttfb: 90, score: 95, raw_audit: null, page_id: null })
    saveSnapshot(db, { project_id: p.id, url: "https://app.com", lcp: 2000, fcp: 1200, cls: 0.1, tti: 3000, ttfb: 200, score: 70, raw_audit: null, page_id: null })
    const trend = getPerfTrend(db, p.id)
    expect(trend).toHaveLength(2)
    expect(trend[0]!.timestamp >= trend[1]!.timestamp).toBe(true)
  })
})

describe("scoreLabel", () => {
  it("returns green for >= 90", () => expect(scoreLabel(90)).toBe("green"))
  it("returns green for 100", () => expect(scoreLabel(100)).toBe("green"))
  it("returns yellow for 50-89", () => expect(scoreLabel(75)).toBe("yellow"))
  it("returns yellow for 50", () => expect(scoreLabel(50)).toBe("yellow"))
  it("returns red for < 50", () => expect(scoreLabel(49)).toBe("red"))
  it("returns red for 0", () => expect(scoreLabel(0)).toBe("red"))
  it("returns unknown for null", () => expect(scoreLabel(null)).toBe("unknown"))
})
