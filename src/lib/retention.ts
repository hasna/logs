import type { Database } from "bun:sqlite"

interface RetentionConfig {
  max_rows: number
  debug_ttl_hours: number
  info_ttl_hours: number
  warn_ttl_hours: number
  error_ttl_hours: number
}

const TTL_BY_LEVEL: Record<string, keyof RetentionConfig> = {
  debug: "debug_ttl_hours",
  info: "info_ttl_hours",
  warn: "warn_ttl_hours",
  error: "error_ttl_hours",
  fatal: "error_ttl_hours",
}

export function runRetentionForProject(db: Database, projectId: string): { deleted: number } {
  const project = db.prepare("SELECT * FROM projects WHERE id = $id").get({ $id: projectId }) as (RetentionConfig & { id: string }) | null
  if (!project) return { deleted: 0 }

  let deleted = 0

  // TTL enforcement per level
  for (const [level, configKey] of Object.entries(TTL_BY_LEVEL)) {
    const ttlHours = project[configKey] as number
    const cutoff = new Date(Date.now() - ttlHours * 3600 * 1000).toISOString()
    const before = (db.prepare("SELECT COUNT(*) as c FROM logs WHERE project_id = $p AND level = $level AND timestamp < $cutoff").get({ $p: projectId, $level: level, $cutoff: cutoff }) as { c: number }).c
    if (before > 0) {
      db.prepare("DELETE FROM logs WHERE project_id = $p AND level = $level AND timestamp < $cutoff").run({ $p: projectId, $level: level, $cutoff: cutoff })
      deleted += before
    }
  }

  // max_rows enforcement
  const total = (db.prepare("SELECT COUNT(*) as c FROM logs WHERE project_id = $p").get({ $p: projectId }) as { c: number }).c
  if (total > project.max_rows) {
    const toDelete = total - project.max_rows
    db.prepare(`DELETE FROM logs WHERE id IN (SELECT id FROM logs WHERE project_id = $p ORDER BY timestamp ASC LIMIT ${toDelete})`).run({ $p: projectId })
    deleted += toDelete
  }

  return { deleted }
}

export function runRetentionAll(db: Database): { deleted: number; projects: number } {
  const projects = db.prepare("SELECT id FROM projects").all() as { id: string }[]
  let deleted = 0
  for (const p of projects) {
    deleted += runRetentionForProject(db, p.id).deleted
  }
  return { deleted, projects: projects.length }
}

export function setRetentionPolicy(db: Database, projectId: string, config: Partial<RetentionConfig>): void {
  const fields = Object.keys(config).map(k => `${k} = $${k}`).join(", ")
  if (!fields) return
  const params = Object.fromEntries(Object.entries(config).map(([k, v]) => [`$${k}`, v]))
  params.$id = projectId
  db.prepare(`UPDATE projects SET ${fields} WHERE id = $id`).run(params)
}
