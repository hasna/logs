import type { Database } from "bun:sqlite"
import cron from "node-cron"
import { finishScanRun, createScanRun, listJobs, updateJob } from "./jobs.ts"
import { listPages } from "./projects.ts"
import { scanPage } from "./scanner.ts"

const tasks = new Map<string, cron.ScheduledTask>()

export function startScheduler(db: Database): void {
  const jobs = listJobs(db).filter(j => j.enabled)
  for (const job of jobs) {
    scheduleJob(db, job.id, job.schedule, job.project_id, job.page_id ?? undefined)
  }
  console.log(`Scheduler started: ${tasks.size} job(s) active`)
}

export function scheduleJob(db: Database, jobId: string, schedule: string, projectId: string, pageId?: string): void {
  if (tasks.has(jobId)) tasks.get(jobId)!.stop()
  const task = cron.schedule(schedule, async () => {
    await runJob(db, jobId, projectId, pageId)
  })
  tasks.set(jobId, task)
}

export function unscheduleJob(jobId: string): void {
  tasks.get(jobId)?.stop()
  tasks.delete(jobId)
}

export async function runJob(db: Database, jobId: string, projectId: string, pageId?: string): Promise<void> {
  const pages = pageId
    ? [{ id: pageId, url: "" }]  // will resolve url in scan
    : listPages(db, projectId)

  await Promise.all(pages.map(async (page) => {
    const run = createScanRun(db, { job_id: jobId, page_id: page.id })
    try {
      const result = await scanPage(db, projectId, page.id, page.url)
      finishScanRun(db, run.id, {
        status: "completed",
        logs_collected: result.logsCollected,
        errors_found: result.errorsFound,
        perf_score: result.perfScore ?? undefined,
      })
    } catch (err) {
      finishScanRun(db, run.id, { status: "failed", logs_collected: 0, errors_found: 0 })
      console.error(`Scan failed for page ${page.id}:`, err)
    }
  }))

  updateJob(db, jobId, { last_run_at: new Date().toISOString() })
}

export function stopScheduler(): void {
  for (const task of tasks.values()) task.stop()
  tasks.clear()
}
