import type { Database } from "bun:sqlite"
import { parseTime } from "./parse-time.ts"

export interface DiagnosisResult {
  project_id: string
  window: string
  score: "green" | "yellow" | "red"
  error_count: number
  warn_count: number
  has_perf_regression: boolean
  top_errors: { message: string; count: number; service: string | null; last_seen: string }[]
  error_rate_by_service: { service: string | null; errors: number; warns: number; total: number }[]
  failing_pages: { page_id: string; url: string; error_count: number }[]
  perf_regressions: { page_id: string; url: string; score_now: number | null; score_prev: number | null; delta: number | null }[]
  summary: string
}

export type DiagnoseInclude = "top_errors" | "error_rate" | "failing_pages" | "perf"

export function diagnose(db: Database, projectId: string, since?: string, include?: DiagnoseInclude[]): DiagnosisResult {
  const window = parseTime(since) ?? since ?? new Date(Date.now() - 24 * 3600 * 1000).toISOString()
  const all = !include || include.length === 0
  const want = (k: DiagnoseInclude) => all || include!.includes(k)

  // Top errors by message
  const top_errors = want("top_errors") ? db.prepare(`
    SELECT message, COUNT(*) as count, service, MAX(timestamp) as last_seen
    FROM logs
    WHERE project_id = $p AND level IN ('error','fatal') AND timestamp >= $since
    GROUP BY message, service
    ORDER BY count DESC
    LIMIT 10
  `).all({ $p: projectId, $since: window }) as DiagnosisResult["top_errors"] : []

  // Error rate by service
  const error_rate_by_service = want("error_rate") ? db.prepare(`
    SELECT service,
      SUM(CASE WHEN level IN ('error','fatal') THEN 1 ELSE 0 END) as errors,
      SUM(CASE WHEN level = 'warn' THEN 1 ELSE 0 END) as warns,
      COUNT(*) as total
    FROM logs
    WHERE project_id = $p AND timestamp >= $since
    GROUP BY service
    ORDER BY errors DESC
  `).all({ $p: projectId, $since: window }) as DiagnosisResult["error_rate_by_service"] : []

  // Failing pages (most errors)
  const failing_pages = want("failing_pages") ? db.prepare(`
    SELECT l.page_id, p.url, COUNT(*) as error_count
    FROM logs l
    JOIN pages p ON p.id = l.page_id
    WHERE l.project_id = $p AND l.level IN ('error','fatal') AND l.timestamp >= $since AND l.page_id IS NOT NULL
    GROUP BY l.page_id, p.url
    ORDER BY error_count DESC
    LIMIT 10
  `).all({ $p: projectId, $since: window }) as DiagnosisResult["failing_pages"] : []

  // Perf regressions: compare latest vs previous snapshot per page
  const perf_regressions = want("perf") ? db.prepare(`
    SELECT * FROM (
      SELECT
        cur.page_id,
        p.url,
        cur.score as score_now,
        prev.score as score_prev,
        (cur.score - prev.score) as delta
      FROM performance_snapshots cur
      JOIN pages p ON p.id = cur.page_id
      LEFT JOIN performance_snapshots prev ON prev.page_id = cur.page_id AND prev.id != cur.id
      WHERE cur.project_id = $p
      AND cur.timestamp = (SELECT MAX(timestamp) FROM performance_snapshots WHERE page_id = cur.page_id)
      AND (prev.timestamp = (SELECT MAX(timestamp) FROM performance_snapshots WHERE page_id = cur.page_id AND id != cur.id) OR prev.id IS NULL)
    ) WHERE delta < -5 OR delta IS NULL
    ORDER BY delta ASC
    LIMIT 10
  `).all({ $p: projectId }) as DiagnosisResult["perf_regressions"] : []

  const totalErrors = top_errors.reduce((s, e) => s + e.count, 0)
  const totalWarns = error_rate_by_service.reduce((s, r) => s + r.warns, 0)
  const topService = error_rate_by_service[0]
  const score: "green" | "yellow" | "red" = totalErrors === 0 ? "green" : totalErrors <= 10 ? "yellow" : "red"
  const summary = totalErrors === 0
    ? "No errors in this window. All looks good."
    : `${totalErrors} error(s) detected. Worst service: ${topService?.service ?? "unknown"} (${topService?.errors ?? 0} errors). ${failing_pages.length} page(s) with errors. ${perf_regressions.length} perf regression(s).`

  return {
    project_id: projectId, window, score, error_count: totalErrors, warn_count: totalWarns,
    has_perf_regression: perf_regressions.length > 0,
    top_errors, error_rate_by_service, failing_pages, perf_regressions, summary,
  }
}
