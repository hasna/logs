import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { createJob, deleteJob, listJobs, updateJob } from "../../lib/jobs.ts";
import {
  type JsonObject,
  type ValidationResult,
  optionalNumber,
  optionalString,
  readJsonObject,
  requiredString,
} from "../request.ts";

const JOB_CREATE_KEYS = ["project_id", "schedule", "page_id"] as const;
const JOB_UPDATE_KEYS = ["enabled", "schedule", "last_run_at"] as const;

export function jobsRoutes(db: Database) {
  const app = new Hono();

  app.post("/", async (c) => {
    const parsed = await readJsonObject(c, { allowedKeys: JOB_CREATE_KEYS });
    if (!parsed.ok) return c.json({ error: parsed.message }, parsed.status);
    const jobInput = validateJobCreate(parsed.value);
    if (!jobInput.ok)
      return c.json({ error: jobInput.message }, jobInput.status);
    const body = jobInput.value;
    return c.json(createJob(db, body), 201);
  });

  app.get("/", (c) => {
    const { project_id } = c.req.query();
    return c.json(listJobs(db, project_id || undefined));
  });

  app.put("/:id", async (c) => {
    const parsed = await readJsonObject(c, { allowedKeys: JOB_UPDATE_KEYS });
    if (!parsed.ok) return c.json({ error: parsed.message }, parsed.status);
    const jobInput = validateJobUpdate(parsed.value);
    if (!jobInput.ok)
      return c.json({ error: jobInput.message }, jobInput.status);
    const body = jobInput.value;
    const updated = updateJob(db, c.req.param("id"), body);
    if (!updated) return c.json({ error: "not found" }, 404);
    return c.json(updated);
  });

  app.delete("/:id", (c) => {
    deleteJob(db, c.req.param("id"));
    return c.json({ deleted: true });
  });

  return app;
}

function validateJobCreate(body: JsonObject): ValidationResult<{
  project_id: string;
  schedule: string;
  page_id?: string;
}> {
  const project_id = requiredString(body, "project_id");
  if (!project_id.ok) return project_id;
  const schedule = requiredString(body, "schedule");
  if (!schedule.ok) return schedule;
  const page_id = optionalString(body, "page_id");
  if (!page_id.ok) return page_id;
  return {
    ok: true,
    value: {
      project_id: project_id.value,
      schedule: schedule.value,
      page_id: page_id.value,
    },
  };
}

function validateJobUpdate(body: JsonObject): ValidationResult<{
  enabled?: number;
  schedule?: string;
  last_run_at?: string;
}> {
  const enabled = optionalNumber(body, "enabled", {
    integer: true,
    min: 0,
    max: 1,
  });
  if (!enabled.ok) return enabled;
  const schedule = optionalString(body, "schedule");
  if (!schedule.ok) return schedule;
  const last_run_at = optionalString(body, "last_run_at");
  if (!last_run_at.ok) return last_run_at;
  return {
    ok: true,
    value: {
      enabled: enabled.value,
      schedule: schedule.value,
      last_run_at: last_run_at.value,
    },
  };
}
