import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

const MAX_PROJECTED_TEST_REPORT_SUITES = 20;
const MAX_PROJECTED_TEST_REPORT_CASES = 50;
const MAX_PROJECTED_PARSE_ERROR_LENGTH = 500;
const REDACTED_PARSE_ERROR = "[redacted raw test-report parse error]";

export interface TestReportProjectionEnvelope {
  event_id: string;
  source_event_id?: string | null;
  event_time: string;
  ingest_time: string;
  source: string;
  body?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
}

export interface TestReportProjectionIndex {
  event_id: string;
  source_event_id?: string | null;
  project_id?: string | null;
  machine_id?: string | null;
  repo_id?: string | null;
  app_id?: string | null;
  process_id?: string | null;
  run_id?: string | null;
  environment?: string | null;
  metadata?: Record<string, unknown> | null;
}

export function sanitizedTestReportMetadata(
  reportInput: unknown,
  metadataInput?: Record<string, unknown> | null,
  attributesInput?: Record<string, unknown> | null,
  extraInput?: Record<string, unknown> | null,
): Record<string, unknown> {
  const report = objectRecord(reportInput);
  const metadata = metadataInput ?? {};
  const attrs = attributesInput ?? {};
  const redaction = objectRecord(metadata.redaction);
  return compactObject({
    category: firstString(attrs, metadata, "category") ?? "test_report",
    scanner: firstString(attrs, metadata, "scanner"),
    run_type: firstString(attrs, metadata, "run_type"),
    tool: firstString(attrs, metadata, "tool"),
    package_manager: firstString(attrs, metadata, "package_manager"),
    framework: firstString(attrs, metadata, "framework"),
    script: firstString(attrs, metadata, "script"),
    report_id:
      stringValue(report.report_id) ??
      firstString(attrs, metadata, "report_id"),
    report_format:
      stringValue(report.format) ??
      firstString(attrs, metadata, "report_format") ??
      firstString(attrs, metadata, "format"),
    parser: firstString(report, attrs, metadata, "parser"),
    parse_status: firstString(report, attrs, metadata, "parse_status"),
    parse_error: sanitizedParseError(
      firstString(report, attrs, metadata, "parse_error"),
    ),
    path: firstString(report, attrs, metadata, "path"),
    size_bytes: firstNumber(report, attrs, metadata, "size_bytes"),
    content_hash: firstString(report, attrs, metadata, "content_hash"),
    changed: firstString(report, attrs, metadata, "changed"),
    mtime_ms: firstNumber(report, attrs, metadata, "mtime_ms"),
    tests: firstNumber(report, attrs, metadata, "tests"),
    failures: firstNumber(report, attrs, metadata, "failures"),
    errors: firstNumber(report, attrs, metadata, "errors"),
    skipped: firstNumber(report, attrs, metadata, "skipped"),
    time_seconds: firstNumber(report, attrs, metadata, "time_seconds"),
    suite_count: firstNumber(report, attrs, metadata, "suite_count"),
    testcase_count: firstNumber(report, attrs, metadata, "testcase_count"),
    truncated: firstBoolean(report, attrs, metadata, "truncated") ?? undefined,
    case_storage_policy: "bounded_raw_cases",
    ...compactObject(extraInput ?? {}),
    redaction: Object.keys(redaction).length > 0 ? redaction : undefined,
  });
}

interface ProjectedTestCase {
  id: string;
  report_id: string;
  suite_name: string | null;
  suite_index: number;
  case_index: number;
  name: string | null;
  classname: string | null;
  file: string | null;
  status: string | null;
  time_seconds: number | null;
  metadata: Record<string, unknown>;
}

interface ProjectedCaseResult {
  cases: ProjectedTestCase[];
  truncated: boolean;
}

