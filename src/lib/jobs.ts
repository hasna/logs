import type { Database } from "bun:sqlite"
import type { ScanJob, ScanRun } from "../types/index.ts"

export function createJob(db: Database, data: { project_id: string; schedule: string; page_id?: string }): ScanJob {
  return db.prepare(`
    INSERT INTO scan_jobs (project_id, page_id, schedule)
    VALUES ($project_id, $page_id, $schedule)
    RETURNING *
  `).get({
    $project_id: data.project_id,
    $page_id: data.page_id ?? null,
    $schedule: data.schedule,
  }) as ScanJob
}

export function listJobs(db: Database, projectId?: string): ScanJob[] {
  if (projectId) {
    return db.prepare("SELECT * FROM scan_jobs WHERE project_id = $p ORDER BY created_at DESC").all({ $p: projectId }) as ScanJob[]
  }
  return db.prepare("SELECT * FROM scan_jobs ORDER BY created_at DESC").all() as ScanJob[]
}

export function getJob(db: Database, id: string): ScanJob | null {
  return db.prepare("SELECT * FROM scan_jobs WHERE id = $id").get({ $id: id }) as ScanJob | null
}

export function updateJob(db: Database, id: string, data: { enabled?: number; schedule?: string; last_run_at?: string }): ScanJob | null {
  const fields = Object.keys(data).map(k => `${k} = $${k}`).join(", ")
  if (!fields) return getJob(db, id)
  const params = Object.fromEntries(Object.entries(data).map(([k, v]) => [`$${k}`, v]))
  params.$id = id
  return db.prepare(`UPDATE scan_jobs SET ${fields} WHERE id = $id RETURNING *`).get(params) as ScanJob | null
}

export function deleteJob(db: Database, id: string): void {
  db.run("DELETE FROM scan_jobs WHERE id = $id", { $id: id })
}

export function createScanRun(db: Database, data: { job_id: string; page_id?: string }): ScanRun {
  return db.prepare(`
    INSERT INTO scan_runs (job_id, page_id) VALUES ($job_id, $page_id) RETURNING *
  `).get({ $job_id: data.job_id, $page_id: data.page_id ?? null }) as ScanRun
}

export function finishScanRun(db: Database, id: string, data: { status: "completed" | "failed"; logs_collected: number; errors_found: number; perf_score?: number }): ScanRun | null {
  return db.prepare(`
    UPDATE scan_runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      status = $status, logs_collected = $logs_collected,
      errors_found = $errors_found, perf_score = $perf_score
    WHERE id = $id RETURNING *
  `).get({
    $id: id,
    $status: data.status,
    $logs_collected: data.logs_collected,
    $errors_found: data.errors_found,
    $perf_score: data.perf_score ?? null,
  }) as ScanRun | null
}

export function listScanRuns(db: Database, jobId: string, limit = 20): ScanRun[] {
  return db.prepare("SELECT * FROM scan_runs WHERE job_id = $j ORDER BY started_at DESC LIMIT $l")
    .all({ $j: jobId, $l: limit }) as ScanRun[]
}
