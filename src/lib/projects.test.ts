import { describe, expect, it } from "bun:test"
import { createTestDb } from "../db/index.ts"
import { createPage, createProject, getPage, getProject, listPages, listProjects, touchPage, updateProject } from "./projects.ts"

describe("projects", () => {
  it("creates a project", () => {
    const db = createTestDb()
    const p = createProject(db, { name: "my-app", github_repo: "https://github.com/foo/bar", base_url: "https://myapp.com" })
    expect(p.id).toBeTruthy()
    expect(p.name).toBe("my-app")
    expect(p.github_repo).toBe("https://github.com/foo/bar")
  })

  it("lists projects", () => {
    const db = createTestDb()
    createProject(db, { name: "app1" })
    createProject(db, { name: "app2" })
    expect(listProjects(db)).toHaveLength(2)
  })

  it("gets a project by id", () => {
    const db = createTestDb()
    const p = createProject(db, { name: "test" })
    expect(getProject(db, p.id)?.name).toBe("test")
  })

  it("returns null for unknown id", () => {
    expect(getProject(createTestDb(), "nope")).toBeNull()
  })

  it("updates project fields", () => {
    const db = createTestDb()
    const p = createProject(db, { name: "x" })
    const updated = updateProject(db, p.id, { github_sha: "abc123" })
    expect(updated?.github_sha).toBe("abc123")
  })
})

describe("pages", () => {
  it("creates a page", () => {
    const db = createTestDb()
    const p = createProject(db, { name: "app" })
    const page = createPage(db, { project_id: p.id, url: "https://app.com/dashboard", name: "Dashboard" })
    expect(page.id).toBeTruthy()
    expect(page.url).toBe("https://app.com/dashboard")
    expect(page.name).toBe("Dashboard")
  })

  it("upserts on duplicate url", () => {
    const db = createTestDb()
    const p = createProject(db, { name: "app" })
    createPage(db, { project_id: p.id, url: "https://app.com/", name: "Home" })
    createPage(db, { project_id: p.id, url: "https://app.com/", name: "Home v2" })
    expect(listPages(db, p.id)).toHaveLength(1)
  })

  it("lists pages for a project", () => {
    const db = createTestDb()
    const p = createProject(db, { name: "app" })
    createPage(db, { project_id: p.id, url: "https://app.com/a" })
    createPage(db, { project_id: p.id, url: "https://app.com/b" })
    expect(listPages(db, p.id)).toHaveLength(2)
  })

  it("touches last_scanned_at", () => {
    const db = createTestDb()
    const p = createProject(db, { name: "app" })
    const page = createPage(db, { project_id: p.id, url: "https://app.com/" })
    expect(page.last_scanned_at).toBeNull()
    touchPage(db, page.id)
    expect(getPage(db, page.id)?.last_scanned_at).toBeTruthy()
  })
})