export function upsertTestReportProjection(
  db: Database,
  envelope: TestReportProjectionEnvelope,
  index: TestReportProjectionIndex,
): void {
  const attrs = objectRecord(envelope.attributes);
  const body = objectRecord(envelope.body);
  const report = objectRecord(body.test_report);
  const metadata = index.metadata ?? {};
  if (Object.keys(report).length === 0 && !isTestReportCategory(attrs)) return;

  const reportId =
    stringValue(report.report_id) ??
    stringValue(attrs.report_id) ??
    stringValue(metadata.report_id) ??
    index.event_id ??
    envelope.event_id;
  const suites = reportSuites(report, metadata);
  const projected = projectedCases(reportId, suites);
  const cases = projected.cases;
  const projectionMetadata = sanitizedTestReportMetadata(
    report,
    metadata,
    attrs,
    {
      projected_case_count: cases.length,
      projected_case_limit: MAX_PROJECTED_TEST_REPORT_CASES,
    },
  );

  db.prepare(`
    INSERT INTO test_reports (
      id, event_id, source_event_id, project_id, machine_id, repo_id, app_id,
      process_id, run_id, environment, source, event_time, path, format, parser,
      parse_status, parse_error, size_bytes, content_hash, changed, mtime_ms,
      tests, failures, errors, skipped, time_seconds, suite_count,
      testcase_count, case_stored_count, truncated, metadata
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      event_id = excluded.event_id,
      source_event_id = excluded.source_event_id,
      project_id = COALESCE(excluded.project_id, test_reports.project_id),
      machine_id = COALESCE(excluded.machine_id, test_reports.machine_id),
      repo_id = COALESCE(excluded.repo_id, test_reports.repo_id),
      app_id = COALESCE(excluded.app_id, test_reports.app_id),
      process_id = COALESCE(excluded.process_id, test_reports.process_id),
      run_id = COALESCE(excluded.run_id, test_reports.run_id),
      environment = COALESCE(excluded.environment, test_reports.environment),
      source = COALESCE(excluded.source, test_reports.source),
      event_time = COALESCE(excluded.event_time, test_reports.event_time),
      path = COALESCE(excluded.path, test_reports.path),
      format = COALESCE(excluded.format, test_reports.format),
      parser = COALESCE(excluded.parser, test_reports.parser),
      parse_status = COALESCE(excluded.parse_status, test_reports.parse_status),
      parse_error = COALESCE(excluded.parse_error, test_reports.parse_error),
      size_bytes = COALESCE(excluded.size_bytes, test_reports.size_bytes),
      content_hash = COALESCE(excluded.content_hash, test_reports.content_hash),
      changed = COALESCE(excluded.changed, test_reports.changed),
      mtime_ms = COALESCE(excluded.mtime_ms, test_reports.mtime_ms),
      tests = COALESCE(excluded.tests, test_reports.tests),
      failures = COALESCE(excluded.failures, test_reports.failures),
      errors = COALESCE(excluded.errors, test_reports.errors),
      skipped = COALESCE(excluded.skipped, test_reports.skipped),
      time_seconds = COALESCE(excluded.time_seconds, test_reports.time_seconds),
      suite_count = COALESCE(excluded.suite_count, test_reports.suite_count),
      testcase_count = COALESCE(excluded.testcase_count, test_reports.testcase_count),
      case_stored_count = excluded.case_stored_count,
      truncated = excluded.truncated,
      metadata = excluded.metadata
  `).run(
    reportId,
    envelope.event_id,
    index.source_event_id ?? envelope.source_event_id ?? null,
    index.project_id ?? null,
    index.machine_id ?? null,
    index.repo_id ?? null,
    index.app_id ?? null,
    index.process_id ?? null,
    index.run_id ?? null,
    index.environment ?? null,
    envelope.source,
    envelope.event_time,
    stringValue(report.path) ??
      stringValue(attrs.path) ??
      stringValue(metadata.path),
    stringValue(report.format) ??
      stringValue(attrs.report_format) ??
      stringValue(metadata.report_format),
    stringValue(report.parser) ??
      stringValue(attrs.parser) ??
      stringValue(metadata.parser),
    stringValue(report.parse_status) ??
      stringValue(attrs.parse_status) ??
      stringValue(metadata.parse_status),
    sanitizedParseError(
      stringValue(report.parse_error) ??
        stringValue(attrs.parse_error) ??
        stringValue(metadata.parse_error),
    ),
    numberValue(report.size_bytes) ??
      numberValue(attrs.size_bytes) ??
      numberValue(metadata.size_bytes),
    stringValue(report.content_hash) ??
      stringValue(attrs.content_hash) ??
      stringValue(metadata.content_hash),
    stringValue(report.changed) ??
      stringValue(attrs.changed) ??
      stringValue(metadata.changed),
    numberValue(report.mtime_ms) ??
      numberValue(attrs.mtime_ms) ??
      numberValue(metadata.mtime_ms),
    numberValue(report.tests) ??
      numberValue(attrs.tests) ??
      numberValue(metadata.tests),
    numberValue(report.failures) ??
      numberValue(attrs.failures) ??
      numberValue(metadata.failures),
    numberValue(report.errors) ??
      numberValue(attrs.errors) ??
      numberValue(metadata.errors),
    numberValue(report.skipped) ??
      numberValue(attrs.skipped) ??
      numberValue(metadata.skipped),
    numberValue(report.time_seconds) ??
      numberValue(attrs.time_seconds) ??
      numberValue(metadata.time_seconds),
    numberValue(report.suite_count) ??
      numberValue(attrs.suite_count) ??
      numberValue(metadata.suite_count),
    numberValue(report.testcase_count) ??
      numberValue(attrs.testcase_count) ??
      numberValue(metadata.testcase_count),
    cases.length,
    projected.truncated ||
      boolValue(report.truncated) ||
      boolValue(attrs.truncated) ||
      boolValue(metadata.truncated)
      ? 1
      : 0,
    JSON.stringify(projectionMetadata),
  );

  db.prepare("DELETE FROM test_cases WHERE report_id = ?").run(reportId);
  const insertCase = db.prepare(`
    INSERT INTO test_cases (
      id, report_id, event_id, project_id, machine_id, repo_id, app_id,
      process_id, run_id, environment, suite_name, suite_index, case_index,
      name, classname, file, status, time_seconds, metadata
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      report_id = excluded.report_id,
      event_id = excluded.event_id,
      project_id = COALESCE(excluded.project_id, test_cases.project_id),
      machine_id = COALESCE(excluded.machine_id, test_cases.machine_id),
      repo_id = COALESCE(excluded.repo_id, test_cases.repo_id),
      app_id = COALESCE(excluded.app_id, test_cases.app_id),
      process_id = COALESCE(excluded.process_id, test_cases.process_id),
      run_id = COALESCE(excluded.run_id, test_cases.run_id),
      environment = COALESCE(excluded.environment, test_cases.environment),
      suite_name = excluded.suite_name,
      suite_index = excluded.suite_index,
      case_index = excluded.case_index,
      name = excluded.name,
      classname = excluded.classname,
      file = excluded.file,
      status = excluded.status,
      time_seconds = excluded.time_seconds,
      metadata = excluded.metadata
  `);
  for (const testcase of cases) {
    insertCase.run(
      testcase.id,
      testcase.report_id,
      envelope.event_id,
      index.project_id ?? null,
      index.machine_id ?? null,
      index.repo_id ?? null,
      index.app_id ?? null,
      index.process_id ?? null,
      index.run_id ?? null,
      index.environment ?? null,
      testcase.suite_name,
      testcase.suite_index,
      testcase.case_index,
      testcase.name,
      testcase.classname,
      testcase.file,
      testcase.status,
      testcase.time_seconds,
      JSON.stringify(testcase.metadata),
    );
  }
}

