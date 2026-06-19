import type { Database } from "bun:sqlite";
import type { Context, Next } from "hono";
import {
  type ValidBrowserIngestToken,
  validateBrowserIngestToken,
} from "../lib/browser-ingest-tokens.ts";

const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

export type LogIngestAuthorization =
  | { kind: "trusted-local" }
  | { kind: "api-token" }
  | { kind: "browser-token"; token: ValidBrowserIngestToken };

export function getConfiguredApiToken(): string | null {
  const token =
    process.env.HASNA_LOGS_API_TOKEN?.trim() ||
    process.env.LOGS_API_TOKEN?.trim();
  return token || null;
}

export function isApiRequestAuthorized(c: Context): boolean {
  const token = getConfiguredApiToken();
  if (!token) return isLocalOpenModeEnabled() && isTrustedLocalRequest(c);

  const authorization = c.req.header("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization)?.[1];
  const headerToken = c.req.header("x-logs-token");
  return bearer === token || headerToken === token;
}

export function apiUnauthorizedResponse(c: Context): Response {
  return c.json(
    {
      error:
        "Unauthorized. Configure HASNA_LOGS_API_TOKEN/LOGS_API_TOKEN or explicitly enable trusted local mode with --local-open.",
    },
    401,
  );
}

export async function requireApiToken(
  c: Context,
  next: Next,
): Promise<Response | undefined> {
  if (!isApiRequestAuthorized(c)) {
    return apiUnauthorizedResponse(c);
  }
  await next();
  return undefined;
}

export function requireApiTokenOrBrowserIngest(db: Database) {
  return async (c: Context, next: Next): Promise<Response | undefined> => {
    if (isApiRequestAuthorized(c)) {
      await next();
      return undefined;
    }
    if (isBrowserWriteRequest(c) && getBrowserIngestAuthorization(db, c)) {
      await next();
      return undefined;
    }
    return apiUnauthorizedResponse(c);
  };
}

export function authorizeLogIngest(
  db: Database,
  c: Context,
): LogIngestAuthorization | null {
  const token = getConfiguredApiToken();
  if (!token) {
    const browserToken = getBrowserIngestAuthorization(db, c);
    if (browserToken) return { kind: "browser-token", token: browserToken };
    return isLocalOpenModeEnabled() && isTrustedLocalRequest(c)
      ? { kind: "trusted-local" }
      : null;
  }
  if (isApiRequestAuthorized(c)) return { kind: "api-token" };
  const browserToken = getBrowserIngestAuthorization(db, c);
  return browserToken ? { kind: "browser-token", token: browserToken } : null;
}

function getBrowserIngestAuthorization(
  db: Database,
  c: Context,
): ValidBrowserIngestToken | null {
  const token =
    c.req.header("x-logs-browser-token") ?? c.req.header("x-logs-write-token");
  return validateBrowserIngestToken(db, token, c.req.header("origin"));
}

function isBrowserWriteRequest(c: Context): boolean {
  if (c.req.method.toUpperCase() !== "POST") return false;
  const path = new URL(c.req.url).pathname.replace(/\/+$/, "");
  return path === "/api/logs" || path === "/api/events";
}

export function isLocalOpenModeEnabled(): boolean {
  return ["HASNA_LOGS_LOCAL_OPEN", "LOGS_LOCAL_OPEN"].some((name) =>
    TRUE_ENV_VALUES.has(process.env[name]?.trim().toLowerCase() ?? ""),
  );
}

export function isTrustedLocalRequest(c: Context): boolean {
  const url = new URL(c.req.url);
  const host =
    forwardedHost(c.req.header("x-forwarded-host")) ??
    hostWithoutPort(c.req.header("host")) ??
    url.hostname;
  return isLocalHost(host) && isLocalOrigin(c.req.header("origin"));
}

function forwardedHost(value: string | undefined): string | null {
  const first = value?.split(",")[0]?.trim();
  return first ? hostWithoutPort(first) : null;
}

function hostWithoutPort(value: string | undefined): string | null {
  if (!value) return null;
  if (value.startsWith("[")) return value.slice(1, value.indexOf("]"));
  return value.split(":")[0] || null;
}

function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    return isLocalHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function isLocalHost(host: string | null | undefined): boolean {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]"
  );
}
