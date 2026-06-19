import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import {
  createBrowserIngestToken,
  listBrowserIngestTokens,
  revokeBrowserIngestToken,
} from "../../lib/browser-ingest-tokens.ts";
import { syncGithubRepo } from "../../lib/github.ts";
import { deletePageAuth, setPageAuth } from "../../lib/page-auth.ts";
import {
  createPage,
  createProject,
  getProject,
  listPages,
  listProjects,
} from "../../lib/projects.ts";
import {
  runRetentionForProject,
  setRetentionPolicy,
} from "../../lib/retention.ts";
import {
  type JsonObject,
  type ValidationResult,
  optionalNumber,
  optionalString,
  optionalStringArray,
  readJsonObject,
  requiredEnum,
  requiredString,
} from "../request.ts";

const PROJECT_CREATE_KEYS = [
  "name",
  "github_repo",
  "base_url",
  "description",
] as const;
const PAGE_CREATE_KEYS = ["url", "path", "name"] as const;
const RETENTION_KEYS = [
  "max_rows",
  "debug_ttl_hours",
  "info_ttl_hours",
  "warn_ttl_hours",
  "error_ttl_hours",
] as const;
const PAGE_AUTH_KEYS = ["type", "credentials"] as const;
const PAGE_AUTH_TYPES = ["cookie", "bearer", "basic"] as const;
const BROWSER_TOKEN_KEYS = ["name", "allowed_origins"] as const;

export function projectsRoutes(db: Database) {
  const app = new Hono();

  app.post("/", async (c) => {
    const parsed = await readJsonObject(c, {
      allowedKeys: PROJECT_CREATE_KEYS,
    });
    if (!parsed.ok) return c.json({ error: parsed.message }, parsed.status);
    const projectInput = validateProjectCreate(parsed.value);
    if (!projectInput.ok)
      return c.json({ error: projectInput.message }, projectInput.status);
    const body = projectInput.value;
    const project = createProject(db, body);
    return c.json(project, 201);
  });

  app.get("/", (c) => c.json(listProjects(db)));

  app.get("/:id", (c) => {
    const project = getProject(db, c.req.param("id"));
    if (!project) return c.json({ error: "not found" }, 404);
    return c.json(project);
  });

  app.post("/:id/pages", async (c) => {
    const parsed = await readJsonObject(c, { allowedKeys: PAGE_CREATE_KEYS });
    if (!parsed.ok) return c.json({ error: parsed.message }, parsed.status);
    const pageInput = validatePageCreate(parsed.value);
    if (!pageInput.ok)
      return c.json({ error: pageInput.message }, pageInput.status);
    const body = pageInput.value;
    const page = createPage(db, { ...body, project_id: c.req.param("id") });
    return c.json(page, 201);
  });

  app.get("/:id/pages", (c) => c.json(listPages(db, c.req.param("id"))));

  app.post("/:id/browser-tokens", async (c) => {
    const project = getProject(db, c.req.param("id"));
    if (!project) return c.json({ error: "not found" }, 404);
    const parsed = await readJsonObject(c, { allowedKeys: BROWSER_TOKEN_KEYS });
    if (!parsed.ok) return c.json({ error: parsed.message }, parsed.status);
    const tokenInput = validateBrowserTokenCreate(parsed.value);
    if (!tokenInput.ok)
      return c.json({ error: tokenInput.message }, tokenInput.status);
    const token = createBrowserIngestToken(db, project.id, tokenInput.value);
    return c.json(token, 201);
  });

  app.get("/:id/browser-tokens", (c) => {
    const project = getProject(db, c.req.param("id"));
    if (!project) return c.json({ error: "not found" }, 404);
    return c.json(listBrowserIngestTokens(db, project.id));
  });

  app.delete("/:id/browser-tokens/:token_id", (c) => {
    const project = getProject(db, c.req.param("id"));
    if (!project) return c.json({ error: "not found" }, 404);
    const revoked = revokeBrowserIngestToken(
      db,
      project.id,
      c.req.param("token_id"),
    );
    return c.json({ revoked });
  });

  app.put("/:id/retention", async (c) => {
    const parsed = await readJsonObject(c, { allowedKeys: RETENTION_KEYS });
    if (!parsed.ok) return c.json({ error: parsed.message }, parsed.status);
    const retentionInput = validateRetention(parsed.value);
    if (!retentionInput.ok)
      return c.json({ error: retentionInput.message }, retentionInput.status);
    const body = retentionInput.value;
    setRetentionPolicy(db, c.req.param("id"), body);
    return c.json({ updated: true });
  });

  app.post("/:id/retention/run", (c) => {
    const result = runRetentionForProject(db, c.req.param("id"));
    return c.json(result);
  });

  app.post("/:id/pages/:page_id/auth", async (c) => {
    const parsed = await readJsonObject(c, { allowedKeys: PAGE_AUTH_KEYS });
    if (!parsed.ok) return c.json({ error: parsed.message }, parsed.status);
    const authInput = validatePageAuth(parsed.value);
    if (!authInput.ok)
      return c.json({ error: authInput.message }, authInput.status);
    const { type, credentials } = authInput.value;
    const result = setPageAuth(db, c.req.param("page_id"), type, credentials);
    return c.json(
      { id: result.id, type: result.type, created_at: result.created_at },
      201,
    );
  });

  app.delete("/:id/pages/:page_id/auth", (c) => {
    deletePageAuth(db, c.req.param("page_id"));
    return c.json({ deleted: true });
  });

  app.post("/:id/sync-repo", async (c) => {
    const project = getProject(db, c.req.param("id"));
    if (!project) return c.json({ error: "not found" }, 404);
    if (!project.github_repo)
      return c.json({ error: "no github_repo set" }, 422);
    const updated = await syncGithubRepo(db, project);
    return c.json(updated);
  });

  return app;
}