function projectedCases(
  reportId: string,
  suites: Record<string, unknown>[],
): ProjectedCaseResult {
  const cases: ProjectedTestCase[] = [];
  let truncated = suites.length > MAX_PROJECTED_TEST_REPORT_SUITES;
  suites
    .slice(0, MAX_PROJECTED_TEST_REPORT_SUITES)
    .forEach((suite, suiteIndex) => {
      const suiteName = stringValue(suite.name);
      const suiteCases = objectArray(suite.cases);
      const remaining = MAX_PROJECTED_TEST_REPORT_CASES - cases.length;
      if (remaining <= 0) {
        if (suiteCases.length > 0) truncated = true;
        return;
      }
      if (suiteCases.length > remaining) truncated = true;
      suiteCases.slice(0, remaining).forEach((testcase, caseIndex) => {
        const name = stringValue(testcase.name);
        const classname = stringValue(testcase.classname);
        const file = stringValue(testcase.file);
        const status = stringValue(testcase.status);
        const timeSeconds = numberValue(testcase.time_seconds);
        cases.push({
          id: testcaseProjectionId(reportId, suiteIndex, caseIndex),
          report_id: reportId,
          suite_name: suiteName,
          suite_index: suiteIndex,
          case_index: caseIndex,
          name,
          classname,
          file,
          status,
          time_seconds: timeSeconds,
          metadata: sanitizedTestCaseMetadata(
            testcase,
            suiteName,
            suiteIndex,
            caseIndex,
          ),
        });
      });
    });
  return { cases, truncated };
}

