import { describe, expect, it } from "bun:test"
import { createTestDb } from "../db/index.ts"
import { createJob, createScanRun, deleteJob, finishScanRun, listJobs, listScanRuns, updateJob } from "./jobs.ts"

function seedProject(db: ReturnType<typeof createTestDb>) {
  return db.prepare("INSERT INTO projects (name) VALUES ('test') RETURNING id").get() as { id: string }
}

describe("jobs", () => {
  it("creates a job", () => {
    const db = createTestDb()
    const p = seedProject(db)
    const job = createJob(db, { project_id: p.id, schedule: "*/5 * * * *" })
    expect(job.id).toBeTruthy()
    expect(job.schedule).toBe("*/5 * * * *")
    expect(job.enabled).toBe(1)
  })

  it("lists jobs for a project", () => {
    const db = createTestDb()
    const p = seedProject(db)
    createJob(db, { project_id: p.id, schedule: "*/5 * * * *" })
    createJob(db, { project_id: p.id, schedule: "*/10 * * * *" })
    expect(listJobs(db, p.id)).toHaveLength(2)
  })

  it("updates a job", () => {
    const db = createTestDb()
    const p = seedProject(db)
    const job = createJob(db, { project_id: p.id, schedule: "*/5 * * * *" })
    const updated = updateJob(db, job.id, { enabled: 0 })
    expect(updated?.enabled).toBe(0)
  })

  it("deletes a job", () => {
    const db = createTestDb()
    const p = seedProject(db)
    const job = createJob(db, { project_id: p.id, schedule: "*/5 * * * *" })
    deleteJob(db, job.id)
    expect(listJobs(db, p.id)).toHaveLength(0)
  })
})

describe("scan runs", () => {
  it("creates and finishes a scan run", () => {
    const db = createTestDb()
    const p = seedProject(db)
    const job = createJob(db, { project_id: p.id, schedule: "*/5 * * * *" })
    const run = createScanRun(db, { job_id: job.id })
    expect(run.status).toBe("running")
    expect(run.logs_collected).toBe(0)

    const finished = finishScanRun(db, run.id, { status: "completed", logs_collected: 12, errors_found: 3, perf_score: 87.5 })
    expect(finished?.status).toBe("completed")
    expect(finished?.logs_collected).toBe(12)
    expect(finished?.errors_found).toBe(3)
    expect(finished?.perf_score).toBe(87.5)
    expect(finished?.finished_at).toBeTruthy()
  })

  it("lists scan runs for a job", () => {
    const db = createTestDb()
    const p = seedProject(db)
    const job = createJob(db, { project_id: p.id, schedule: "*/5 * * * *" })
    createScanRun(db, { job_id: job.id })
    createScanRun(db, { job_id: job.id })
    expect(listScanRuns(db, job.id)).toHaveLength(2)
  })
})
