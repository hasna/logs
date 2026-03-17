import type { Database } from "bun:sqlite"
import { createHash } from "node:crypto"

export interface Issue {
  id: string
  project_id: string | null
  fingerprint: string
  level: string
  service: string | null
  message_template: string
  first_seen: string
  last_seen: string
  count: number
  status: "open" | "resolved" | "ignored"
}

export function computeFingerprint(level: string, service: string | null, message: string, stackTrace?: string | null): string {
  // Normalize message: strip hex IDs, numbers, timestamps
  const normalized = message
    .replace(/[0-9a-f]{8,}/gi, "<id>")
    .replace(/\d+/g, "<n>")
    .replace(/https?:\/\/[^\s]+/g, "<url>")
    .trim()
  const stackFrame = stackTrace ? stackTrace.split("\n").slice(0, 3).join("|") : ""
  const raw = `${level}|${service ?? ""}|${normalized}|${stackFrame}`
  return createHash("sha256").update(raw).digest("hex").slice(0, 16)
}

export function upsertIssue(db: Database, data: {
  project_id?: string
  level: string
  service?: string | null
  message: string
  stack_trace?: string | null
}): Issue {
  const fingerprint = computeFingerprint(data.level, data.service ?? null, data.message, data.stack_trace)
  return db.prepare(`
    INSERT INTO issues (project_id, fingerprint, level, service, message_template)
    VALUES ($project_id, $fingerprint, $level, $service, $message_template)
    ON CONFLICT(project_id, fingerprint) DO UPDATE SET
      count = count + 1,
      last_seen = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END
    RETURNING *
  `).get({
    $project_id: data.project_id ?? null,
    $fingerprint: fingerprint,
    $level: data.level,
    $service: data.service ?? null,
    $message_template: data.message.slice(0, 500),
  }) as Issue
}

export function listIssues(db: Database, projectId?: string, status?: string, limit = 50): Issue[] {
  const conditions: string[] = []
  const params: Record<string, unknown> = { $limit: limit }
  if (projectId) { conditions.push("project_id = $p"); params.$p = projectId }
  if (status) { conditions.push("status = $status"); params.$status = status }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""
  return db.prepare(`SELECT * FROM issues ${where} ORDER BY last_seen DESC LIMIT $limit`).all(params) as Issue[]
}

export function getIssue(db: Database, id: string): Issue | null {
  return db.prepare("SELECT * FROM issues WHERE id = $id").get({ $id: id }) as Issue | null
}

export function updateIssueStatus(db: Database, id: string, status: "open" | "resolved" | "ignored"): Issue | null {
  return db.prepare("UPDATE issues SET status = $status WHERE id = $id RETURNING *")
    .get({ $id: id, $status: status }) as Issue | null
}
