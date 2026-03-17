import type { Database } from "bun:sqlite"

export interface CompareResult {
  project_id: string
  window_a: { since: string; until: string }
  window_b: { since: string; until: string }
  new_errors: { message: string; service: string | null; count: number }[]
  resolved_errors: { message: string; service: string | null; count: number }[]
  error_delta_by_service: { service: string | null; errors_a: number; errors_b: number; delta: number }[]
  perf_delta_by_page: { page_id: string; url: string; score_a: number | null; score_b: number | null; delta: number | null }[]
  summary: string
}

function getErrorsByMessage(db: Database, projectId: string, since: string, until: string) {
  return db.prepare(`
    SELECT message, service, COUNT(*) as count
    FROM logs
    WHERE project_id = $p AND level IN ('error','fatal') AND timestamp >= $since AND timestamp <= $until
    GROUP BY message, service
  `).all({ $p: projectId, $since: since, $until: until }) as { message: string; service: string | null; count: number }[]
}

function getErrorsByService(db: Database, projectId: string, since: string, until: string) {
  return db.prepare(`
    SELECT service, COUNT(*) as errors
    FROM logs
    WHERE project_id = $p AND level IN ('error','fatal') AND timestamp >= $since AND timestamp <= $until
    GROUP BY service
  `).all({ $p: projectId, $since: since, $until: until }) as { service: string | null; errors: number }[]
}

export function compare(
  db: Database,
  projectId: string,
  aSince: string, aUntil: string,
  bSince: string, bUntil: string,
): CompareResult {
  const errorsA = getErrorsByMessage(db, projectId, aSince, aUntil)
  const errorsB = getErrorsByMessage(db, projectId, bSince, bUntil)

  const keyA = new Set(errorsA.map(e => `${e.service}|${e.message}`))
  const keyB = new Set(errorsB.map(e => `${e.service}|${e.message}`))

  const new_errors = errorsB.filter(e => !keyA.has(`${e.service}|${e.message}`))
  const resolved_errors = errorsA.filter(e => !keyB.has(`${e.service}|${e.message}`))

  // Service-level delta
  const svcA = getErrorsByService(db, projectId, aSince, aUntil)
  const svcB = getErrorsByService(db, projectId, bSince, bUntil)
  const svcMapA = new Map(svcA.map(s => [s.service, s.errors]))
  const svcMapB = new Map(svcB.map(s => [s.service, s.errors]))
  const allSvcs = new Set([...svcMapA.keys(), ...svcMapB.keys()])
  const error_delta_by_service = [...allSvcs].map(svc => ({
    service: svc,
    errors_a: svcMapA.get(svc) ?? 0,
    errors_b: svcMapB.get(svc) ?? 0,
    delta: (svcMapB.get(svc) ?? 0) - (svcMapA.get(svc) ?? 0),
  })).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

  // Perf delta per page
  const perf_delta_by_page = db.prepare(`
    SELECT
      pa.page_id, pg.url,
      pa.score as score_a,
      pb.score as score_b,
      (pb.score - pa.score) as delta
    FROM
      (SELECT page_id, AVG(score) as score FROM performance_snapshots WHERE project_id = $p AND timestamp >= $as AND timestamp <= $au GROUP BY page_id) pa
      JOIN pages pg ON pg.id = pa.page_id
      LEFT JOIN (SELECT page_id, AVG(score) as score FROM performance_snapshots WHERE project_id = $p AND timestamp >= $bs AND timestamp <= $bu GROUP BY page_id) pb ON pb.page_id = pa.page_id
    ORDER BY delta ASC
  `).all({ $p: projectId, $as: aSince, $au: aUntil, $bs: bSince, $bu: bUntil }) as CompareResult["perf_delta_by_page"]

  const summary = [
    `${new_errors.length} new error type(s), ${resolved_errors.length} resolved.`,
    error_delta_by_service.filter(s => s.delta > 0).map(s => `${s.service ?? "unknown"}: +${s.delta}`).join(", ") || "No error increases.",
  ].join(" ")

  return {
    project_id: projectId,
    window_a: { since: aSince, until: aUntil },
    window_b: { since: bSince, until: bUntil },
    new_errors, resolved_errors, error_delta_by_service, perf_delta_by_page, summary,
  }
}
