import type { Database } from "bun:sqlite";
import { parseTime } from "./parse-time.ts";

export interface TestReportQuery {
  report_id?: string;
  event_id?: string;
  project_id?: string | null;
  machine_id?: string;
  repo_id?: string;
  app_id?: string;
  process_id?: string;
  run_id?: string;
  environment?: string;
  source?: string;
  parser?: string;
  parse_status?: string;
  path?: string;
  case_status?: string;
  outcome?:
    | "failed"
    | "error"
    | "nonpassing"
    | "skipped"
    | "passed"
    | "parse_problem";
  min_failures?: number;
  min_errors?: number;
  min_skipped?: number;
  since?: string;
  until?: string;
  text?: string;
  include_cases?: boolean;
  limit?: number;
  offset?: number;
  max_limit?: number;
}

export interface TestReportCaseEntry {
  id: string;
  report_id: string;
  event_id: string | null;
  project_id: string | null;
  machine_id: string | null;
  repo_id: string | null;
  app_id: string | null;
  process_id: string | null;
  run_id: string | null;
  environment: string | null;
  suite_name: string | null;
  suite_index: number;
  case_index: number;
  name: string | null;
  classname: string | null;
  file: string | null;
  status: string | null;
  time_seconds: number | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface TestReportEntry {
  id: string;
  event_id: string | null;
  source_event_id: string | null;
  project_id: string | null;
  machine_id: string | null;
  repo_id: string | null;
  app_id: string | null;
  process_id: string | null;
  run_id: string | null;
  environment: string | null;
  source: string | null;
  event_time: string | null;
  path: string | null;
  format: string | null;
  parser: string | null;
  parse_status: string | null;
  parse_error: string | null;
  size_bytes: number | null;
  content_hash: string | null;
  changed: string | null;
  mtime_ms: number | null;
  tests: number | null;
  failures: number | null;
  errors: number | null;
  skipped: number | null;
  time_seconds: number | null;
  suite_count: number | null;
  testcase_count: number | null;
  case_stored_count: number;
  truncated: boolean;
  metadata: Record<string, unknown> | null;
  created_at: string;
  cases?: TestReportCaseEntry[];
}

type SqlParam = string | number;

export function searchTestReports(
  db: Database,
  query: TestReportQuery = {},
): TestReportEntry[] {
  const { where, params } = buildReportWhere(query);
  const limit = clampPositiveInt(query.limit, 100, query.max_limit ?? 1_000);
  const offset = clampNonNegativeInt(query.offset, 0);
  const rows = db
    .query(`
      SELECT *
      FROM test_reports
      ${where}
      ORDER BY event_time DESC, id DESC
      LIMIT ? OFFSET ?
    `)
    .all(...params, limit, offset) as TestReportRow[];
  const reports = rows.map(materializeReport);
  if (query.include_cases === true) {
    const casesByReport = loadCasesForReports(
      db,
      reports.map((report) => report.id),
    );
    for (const report of reports)
      report.cases = casesByReport.get(report.id) ?? [];
  }
  return reports;
}

export function getTestReport(
  db: Database,
  reportId: string,
  includeCases = true,
): TestReportEntry | null {
  const row = db
    .query("SELECT * FROM test_reports WHERE id = ?")
    .get(reportId) as TestReportRow | null;
  if (!row) return null;
  const report = materializeReport(row);
  if (includeCases) {
    report.cases = loadCasesForReport(db, report.id);
  }
  return report;
}

function buildReportWhere(query: TestReportQuery): {
  where: string;
  params: SqlParam[];
} {
  const conditions: string[] = [];
  const params: SqlParam[] = [];

  addScalar(conditions, params, "id", query.report_id);
  addScalar(conditions, params, "event_id", query.event_id);
  addScalar(conditions, params, "project_id", query.project_id ?? undefined);
  addScalar(conditions, params, "machine_id", query.machine_id);
  addScalar(conditions, params, "repo_id", query.repo_id);
  addScalar(conditions, params, "app_id", query.app_id);
  addScalar(conditions, params, "process_id", query.process_id);
  addScalar(conditions, params, "run_id", query.run_id);
  addScalar(conditions, params, "environment", query.environment);
  addScalar(conditions, params, "source", query.source);
  addScalar(conditions, params, "parser", query.parser);
  addScalar(conditions, params, "parse_status", query.parse_status);
  addScalar(conditions, params, "path", query.path);

  if (query.case_status) {
    conditions.push(
      "EXISTS (SELECT 1 FROM test_cases WHERE test_cases.report_id = test_reports.id AND test_cases.status = ?)",
    );
    params.push(query.case_status);
  }
  addOutcomeFilter(conditions, query.outcome);
  addMinimum(conditions, params, "failures", query.min_failures);
  addMinimum(conditions, params, "errors", query.min_errors);
  addMinimum(conditions, params, "skipped", query.min_skipped);
  if (query.since) {
    conditions.push("event_time >= ?");
    params.push(parseTime(query.since) ?? query.since);
  }
  if (query.until) {
    conditions.push("event_time <= ?");
    params.push(parseTime(query.until) ?? query.until);
  }
  if (query.text) {
    const needle = `%${escapeLike(query.text)}%`;
    conditions.push(`(
      id LIKE ? ESCAPE '\\'
      OR event_id LIKE ? ESCAPE '\\'
      OR source_event_id LIKE ? ESCAPE '\\'
      OR path LIKE ? ESCAPE '\\'
      OR parser LIKE ? ESCAPE '\\'
      OR parse_status LIKE ? ESCAPE '\\'
      OR metadata LIKE ? ESCAPE '\\'
      OR EXISTS (
        SELECT 1 FROM test_cases
        WHERE test_cases.report_id = test_reports.id
          AND (
            test_cases.name LIKE ? ESCAPE '\\'
            OR test_cases.classname LIKE ? ESCAPE '\\'
            OR test_cases.file LIKE ? ESCAPE '\\'
            OR test_cases.status LIKE ? ESCAPE '\\'
          )
      )
    )`);
    params.push(
      needle,
      needle,
      needle,
      needle,
      needle,
      needle,
      needle,
      needle,
      needle,
      needle,
      needle,
    );
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

function addOutcomeFilter(
  conditions: string[],
  outcome: TestReportQuery["outcome"],
): void {
  if (!outcome) return;
  if (outcome === "failed") {
    conditions.push("COALESCE(failures, 0) > 0");
  } else if (outcome === "error") {
    conditions.push("COALESCE(errors, 0) > 0");
  } else if (outcome === "nonpassing") {
    conditions.push("(COALESCE(failures, 0) > 0 OR COALESCE(errors, 0) > 0)");
  } else if (outcome === "skipped") {
    conditions.push("COALESCE(skipped, 0) > 0");
  } else if (outcome === "passed") {
    conditions.push(
      "parse_status = 'parsed' AND COALESCE(failures, 0) = 0 AND COALESCE(errors, 0) = 0",
    );
  } else if (outcome === "parse_problem") {
    conditions.push("(parse_status IS NULL OR parse_status != 'parsed')");
  }
}

function loadCasesForReports(
  db: Database,
  reportIds: string[],
): Map<string, TestReportCaseEntry[]> {
  const result = new Map<string, TestReportCaseEntry[]>();
  for (const reportId of reportIds) result.set(reportId, []);
  if (reportIds.length === 0) return result;
  const placeholders = reportIds.map(() => "?").join(",");
  const rows = db
    .query(`
      SELECT *
      FROM test_cases
      WHERE report_id IN (${placeholders})
      ORDER BY report_id ASC, suite_index ASC, case_index ASC, id ASC
    `)
    .all(...reportIds) as TestCaseRow[];
  for (const row of rows) {
    const cases = result.get(row.report_id);
    if (cases) cases.push(materializeCase(row));
  }
  return result;
}

function loadCasesForReport(
  db: Database,
  reportId: string,
): TestReportCaseEntry[] {
  return (
    db
      .query(`
        SELECT *
        FROM test_cases
        WHERE report_id = ?
        ORDER BY suite_index ASC, case_index ASC, id ASC
      `)
      .all(reportId) as TestCaseRow[]
  ).map(materializeCase);
}

function materializeReport(row: TestReportRow): TestReportEntry {
  return {
    ...row,
    truncated: Boolean(row.truncated),
    metadata: parseMetadata(row.metadata),
  };
}

function materializeCase(row: TestCaseRow): TestReportCaseEntry {
  return {
    ...row,
    metadata: parseMetadata(row.metadata),
  };
}

function addScalar(
  conditions: string[],
  params: SqlParam[],
  column: string,
  value: string | undefined,
): void {
  if (!value) return;
  conditions.push(`${column} = ?`);
  params.push(value);
}

function addMinimum(
  conditions: string[],
  params: SqlParam[],
  column: string,
  value: number | undefined,
): void {
  if (!Number.isFinite(value) || value === undefined) return;
  conditions.push(`COALESCE(${column}, 0) >= ?`);
  params.push(Math.max(0, Math.floor(value)));
}

function parseMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function clampPositiveInt(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.min(Math.max(1, Math.floor(value)), max);
}

function clampNonNegativeInt(
  value: number | undefined,
  fallback: number,
): number {
  if (!Number.isFinite(value) || value === undefined) return fallback;
  return Math.max(0, Math.floor(value));
}

type TestReportRow = Omit<
  TestReportEntry,
  "truncated" | "metadata" | "cases"
> & {
  truncated: number;
  metadata: string | null;
};

type TestCaseRow = Omit<TestReportCaseEntry, "metadata"> & {
  metadata: string | null;
};