function validateProjectCreate(body: JsonObject): ValidationResult<{
  name: string;
  github_repo?: string;
  base_url?: string;
  description?: string;
}> {
  const name = requiredString(body, "name");
  if (!name.ok) return name;
  const github_repo = optionalString(body, "github_repo");
  if (!github_repo.ok) return github_repo;
  const base_url = optionalString(body, "base_url");
  if (!base_url.ok) return base_url;
  if (base_url.value !== undefined && !isUrl(base_url.value)) {
    return {
      ok: false,
      status: 422,
      message: "body.base_url must be a valid URL",
    };
  }
  const description = optionalString(body, "description");
  if (!description.ok) return description;
  return {
    ok: true,
    value: {
      name: name.value,
      github_repo: github_repo.value,
      base_url: base_url.value,
      description: description.value,
    },
  };
}

function validatePageCreate(
  body: JsonObject,
): ValidationResult<{ url: string; path?: string; name?: string }> {
  const url = requiredString(body, "url");
  if (!url.ok) return url;
  if (!isUrl(url.value))
    return { ok: false, status: 422, message: "body.url must be a valid URL" };
  const path = optionalString(body, "path");
  if (!path.ok) return path;
  const name = optionalString(body, "name");
  if (!name.ok) return name;
  return {
    ok: true,
    value: { url: url.value, path: path.value, name: name.value },
  };
}

function validateRetention(body: JsonObject): ValidationResult<{
  max_rows?: number;
  debug_ttl_hours?: number;
  info_ttl_hours?: number;
  warn_ttl_hours?: number;
  error_ttl_hours?: number;
}> {
  const value: {
    max_rows?: number;
    debug_ttl_hours?: number;
    info_ttl_hours?: number;
    warn_ttl_hours?: number;
    error_ttl_hours?: number;
  } = {};
  for (const key of RETENTION_KEYS) {
    const field = optionalNumber(body, key, { integer: true, min: 1 });
    if (!field.ok) return field;
    if (field.value !== undefined) value[key] = field.value;
  }
  return { ok: true, value };
}

function validatePageAuth(body: JsonObject): ValidationResult<{
  type: "cookie" | "bearer" | "basic";
  credentials: string;
}> {
  const type = requiredEnum(body, "type", PAGE_AUTH_TYPES);
  if (!type.ok) return type;
  const credentials = requiredString(body, "credentials");
  if (!credentials.ok) return credentials;
  return {
    ok: true,
    value: { type: type.value, credentials: credentials.value },
  };
}

function validateBrowserTokenCreate(
  body: JsonObject,
): ValidationResult<{ name?: string; allowed_origins?: string[] }> {
  const name = optionalString(body, "name");
  if (!name.ok) return name;
  const allowedOrigins = optionalStringArray(body, "allowed_origins", {
    maxItems: 20,
  });
  if (!allowedOrigins.ok) return allowedOrigins;
  if (allowedOrigins.value) {
    const normalizedOrigins: string[] = [];
    for (const origin of allowedOrigins.value) {
      const normalized = normalizeOrigin(origin);
      if (!normalized)
        return {
          ok: false,
          status: 422,
          message: "body.allowed_origins must contain valid URL origins",
        };
      normalizedOrigins.push(normalized);
    }
    return {
      ok: true,
      value: {
        name: name.value,
        allowed_origins: [...new Set(normalizedOrigins)],
      },
    };
  }
  return { ok: true, value: { name: name.value } };
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
