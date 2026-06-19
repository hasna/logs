#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { getDb } from "../db/index.ts";
import { getBrowserScript } from "../lib/browser-script.ts";
import { getHealth } from "../lib/health.ts";
import {
  exitIfMetadataRequest,
  hasOption,
  readOptionValue,
} from "../lib/package-meta.ts";
import { startScheduler } from "../lib/scheduler.ts";
import {
  getConfiguredApiToken,
  isLocalOpenModeEnabled,
  requireApiTokenOrBrowserIngest,
} from "./auth.ts";
import { resolveCorsOrigin } from "./cors.ts";
import { alertsRoutes } from "./routes/alerts.ts";
import { eventsRoutes } from "./routes/events.ts";
import { issuesRoutes } from "./routes/issues.ts";
import { jobsRoutes } from "./routes/jobs.ts";
import { logsRoutes } from "./routes/logs.ts";
import { otelRoutes } from "./routes/otel.ts";
import { perfRoutes } from "./routes/perf.ts";
import { projectsRoutes } from "./routes/projects.ts";
import { streamRoutes } from "./routes/stream.ts";
import { testReportsRoutes } from "./routes/test-reports.ts";

exitIfMetadataRequest({
  name: "logs-serve",
  description: "Start the @hasna/logs REST API server.",
  options: [
    "  -p, --port <n>     Port to listen on (default: LOGS_PORT or 3460)",
    "      --token <tok>  Require this API token for /api/* requests",
    "      --local-open   Explicitly allow trusted local loopback API requests without a token",
  ],
});

const portArg = readOptionValue(["--port", "-p"]);
const tokenArg = readOptionValue(["--token"]);
if (tokenArg) process.env.HASNA_LOGS_API_TOKEN = tokenArg;
if (hasOption(["--local-open"])) process.env.HASNA_LOGS_LOCAL_OPEN = "1";

const PORT = Number(portArg ?? process.env.LOGS_PORT ?? 3460);
const db = getDb();
const app = new Hono();
const serverDir = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = resolveDashboardRoot();

app.use(
  "*",
  cors({
    origin: (origin) => resolveCorsOrigin(origin),
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-Logs-Token",
      "X-Logs-Browser-Token",
      "X-Logs-Write-Token",
    ],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

// Browser tracking script
app.get("/script.js", (c) => {
  const host = `${c.req.header("x-forwarded-proto") ?? "http"}://${c.req.header("host") ?? `localhost:${PORT}`}`;
  c.header("Content-Type", "application/javascript");
  c.header("Cache-Control", "public, max-age=300");
  return c.text(getBrowserScript(host));
});

// API routes
app.use("/api/*", requireApiTokenOrBrowserIngest(db));
app.route("/api/logs", logsRoutes(db));
app.route("/api/logs/stream", streamRoutes(db));
app.route("/api/events", eventsRoutes(db));
app.route("/api/test-reports", testReportsRoutes(db));
app.route("/api/otel", otelRoutes(db));
app.route("/api/projects", projectsRoutes(db));
app.route("/api/jobs", jobsRoutes(db));
app.route("/api/alerts", alertsRoutes(db));
app.route("/api/issues", issuesRoutes(db));
app.route("/api/perf", perfRoutes(db));

app.get("/health", (c) => c.json(getHealth(db)));
app.get("/dashboard", (c) => c.redirect("/dashboard/"));
app.use(
  "/dashboard/*",
  serveStatic({
    root: dashboardRoot,
    rewriteRequestPath: (p) => p.replace(/^\/dashboard/, ""),
  }),
);
app.get("/", (c) =>
  c.json({
    service: "@hasna/logs",
    port: PORT,
    status: "ok",
    dashboard: `http://localhost:${PORT}/dashboard/`,
  }),
);

// Start scheduler
startScheduler(db);

const apiAuthMode = getConfiguredApiToken()
  ? "token"
  : isLocalOpenModeEnabled()
    ? "local-open"
    : "locked";
console.log(
  `@hasna/logs server running on http://localhost:${PORT} (api auth: ${apiAuthMode})`,
);

export default {
  port: PORT,
  fetch: app.fetch,
};

function resolveDashboardRoot(): string {
  const cwdDashboardRoot = resolve(process.cwd(), "dashboard/dist");
  const candidates = [
    cwdDashboardRoot,
    resolve(serverDir, "../../dashboard/dist"),
  ];
  return (
    candidates.find((candidate) => existsSync(candidate)) ?? cwdDashboardRoot
  );
}
