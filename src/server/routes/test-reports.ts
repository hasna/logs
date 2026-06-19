import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import {
  type TestReportQuery,
  getTestReport,
  searchTestReports,
} from "../../lib/test-reports.ts";

export function testReportsRoutes(db: Database) {
  const app = new Hono();

  app.get("/", (c) => {
    return c.json(searchTestReports(db, queryFromRequest(c.req.query())));
  });

  app.get("/:report_id", (c) => {
    const report = getTestReport(
      db,
      c.req.param("report_id"),
      c.req.query("include_cases") !== "false",
    );
    if (!report) return c.json({ error: "Test report not found" }, 404);
    return c.json(report);
  });

  return app;
}

function queryFromRequest(query: Record<string, string>): TestReportQuery {
  return {
    report_id: query.report_id,
    event_id: query.event_id,
    project_id: query.project_id,
    machine_id: query.machine_id,
    repo_id: query.repo_id,
    app_id: query.app_id,
    process_id: query.process_id,
    run_id: query.run_id,
    environment: query.environment,
    source: query.source,
    parser: query.parser,
    parse_status: query.parse_status,
    path: query.path,
    case_status: query.case_status,
    outcome: testReportOutcome(query.outcome),
    min_failures: query.min_failures ? Number(query.min_failures) : undefined,
    min_errors: query.min_errors ? Number(query.min_errors) : undefined,
    min_skipped: query.min_skipped ? Number(query.min_skipped) : undefined,
    since: query.since,
    until: query.until,
    text: query.text,
    include_cases:
      query.include_cases === "true" || query.include_cases === "1",
    limit: query.limit ? Number(query.limit) : undefined,
    offset: query.offset ? Number(query.offset) : undefined,
  };
}

function testReportOutcome(
  value: string | undefined,
): TestReportQuery["outcome"] {
  if (
    value === "failed" ||
    value === "error" ||
    value === "nonpassing" ||
    value === "skipped" ||
    value === "passed" ||
    value === "parse_problem"
  ) {
    return value;
  }
  return undefined;
}
