import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";

export interface BrowserIngestTokenRecord {
  id: string;
  project_id: string;
  token_prefix: string;
  name: string | null;
  allowed_origins: string | null;
  enabled: number;
  created_at: string;
  last_used_at: string | null;
}

export interface BrowserIngestToken extends BrowserIngestTokenRecord {
  token: string;
}

export interface ValidBrowserIngestToken {
  id: string;
  project_id: string;
  token_prefix: string;
  allowed_origins: string[];
}

export function createBrowserIngestToken(
  db: Database,
  projectId: string,
  opts: { name?: string; allowed_origins?: string[] } = {},
): BrowserIngestToken {
  const token = `olb_${randomBytes(32).toString("hex")}`;
  const tokenHash = hashBrowserToken(token);
  const allowedOrigins = normalizeAllowedOrigins(opts.allowed_origins ?? []);
  const row = db
    .prepare(`
    INSERT INTO browser_ingest_tokens (project_id, token_hash, token_prefix, name, allowed_origins)
    VALUES ($project_id, $token_hash, $token_prefix, $name, $allowed_origins)
    RETURNING id, project_id, token_prefix, name, allowed_origins, enabled, created_at, last_used_at
  `)
    .get({
      $project_id: projectId,
      $token_hash: tokenHash,
      $token_prefix: token.slice(0, 12),
      $name: opts.name ?? null,
      $allowed_origins:
        allowedOrigins.length > 0 ? JSON.stringify(allowedOrigins) : null,
    }) as BrowserIngestTokenRecord;

  return { ...row, token };
}

export function listBrowserIngestTokens(
  db: Database,
  projectId: string,
): BrowserIngestTokenRecord[] {
  return db
    .prepare(`
    SELECT id, project_id, token_prefix, name, allowed_origins, enabled, created_at, last_used_at
    FROM browser_ingest_tokens
    WHERE project_id = ?
    ORDER BY created_at DESC
  `)
    .all(projectId) as BrowserIngestTokenRecord[];
}

export function revokeBrowserIngestToken(
  db: Database,
  projectId: string,
  tokenId: string,
): boolean {
  const result = db
    .prepare(
      "UPDATE browser_ingest_tokens SET enabled = 0 WHERE id = ? AND project_id = ? AND enabled = 1",
    )
    .run(tokenId, projectId);
  return result.changes > 0;
}

export function validateBrowserIngestToken(
  db: Database,
  token: string | null | undefined,
  origin?: string | null,
): ValidBrowserIngestToken | null {
  if (!token || !token.startsWith("olb_")) return null;
  const row = db
    .prepare(`
    SELECT id, project_id, token_prefix, allowed_origins
    FROM browser_ingest_tokens
    WHERE token_hash = ? AND enabled = 1
  `)
    .get(hashBrowserToken(token)) as {
    id: string;
    project_id: string;
    token_prefix: string;
    allowed_origins: string | null;
  } | null;
  if (!row) return null;

  const allowedOrigins = parseAllowedOrigins(row.allowed_origins);
  if (allowedOrigins.length > 0) {
    if (!origin) return null;
    const normalizedOrigin = normalizeOrigin(origin);
    if (!normalizedOrigin || !allowedOrigins.includes(normalizedOrigin))
      return null;
  }

  return {
    id: row.id,
    project_id: row.project_id,
    token_prefix: row.token_prefix,
    allowed_origins: allowedOrigins,
  };
}

export function touchBrowserIngestToken(db: Database, tokenId: string): void {
  db.prepare(
    "UPDATE browser_ingest_tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
  ).run(tokenId);
}

export function normalizeAllowedOrigins(origins: string[]): string[] {
  const normalized = new Set<string>();
  for (const origin of origins) {
    const value = normalizeOrigin(origin);
    if (value) normalized.add(value);
  }
  return [...normalized];
}

function parseAllowedOrigins(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? normalizeAllowedOrigins(
          parsed.filter((item) => typeof item === "string"),
        )
      : [];
  } catch {
    return [];
  }
}

function normalizeOrigin(origin: string): string | null {
  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

function hashBrowserToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
