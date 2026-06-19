import { describe, expect, it } from "bun:test";
import { createTestDb } from "../db/index.ts";
import { getTestReport, searchTestReports } from "./test-reports.ts";
import { ingestUniversalEvent } from "./universal-ingest.ts";

describe("test report query projections", () => {
  it("searches reports and bounded cases without exposing raw report bodies", () => {
    const db = createTestDb();
    ingestUniversalEvent(db, {
      type: "build",
      event_id: "query-test-report-event",
      event_time: "2026-06-17T10:00:00.000Z",
      source: "test",
      severity: "error",
      run_id: "run-query-test-report",
      process_id: "proc-query-test-report",
      attributes: {
        category: "test_report",
        scanner: "query-test",
      },
      body: {
        test_report: {
          report_id: "report-query-test",
          path: "test-results/query.xml",
          format: "junit_xml",
          parser: "junit-xml-v1",
          parse_status: "parsed",
          tests: 2,
          failures: 1,
          errors: 0,
          skipped: 1,
          suite_count: 1,
          testcase_count: 2,
          raw_xml: "<testsuite>must not appear</testsuite>",
          suites: [
            {
              name: "query suite",
              cases: [
                {
                  name: "fails in query",
                  classname: "query.Case",
                  file: "src/query.test.ts",
                  status: "failed",
                  time_seconds: 0.25,
                  failure: "failure body must not appear",
                },
                {
                  name: "skips in query",
                  classname: "query.Skip",
                  status: "skipped",
                },
              ],
            },
          ],
        },
      },
    });

    const rows = searchTestReports(db, {
      run_id: "run-query-test-report",
      case_status: "failed",
      text: "fails in query",
      include_cases: true,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "report-query-test",
      event_id: "query-test-report-event",
      run_id: "run-query-test-report",
      parser: "junit-xml-v1",
      parse_status: "parsed",
      tests: 2,
      failures: 1,
      skipped: 1,
      testcase_count: 2,
      case_stored_count: 2,
      truncated: false,
    });
    expect(rows[0]?.metadata).toMatchObject({
      case_storage_policy: "bounded_raw_cases",
    });
    expect(rows[0]?.cases?.map((testcase) => testcase.status)).toEqual([
      "failed",
      "skipped",
    ]);
    expect(rows[0]?.cases?.[0]).toMatchObject({
      name: "fails in query",
      classname: "query.Case",
      file: "src/query.test.ts",
      status: "failed",
      time_seconds: 0.25,
      metadata: {
        case_storage_policy: "bounded_raw_cases",
      },
    });

    const one = getTestReport(db, "report-query-test");
    expect(one?.cases).toHaveLength(2);
    expect(JSON.stringify(one)).not.toContain("failure body must not appear");
    expect(JSON.stringify(one)).not.toContain("must not appear");
  });

  it("finds aggregate failed reports without stored cases", () => {
    const db = createTestDb();
    ingestUniversalEvent(db, {
      type: "build",
      event_id: "aggregate-failed-report-event",
      event_time: "2026-06-17T10:05:00.000Z",
      source: "test",
      severity: "error",
      run_id: "run-aggregate-failed",
      attributes: { category: "test_report" },
      body: {
        test_report: {
          report_id: "report-aggregate-failed",
          path: "test-results/aggregate.xml",
          parser: "external-junit",
          parse_status: "parsed",
          tests: 4,
          failures: 1,
          errors: 0,
          skipped: 0,
          testcase_count: 4,
        },
      },
    });

    expect(
      searchTestReports(db, {
        run_id: "run-aggregate-failed",
        case_status: "failed",
      }),
    ).toEqual([]);
    expect(
      searchTestReports(db, {
        run_id: "run-aggregate-failed",
        outcome: "failed",
      }).map((report) => report.id),
    ).toEqual(["report-aggregate-failed"]);
    expect(
      searchTestReports(db, {
        min_failures: 1,
      }).map((report) => report.id),
    ).toEqual(["report-aggregate-failed"]);
  });

  it("redacts raw-looking parse errors before query surfaces return them", () => {
    const db = createTestDb();
    const rawParseError =
      "<testsuite><system-out>raw output</system-out><failure>failure body</failure></testsuite>";
    ingestUniversalEvent(db, {
      type: "build",
      event_id: "raw-parse-error-report-event",
      event_time: "2026-06-17T10:07:00.000Z",
      source: "test",
      severity: "error",
      run_id: "run-raw-parse-error",
      attributes: { category: "test_report" },
      body: {
        test_report: {
          report_id: "report-raw-parse-error",
          path: "test-results/raw-parse-error.xml",
          parser: "external-junit",
          parse_status: "failed",
          parse_error: rawParseError,
          tests: 0,
          failures: 0,
          errors: 0,
          skipped: 0,
        },
      },
    });

    const report = getTestReport(db, "report-raw-parse-error");
    expect(report?.parse_error).toBe("[redacted raw test-report parse error]");
    expect(report?.metadata?.parse_error).toBe(
      "[redacted raw test-report parse error]",
    );
    const eventRecord = db
      .prepare("SELECT metadata FROM event_records WHERE event_id = ?")
      .get("raw-parse-error-report-event") as { metadata: string } | null;
    expect(JSON.parse(eventRecord?.metadata ?? "{}")).toMatchObject({
      parse_error: "[redacted raw test-report parse error]",
    });
    const returned = JSON.stringify(
      searchTestReports(db, {
        report_id: "report-raw-parse-error",
      }),
    );
    expect(returned).not.toContain("<testsuite>");
    expect(returned).not.toContain("<system-out>");
    expect(returned).not.toContain("<failure>");
    expect(returned).not.toContain("failure body");
    expect(returned).toContain("[redacted raw test-report parse error]");
  });

  it("caps external projected cases and marks truncated reports", () => {
    const db = createTestDb();
    ingestUniversalEvent(db, {
      type: "build",
      event_id: "many-cases-report-event",
      event_time: "2026-06-17T10:10:00.000Z",
      source: "test",
      run_id: "run-many-cases",
      attributes: { category: "test_report" },
      body: {
        test_report: {
          report_id: "report-many-cases",
          path: "test-results/many.xml",
          parser: "external-junit",
          parse_status: "parsed",
          tests: 75,
          failures: 75,
          errors: 0,
          skipped: 0,
          testcase_count: 75,
          suites: [
            {
              name: "many cases",
              cases: Array.from({ length: 75 }, (_, index) => ({
                name: `case ${index}`,
                status: "failed",
              })),
            },
          ],
        },
      },
    });

    const report = getTestReport(db, "report-many-cases");
    expect(report).toMatchObject({
      id: "report-many-cases",
      case_stored_count: 50,
      testcase_count: 75,
      truncated: true,
    });
    expect(report?.cases).toHaveLength(50);
    expect(report?.metadata).toMatchObject({
      projected_case_limit: 50,
      case_storage_policy: "bounded_raw_cases",
    });
  });
});
