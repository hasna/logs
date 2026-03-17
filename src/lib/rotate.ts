import type { Database } from "bun:sqlite"

const DEFAULT_MAX_ROWS = 100_000

export function rotateLogs(db: Database, maxRows = DEFAULT_MAX_ROWS): number {
  const total = (db.prepare("SELECT COUNT(*) as c FROM logs").get() as { c: number }).c
  if (total <= maxRows) return 0
  const toDelete = total - maxRows
  db.prepare(`
    DELETE FROM logs WHERE id IN (
      SELECT id FROM logs ORDER BY timestamp ASC LIMIT ${toDelete}
    )
  `).run()
  return toDelete
}

export function rotateByProject(db: Database, projectId: string, maxRows = DEFAULT_MAX_ROWS): number {
  const total = (db.prepare("SELECT COUNT(*) as c FROM logs WHERE project_id = $p").get({ $p: projectId }) as { c: number }).c
  if (total <= maxRows) return 0
  const toDelete = total - maxRows
  db.prepare(`
    DELETE FROM logs WHERE id IN (
      SELECT id FROM logs WHERE project_id = $p ORDER BY timestamp ASC LIMIT ${toDelete}
    )
  `).run({ $p: projectId })
  return toDelete
}
