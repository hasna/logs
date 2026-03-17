import type { Database } from "bun:sqlite"

export interface AlertRule {
  id: string
  project_id: string
  name: string
  service: string | null
  level: string
  threshold_count: number
  window_seconds: number
  action: "webhook" | "log"
  webhook_url: string | null
  enabled: number
  last_fired_at: string | null
  created_at: string
}

export function createAlertRule(db: Database, data: {
  project_id: string
  name: string
  service?: string
  level?: string
  threshold_count?: number
  window_seconds?: number
  action?: "webhook" | "log"
  webhook_url?: string
}): AlertRule {
  return db.prepare(`
    INSERT INTO alert_rules (project_id, name, service, level, threshold_count, window_seconds, action, webhook_url)
    VALUES ($project_id, $name, $service, $level, $threshold_count, $window_seconds, $action, $webhook_url)
    RETURNING *
  `).get({
    $project_id: data.project_id,
    $name: data.name,
    $service: data.service ?? null,
    $level: data.level ?? "error",
    $threshold_count: data.threshold_count ?? 10,
    $window_seconds: data.window_seconds ?? 60,
    $action: data.action ?? "webhook",
    $webhook_url: data.webhook_url ?? null,
  }) as AlertRule
}

export function listAlertRules(db: Database, projectId?: string): AlertRule[] {
  if (projectId) {
    return db.prepare("SELECT * FROM alert_rules WHERE project_id = $p ORDER BY created_at DESC").all({ $p: projectId }) as AlertRule[]
  }
  return db.prepare("SELECT * FROM alert_rules ORDER BY created_at DESC").all() as AlertRule[]
}

export function updateAlertRule(db: Database, id: string, data: Partial<Pick<AlertRule, "enabled" | "threshold_count" | "window_seconds" | "webhook_url">>): AlertRule | null {
  const fields = Object.keys(data).map(k => `${k} = $${k}`).join(", ")
  if (!fields) return db.prepare("SELECT * FROM alert_rules WHERE id = $id").get({ $id: id }) as AlertRule | null
  const params = Object.fromEntries(Object.entries(data).map(([k, v]) => [`$${k}`, v]))
  params.$id = id
  return db.prepare(`UPDATE alert_rules SET ${fields} WHERE id = $id RETURNING *`).get(params) as AlertRule | null
}

export function deleteAlertRule(db: Database, id: string): void {
  db.run("DELETE FROM alert_rules WHERE id = $id", { $id: id })
}

export async function evaluateAlerts(db: Database, projectId: string, service: string | null, level: string): Promise<void> {
  const rules = db.prepare(`
    SELECT * FROM alert_rules
    WHERE project_id = $p AND level = $level AND enabled = 1
    AND ($service IS NULL OR service IS NULL OR service = $service)
  `).all({ $p: projectId, $level: level, $service: service }) as AlertRule[]

  for (const rule of rules) {
    const since = new Date(Date.now() - rule.window_seconds * 1000).toISOString()
    const conditions = ["project_id = $p", "level = $level", "timestamp >= $since"]
    const params: Record<string, unknown> = { $p: projectId, $level: rule.level, $since: since }
    if (rule.service) { conditions.push("service = $service"); params.$service = rule.service }

    const { count } = db.prepare(`SELECT COUNT(*) as count FROM logs WHERE ${conditions.join(" AND ")}`).get(params) as { count: number }

    if (count >= rule.threshold_count) {
      await fireAlert(db, rule, count)
    }
  }
}

async function fireAlert(db: Database, rule: AlertRule, count: number): Promise<void> {
  // Debounce: don't fire more than once per window
  if (rule.last_fired_at) {
    const lastFired = new Date(rule.last_fired_at).getTime()
    if (Date.now() - lastFired < rule.window_seconds * 1000) return
  }

  db.run("UPDATE alert_rules SET last_fired_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = $id", { $id: rule.id })

  const payload = {
    alert: rule.name,
    project_id: rule.project_id,
    level: rule.level,
    service: rule.service,
    count,
    threshold: rule.threshold_count,
    window_seconds: rule.window_seconds,
    fired_at: new Date().toISOString(),
  }

  if (rule.action === "webhook" && rule.webhook_url) {
    try {
      await fetch(rule.webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
    } catch (err) {
      console.error(`Alert webhook failed for rule ${rule.id}:`, err)
    }
  } else {
    console.warn(`[ALERT] ${rule.name}:`, JSON.stringify(payload))
  }
}