function sanitizedTestCaseMetadata(
  testcase: Record<string, unknown>,
  suiteName: string | null,
  suiteIndex: number,
  caseIndex: number,
): Record<string, unknown> {
  return compactObject({
    suite_name: suiteName,
    suite_index: suiteIndex,
    case_index: caseIndex,
    name: stringValue(testcase.name),
    classname: stringValue(testcase.classname),
    file: stringValue(testcase.file),
    status: stringValue(testcase.status),
    time_seconds: numberValue(testcase.time_seconds),
    case_storage_policy: "bounded_raw_cases",
  });
}

function reportSuites(
  report: Record<string, unknown>,
  metadata: Record<string, unknown>,
): Record<string, unknown>[] {
  const reportSuites = objectArray(report.suites);
  if (reportSuites.length > 0) return reportSuites;
  return objectArray(metadata.suites);
}

function testcaseProjectionId(
  reportId: string,
  suiteIndex: number,
  caseIndex: number,
): string {
  const digest = createHash("sha256")
    .update(reportId)
    .update("\0")
    .update(String(suiteIndex))
    .update("\0")
    .update(String(caseIndex))
    .digest("hex")
    .slice(0, 32);
  return `testcase_${digest}`;
}

function isTestReportCategory(attrs: Record<string, unknown>): boolean {
  return stringValue(attrs.category) === "test_report";
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function objectArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = objectRecord(item);
    return Object.keys(record).length > 0 ? [record] : [];
  });
}

function compactObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(
      ([, item]) => item !== undefined && item !== null,
    ),
  );
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint")
    return String(value);
  return null;
}

function firstString(
  first: Record<string, unknown>,
  second: Record<string, unknown>,
  key: string,
): string | null;
function firstString(
  first: Record<string, unknown>,
  second: Record<string, unknown>,
  third: Record<string, unknown>,
  key: string,
): string | null;
function firstString(
  first: Record<string, unknown>,
  second: Record<string, unknown>,
  thirdOrKey: Record<string, unknown> | string,
  maybeKey?: string,
): string | null {
  const records =
    typeof thirdOrKey === "string"
      ? [first, second]
      : [first, second, thirdOrKey];
  const key = typeof thirdOrKey === "string" ? thirdOrKey : maybeKey;
  if (!key) return null;
  for (const record of records) {
    const value = stringValue(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function sanitizedParseError(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (containsRawTestReportPayload(trimmed)) return REDACTED_PARSE_ERROR;
  if (trimmed.length <= MAX_PROJECTED_PARSE_ERROR_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_PROJECTED_PARSE_ERROR_LENGTH)}... [truncated]`;
}

function containsRawTestReportPayload(value: string): boolean {
  return (
    /<\s*(testsuites?|testcase|system-out|system-err|failure|error)\b/i.test(
      value,
    ) ||
    /\b(system-out|system_err|system-err|raw_xml)\b/i.test(value) ||
    /failure body/i.test(value)
  );
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function firstNumber(
  first: Record<string, unknown>,
  second: Record<string, unknown>,
  third: Record<string, unknown>,
  key: string,
): number | null {
  return (
    numberValue(first[key]) ??
    numberValue(second[key]) ??
    numberValue(third[key])
  );
}

function boolValue(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string")
    return value === "true" || value === "1" || value === "yes";
  return false;
}

function firstBoolean(
  first: Record<string, unknown>,
  second: Record<string, unknown>,
  third: Record<string, unknown>,
  key: string,
): boolean | null {
  for (const record of [first, second, third]) {
    if (record[key] !== undefined && record[key] !== null)
      return boolValue(record[key]);
  }
  return null;
}
