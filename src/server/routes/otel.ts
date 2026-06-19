import type { Database } from "bun:sqlite";
import { type Context, Hono } from "hono";
import {
  type OtlpIngestSummary,
  ingestOtlpLogs,
  ingestOtlpMetrics,
  ingestOtlpTraces,
} from "../../lib/otlp-ingest.ts";
import { authorizeLogIngest } from "../auth.ts";
import { readJsonObject } from "../request.ts";

export function otelRoutes(db: Database) {
  const app = new Hono();

  app.post("/v1/traces", async (c) => {
    const authError = requireServerOtlpIngest(db, c);
    if (authError) return authError;
    const payload = await readJsonObject(c);
    if (!payload.ok) return c.json({ error: payload.message }, payload.status);
    return writeOtlpResponse(c, () => ingestOtlpTraces(db, payload.value));
  });

  app.post("/v1/logs", async (c) => {
    const authError = requireServerOtlpIngest(db, c);
    if (authError) return authError;
    const payload = await readJsonObject(c);
    if (!payload.ok) return c.json({ error: payload.message }, payload.status);
    return writeOtlpResponse(c, () => ingestOtlpLogs(db, payload.value));
  });

  app.post("/v1/metrics", async (c) => {
    const authError = requireServerOtlpIngest(db, c);
    if (authError) return authError;
    const payload = await readJsonObject(c);
    if (!payload.ok) return c.json({ error: payload.message }, payload.status);
    return writeOtlpResponse(c, () => ingestOtlpMetrics(db, payload.value));
  });

  return app;
}

function requireServerOtlpIngest(db: Database, c: Context): Response | null {
  const authorization = authorizeLogIngest(db, c);
  if (!authorization) return c.json({ error: "Unauthorized" }, 401);
  if (authorization.kind === "browser-token") {
    return c.json(
      { error: "Browser ingest tokens cannot write OTLP telemetry" },
      403,
    );
  }
  return null;
}

function writeOtlpResponse(
  c: Context,
  ingest: () => OtlpIngestSummary,
): Response {
  try {
    const summary = ingest();
    return c.json(
      {
        partialSuccess: {},
        signal: summary.signal,
        accepted: summary.accepted,
        inserted: summary.inserted,
        duplicates: summary.duplicates,
        events: summary.events.map((event) => ({
          event_id: event.event_id,
          event_type: event.event_type,
          source: event.source,
          trace_id: event.trace_id,
          span_id: event.span_id,
        })),
      },
      200,
    );
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      422,
    );
  }
}
