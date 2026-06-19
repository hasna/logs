import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { getIssue, listIssues, updateIssueStatus } from "../../lib/issues.ts";
import { searchLogs } from "../../lib/query.ts";
import { readJsonObject, requiredEnum } from "../request.ts";

const ISSUE_UPDATE_KEYS = ["status"] as const;
const ISSUE_STATUSES = ["open", "resolved", "ignored"] as const;

export function issuesRoutes(db: Database) {
  const app = new Hono();

  app.get("/", (c) => {
    const { project_id, status, limit } = c.req.query();
    return c.json(
      listIssues(
        db,
        project_id || undefined,
        status || undefined,
        limit ? Number(limit) : 50,
      ),
    );
  });

  app.get("/:id", (c) => {
    const issue = getIssue(db, c.req.param("id"));
    if (!issue) return c.json({ error: "not found" }, 404);
    return c.json(issue);
  });

  app.get("/:id/logs", (c) => {
    const issue = getIssue(db, c.req.param("id"));
    if (!issue) return c.json({ error: "not found" }, 404);
    // Search logs matching this issue's fingerprint via service+level
    const rows = searchLogs(db, {
      project_id: issue.project_id ?? undefined,
      level: issue.level as "error",
      service: issue.service ?? undefined,
      text: issue.message_template.slice(0, 50),
      limit: 50,
    });
    return c.json(rows);
  });

  app.put("/:id", async (c) => {
    const parsed = await readJsonObject(c, { allowedKeys: ISSUE_UPDATE_KEYS });
    if (!parsed.ok) return c.json({ error: parsed.message }, parsed.status);
    const statusInput = requiredEnum(parsed.value, "status", ISSUE_STATUSES);
    if (!statusInput.ok)
      return c.json({ error: statusInput.message }, statusInput.status);
    const status = statusInput.value;
    const updated = updateIssueStatus(db, c.req.param("id"), status);
    if (!updated) return c.json({ error: "not found" }, 404);
    return c.json(updated);
  });

  return app;
}
