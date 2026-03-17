import { describe, expect, it } from "bun:test"
import { createTestDb } from "../db/index.ts"
import { deletePageAuth, getPageAuth, setPageAuth } from "./page-auth.ts"

function seedPage(db: ReturnType<typeof createTestDb>) {
  const p = db.prepare("INSERT INTO projects (name) VALUES ('app') RETURNING id").get() as { id: string }
  const page = db.prepare("INSERT INTO pages (project_id, url) VALUES (?, 'https://app.com') RETURNING id").get(p.id) as { id: string }
  return { projectId: p.id, pageId: page.id }
}

describe("page auth", () => {
  it("sets and retrieves bearer auth", () => {
    const db = createTestDb()
    const { pageId } = seedPage(db)
    setPageAuth(db, pageId, "bearer", "my-token-123")
    const auth = getPageAuth(db, pageId)
    expect(auth?.type).toBe("bearer")
    expect(auth?.credentials).toBe("my-token-123")
  })

  it("credentials are encrypted at rest", () => {
    const db = createTestDb()
    const { pageId } = seedPage(db)
    setPageAuth(db, pageId, "bearer", "secret-token")
    const raw = db.prepare("SELECT credentials FROM page_auth WHERE page_id = ?").get(pageId) as { credentials: string }
    // Raw value should NOT be the plaintext token
    expect(raw.credentials).not.toBe("secret-token")
    expect(raw.credentials).toContain(":")  // IV:encrypted format
  })

  it("upserts on duplicate page_id", () => {
    const db = createTestDb()
    const { pageId } = seedPage(db)
    setPageAuth(db, pageId, "bearer", "token-v1")
    setPageAuth(db, pageId, "bearer", "token-v2")
    const auth = getPageAuth(db, pageId)
    expect(auth?.credentials).toBe("token-v2")
    const { c } = db.prepare("SELECT COUNT(*) as c FROM page_auth WHERE page_id = ?").get(pageId) as { c: number }
    expect(c).toBe(1)
  })

  it("returns null for unknown page", () => {
    const db = createTestDb()
    expect(getPageAuth(db, "nope")).toBeNull()
  })

  it("deletes auth", () => {
    const db = createTestDb()
    const { pageId } = seedPage(db)
    setPageAuth(db, pageId, "basic", "user:pass")
    deletePageAuth(db, pageId)
    expect(getPageAuth(db, pageId)).toBeNull()
  })
})
