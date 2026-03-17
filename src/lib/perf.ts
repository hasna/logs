import type { Database } from "bun:sqlite"
import type { PerformanceSnapshot } from "../types/index.ts"

export function saveSnapshot(db: Database, data: Omit<PerformanceSnapshot, "id" | "timestamp">): PerformanceSnapshot {
  return db.prepare(`
    INSERT INTO performance_snapshots (project_id, page_id, url, lcp, fcp, cls, tti, ttfb, score, raw_audit)
    VALUES ($project_id, $page_id, $url, $lcp, $fcp, $cls, $tti, $ttfb, $score, $raw_audit)
    RETURNING *
  `).get({
    $project_id: data.project_id,
    $page_id: data.page_id ?? null,
    $url: data.url,
    $lcp: data.lcp ?? null,
    $fcp: data.fcp ?? null,
    $cls: data.cls ?? null,
    $tti: data.tti ?? null,
    $ttfb: data.ttfb ?? null,
    $score: data.score ?? null,
    $raw_audit: data.raw_audit ?? null,
  }) as PerformanceSnapshot
}

export function getLatestSnapshot(db: Database, projectId: string, pageId?: string): PerformanceSnapshot | null {
  if (pageId) {
    return db.prepare("SELECT * FROM performance_snapshots WHERE project_id = $p AND page_id = $pg ORDER BY timestamp DESC LIMIT 1")
      .get({ $p: projectId, $pg: pageId }) as PerformanceSnapshot | null
  }
  return db.prepare("SELECT * FROM performance_snapshots WHERE project_id = $p ORDER BY timestamp DESC LIMIT 1")
    .get({ $p: projectId }) as PerformanceSnapshot | null
}

export function getPerfTrend(db: Database, projectId: string, pageId?: string, since?: string, limit = 50): PerformanceSnapshot[] {
  const conditions = ["project_id = $p"]
  const params: Record<string, unknown> = { $p: projectId, $limit: limit }
  if (pageId) { conditions.push("page_id = $pg"); params.$pg = pageId }
  if (since) { conditions.push("timestamp >= $since"); params.$since = since }
  return db.prepare(`SELECT * FROM performance_snapshots WHERE ${conditions.join(" AND ")} ORDER BY timestamp DESC LIMIT $limit`)
    .all(params) as PerformanceSnapshot[]
}

export function scoreLabel(score: number | null): "green" | "yellow" | "red" | "unknown" {
  if (score === null) return "unknown"
  if (score >= 90) return "green"
  if (score >= 50) return "yellow"
  return "red"
}
