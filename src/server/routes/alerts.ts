import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import {
  createAlertRule,
  deleteAlertRule,
  listAlertRules,
  updateAlertRule,
} from "../../lib/alerts.ts";
import {
  type JsonObject,
  type ValidationResult,
  optionalEnum,
  optionalNumber,
  optionalString,
  readJsonObject,
  requiredString,
} from "../request.ts";

const ALERT_CREATE_KEYS = [
  "project_id",
  "name",
  "service",
  "level",
  "threshold_count",
  "window_seconds",
  "action",
  "webhook_url",
] as const;
const ALERT_UPDATE_KEYS = [
  "enabled",
  "threshold_count",
  "window_seconds",
  "webhook_url",
] as const;
const LOG_LEVELS = ["debug", "info", "warn", "error", "fatal"] as const;
const ALERT_ACTIONS = ["webhook", "log"] as const;

export function alertsRoutes(db: Database) {
  const app = new Hono();

  app.post("/", async (c) => {
    const parsed = await readJsonObject(c, { allowedKeys: ALERT_CREATE_KEYS });
    if (!parsed.ok) return c.json({ error: parsed.message }, parsed.status);
    const alertInput = validateAlertCreate(parsed.value);
    if (!alertInput.ok)
      return c.json({ error: alertInput.message }, alertInput.status);
    const body = alertInput.value;
    return c.json(createAlertRule(db, body), 201);
  });

  app.get("/", (c) => {
    const { project_id } = c.req.query();
    return c.json(listAlertRules(db, project_id || undefined));
  });

  app.put("/:id", async (c) => {
    const parsed = await readJsonObject(c, { allowedKeys: ALERT_UPDATE_KEYS });
    if (!parsed.ok) return c.json({ error: parsed.message }, parsed.status);
    const alertInput = validateAlertUpdate(parsed.value);
    if (!alertInput.ok)
      return c.json({ error: alertInput.message }, alertInput.status);
    const body = alertInput.value;
    const updated = updateAlertRule(db, c.req.param("id"), body);
    if (!updated) return c.json({ error: "not found" }, 404);
    return c.json(updated);
  });

  app.delete("/:id", (c) => {
    deleteAlertRule(db, c.req.param("id"));
    return c.json({ deleted: true });
  });

  return app;
}

function validateAlertCreate(body: JsonObject): ValidationResult<{
  project_id: string;
  name: string;
  service?: string;
  level?: "debug" | "info" | "warn" | "error" | "fatal";
  threshold_count?: number;
  window_seconds?: number;
  action?: "webhook" | "log";
  webhook_url?: string;
}> {
  const project_id = requiredString(body, "project_id");
  if (!project_id.ok) return project_id;
  const name = requiredString(body, "name");
  if (!name.ok) return name;
  const service = optionalString(body, "service");
  if (!service.ok) return service;
  const level = optionalEnum(body, "level", LOG_LEVELS);
  if (!level.ok) return level;
  const threshold_count = optionalNumber(body, "threshold_count", {
    integer: true,
    min: 1,
  });
  if (!threshold_count.ok) return threshold_count;
  const window_seconds = optionalNumber(body, "window_seconds", {
    integer: true,
    min: 1,
  });
  if (!window_seconds.ok) return window_seconds;
  const action = optionalEnum(body, "action", ALERT_ACTIONS);
  if (!action.ok) return action;
  const webhook_url = optionalString(body, "webhook_url");
  if (!webhook_url.ok) return webhook_url;
  if (webhook_url.value !== undefined && !isUrl(webhook_url.value)) {
    return {
      ok: false,
      status: 422,
      message: "body.webhook_url must be a valid URL",
    };
  }
  return {
    ok: true,
    value: {
      project_id: project_id.value,
      name: name.value,
      service: service.value,
      level: level.value,
      threshold_count: threshold_count.value,
      window_seconds: window_seconds.value,
      action: action.value,
      webhook_url: webhook_url.value,
    },
  };
}

function validateAlertUpdate(body: JsonObject): ValidationResult<{
  enabled?: number;
  threshold_count?: number;
  window_seconds?: number;
  webhook_url?: string;
}> {
  const enabled = optionalNumber(body, "enabled", {
    integer: true,
    min: 0,
    max: 1,
  });
  if (!enabled.ok) return enabled;
  const threshold_count = optionalNumber(body, "threshold_count", {
    integer: true,
    min: 1,
  });
  if (!threshold_count.ok) return threshold_count;
  const window_seconds = optionalNumber(body, "window_seconds", {
    integer: true,
    min: 1,
  });
  if (!window_seconds.ok) return window_seconds;
  const webhook_url = optionalString(body, "webhook_url");
  if (!webhook_url.ok) return webhook_url;
  if (
    webhook_url.value !== undefined &&
    webhook_url.value !== "" &&
    !isUrl(webhook_url.value)
  ) {
    return {
      ok: false,
      status: 422,
      message: "body.webhook_url must be a valid URL",
    };
  }
  return {
    ok: true,
    value: {
      enabled: enabled.value,
      threshold_count: threshold_count.value,
      window_seconds: window_seconds.value,
      webhook_url: webhook_url.value,
    },
  };
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
