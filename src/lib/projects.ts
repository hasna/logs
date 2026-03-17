import type { Database } from "bun:sqlite"
import type { Page, Project } from "../types/index.ts"

// Projects
export function createProject(db: Database, data: { name: string; github_repo?: string; base_url?: string; description?: string }): Project {
  return db.prepare(`
    INSERT INTO projects (name, github_repo, base_url, description)
    VALUES ($name, $github_repo, $base_url, $description)
    RETURNING *
  `).get({
    $name: data.name,
    $github_repo: data.github_repo ?? null,
    $base_url: data.base_url ?? null,
    $description: data.description ?? null,
  }) as Project
}

export function listProjects(db: Database): Project[] {
  return db.prepare("SELECT * FROM projects ORDER BY created_at DESC").all() as Project[]
}

export function getProject(db: Database, id: string): Project | null {
  return db.prepare("SELECT * FROM projects WHERE id = $id").get({ $id: id }) as Project | null
}

export function updateProject(db: Database, id: string, data: Partial<Pick<Project, "name" | "github_repo" | "base_url" | "description" | "github_description" | "github_branch" | "github_sha" | "last_synced_at">>): Project | null {
  const fields = Object.keys(data).map(k => `${k} = $${k}`).join(", ")
  if (!fields) return getProject(db, id)
  const params = Object.fromEntries(Object.entries(data).map(([k, v]) => [`$${k}`, v]))
  params.$id = id
  return db.prepare(`UPDATE projects SET ${fields} WHERE id = $id RETURNING *`).get(params) as Project | null
}

// Pages
export function createPage(db: Database, data: { project_id: string; url: string; path?: string; name?: string }): Page {
  return db.prepare(`
    INSERT INTO pages (project_id, url, path, name)
    VALUES ($project_id, $url, $path, $name)
    ON CONFLICT(project_id, url) DO UPDATE SET name = excluded.name
    RETURNING *
  `).get({
    $project_id: data.project_id,
    $url: data.url,
    $path: data.path ?? new URL(data.url).pathname,
    $name: data.name ?? null,
  }) as Page
}

export function listPages(db: Database, projectId: string): Page[] {
  return db.prepare("SELECT * FROM pages WHERE project_id = $p ORDER BY created_at ASC").all({ $p: projectId }) as Page[]
}

export function getPage(db: Database, id: string): Page | null {
  return db.prepare("SELECT * FROM pages WHERE id = $id").get({ $id: id }) as Page | null
}

export function touchPage(db: Database, id: string): void {
  db.run("UPDATE pages SET last_scanned_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = $id", { $id: id })
}
