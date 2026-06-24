#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface LabOptions {
  dataDir?: string;
  output?: string;
  keep: boolean;
  port?: number;
}

interface CommandResult {
  label: string;
  command: string[];
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

interface EventCatalogLine {
  event_id: string | null;
  event_type: string | null;
  source: string | null;
  message: string | null;
}

interface LabReport {
  ok: boolean;
  lab_id: string;
  started_at: string;
  ended_at: string;
  data_dir: string;
  data_dir_retained: boolean;
  server: {
    base_url: string;
    port: number;
  };
  commands: CommandResult[];
  streamed_events: EventCatalogLine[];
  remote_watch_events: Array<{
    event_id: string;
    event_type: string;
    message: string | null;
  }>;
  crash_recovery: {
    event_id: string;
    crash_exit_code: number;
    before_rebuild: Record<string, unknown>;
    rebuild: Record<string, unknown>;
  };
  run_summary: Record<string, unknown>;
  artifact_run_summary: Record<string, unknown>;
  test_report_run_summary: Record<string, unknown>;
  test_report_queries: {
    api_list_count: number;
    api_get_cases: number;
    cli_list_count: number;
    cli_get_cases: number;
    mcp_list_count: number;
    mcp_get_cases: number;
  };
  doctor: Record<string, unknown>;
  counts: {
    event_records: number;
    logs: number;
    runs: number;
    processes: number;
    artifacts: number;
    source_maps: number;
    source_map_sources: number;
    test_reports: number;
    test_cases: number;
    event_segments: number;
    raw_event_rows_checked: number;
    event_types: Record<string, number>;
    run_events: number;
  };
  expected_event_ids: string[];
  export_file: string;
  report_file: string | null;
  assertions: string[];
}

const options = parseArgs(process.argv.slice(2));
const startedAt = new Date().toISOString();
const labId = `real-life-lab-${Date.now()}`;
const dataDir = options.dataDir
  ? resolve(options.dataDir)
  : mkdtempSync(join(tmpdir(), "open-logs-real-life-lab-"));
const dbPath = join(dataDir, "logs.db");
const token = `lab-token-${Date.now()}`;
const commands: CommandResult[] = [];
const expectedEventIds: string[] = [];
const assertions: string[] = [];

if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

const env = {
  ...process.env,
  HASNA_LOGS_DATA_DIR: dataDir,
  HASNA_LOGS_DB_PATH: dbPath,
  HASNA_LOGS_FSYNC: "0",
  HASNA_LOGS_API_TOKEN: token,
  LOGS_DATA_DIR: "",
  LOGS_DB_PATH: "",
};

let server: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> | undefined;

try {
  const port = options.port ?? (await getFreePort());
  const baseUrl = `http://127.0.0.1:${port}`;
  server = Bun.spawn([process.execPath, "src/server/index.ts"], {
    cwd: repoRoot,
    env: { ...env, LOGS_PORT: String(port) },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForHealth(baseUrl, server);

  const project = await runCli("project create", [
    "project",
    "create",
    "--name",
    labId,
    "--url",
    baseUrl,
  ]);
  commands.push(project);
  const projectId = parseCreatedProjectId(project.stdout);

  const liveWatchArgs = [
    "watch",
    "--server",
    baseUrl,
    "--token",
    token,
    "--type",
    "log,span,exception,metric",
    "--format",
    "json",
  ];
  const liveWatcher = spawnCli(liveWatchArgs);
  const liveWatchResult = waitForProcess(
    "logs watch --server live",
    [process.execPath, "src/cli/index.ts", ...liveWatchArgs],
    liveWatcher,
    20_000,
    [0, 143],
  );
  await sleep(500);

  const cliLogId = `${labId}-cli-log`;
  expectedEventIds.push(cliLogId);
  commands.push(
    await runCli("logs push", [
      "push",
      "real-life lab cli log",
      "--id",
      cliLogId,
      "--level",
      "warn",
      "--service",
      "real-life-lab",
      "--project",
      labId,
      "--trace",
      `${labId}-trace`,
    ]),
  );

  const cliSpanId = `${labId}-cli-span`;
  expectedEventIds.push(cliSpanId);
  commands.push(
    await runCli("logs events push span", [
      "events",
      "push",
      "--type",
      "span",
      "--id",
      cliSpanId,
      "--source",
      "cli",
      "--severity",
      "info",
      "--message",
      "real-life lab cli span",
      "--project",
      labId,
      "--trace",
      `${labId}-trace`,
      "--span",
      `${labId}-span`,
      "--attributes",
      JSON.stringify({
        name: "real-life lab cli span",
        operation: "lab.cli",
        duration_ms: 7,
      }),
    ]),
  );

  const httpExceptionId = `${labId}-http-exception`;
  expectedEventIds.push(httpExceptionId);
  await postEvent(baseUrl, token, {
    type: "exception",
    event_id: httpExceptionId,
    source: "node",
    severity: "error",
    project_id: projectId,
    message: "real-life lab HTTP exception",
    trace_id: `${labId}-trace`,
    attributes: {
      service: "real-life-lab-api",
      stack_trace: "Error: real-life lab\n    at handler",
    },
  });

  const batchIds = Array.from(
    { length: 10 },
    (_, index) => `${labId}-metric-${index}`,
  );
  expectedEventIds.push(...batchIds);
  await postEvent(
    baseUrl,
    token,
    batchIds.map((eventId, index) => ({
      type: "metric",
      event_id: eventId,
      source: "sdk",
      severity: "info",
      project_id: projectId,
      message: "real-life lab batch metric",
      attributes: {
        name: "lab.metric",
        value: index,
      },
    })),
  );

  await sleep(2_000);
  liveWatcher.kill("SIGTERM");
  const liveWatch = await liveWatchResult;
  commands.push(liveWatch);
  const streamedEvents = parseEventJsonLines(liveWatch.stdout);
  const streamIds = new Set(
    streamedEvents
      .map((event) => event.event_id)
      .filter((eventId): eventId is string => typeof eventId === "string"),
  );
  const receivedStreamIds = [...streamIds].join(", ");
  assert(
    streamIds.has(cliLogId),
    `live stream received cross-process CLI log; received: ${receivedStreamIds}`,
  );
  assert(
    streamIds.has(cliSpanId),
    `live stream received cross-process CLI span; received: ${receivedStreamIds}`,
  );
  assert(
    streamIds.has(httpExceptionId),
    `live stream received HTTP-ingested exception; received: ${receivedStreamIds}`,
  );

  const run = await runCli("logs run bun test", [
    "run",
    "--json",
    "--service",
    "real-life-lab-run",
    "--project",
    labId,
    "--",
    process.execPath,
    "test",
    "src/lib/parse-time.test.ts",
  ]);
  commands.push(run);
  const runSummary = JSON.parse(run.stdout) as Record<string, unknown>;
  const runId = String(runSummary.run_id ?? "");
  assert(runId.startsWith("run_"), "logs run returned a run_id");
  assert(runSummary.status === "completed", "logs run completed successfully");
  const runResourceUsage = objectValue(runSummary.resource_usage);
  assert(
    runResourceUsage?.sampler ===
      (process.platform === "linux" ? "linux-procfs" : "unsupported"),
    "logs run returned process resource usage sampler metadata",
  );
  if (process.platform === "linux") {
    assert(
      runResourceUsage?.available === true,
      "logs run sampled Linux process resource usage",
    );
    assert(
      readRequiredNumber(runResourceUsage, "sample_count") > 0,
      "logs run resource usage has at least one sample",
    );
  }
  const runResourceEventId = `${runId}-resource`;
  expectedEventIds.push(runResourceEventId);
  const resourceRecord = readEventRecord(dbPath, runResourceEventId);
  assert(
    resourceRecord?.event_type === "metric",
    "logs run wrote an indexed process resource metric event",
  );
  assert(
    resourceRecord?.source_event_id === `${runId}:process:resource_usage`,
    "logs run resource metric preserves source_event_id mapping",
  );
  const resourceMetadata = JSON.parse(
    resourceRecord?.metadata ?? "{}",
  ) as Record<string, unknown>;
  assert(
    resourceMetadata.category === "process_resource_usage",
    "logs run resource metric records metadata category",
  );
  assert(
    resourceMetadata.sample_count === runResourceUsage?.sample_count,
    "logs run resource metric metadata matches run summary sample count",
  );
  const runProcessTree = objectValue(runSummary.process_tree);
  assert(
    runProcessTree?.sampler ===
      (process.platform === "linux" ? "linux-procfs" : "unsupported"),
    "logs run returned process tree sampler metadata",
  );
  if (process.platform === "linux") {
    assert(
      runProcessTree?.available === true,
      "logs run sampled Linux process tree metadata",
    );
    assert(
      readRequiredNumber(runProcessTree, "sample_count") > 0,
      "logs run process tree has at least one sample",
    );
  }
  const runProcessTreeEventId = `${runId}-process-tree`;
  expectedEventIds.push(runProcessTreeEventId);
  const treeRecord = readEventRecord(dbPath, runProcessTreeEventId);
  assert(
    treeRecord?.event_type === "process",
    "logs run wrote an indexed process tree event",
  );
  assert(
    treeRecord?.source_event_id === `${runId}:process:tree`,
    "logs run process tree preserves source_event_id mapping",
  );
  const treeMetadata = JSON.parse(treeRecord?.metadata ?? "{}") as Record<
    string,
    unknown
  >;
  assert(
    treeMetadata.category === "process_tree",
    "logs run process tree records metadata category",
  );
  assert(
    treeMetadata.sample_count === runProcessTree?.sample_count,
    "logs run process tree metadata matches run summary sample count",
  );
  assert(
    treeMetadata.command === undefined && treeMetadata.cwd === undefined,
    "logs run process tree metadata omits command and cwd",
  );

  const artifactWorkDir = join(dataDir, "artifact-workspace");
  mkdirSync(artifactWorkDir, { recursive: true });
  const sourceMapSourceContent =
    "OPENLOGS_REAL_LIFE_SOURCE_MAP_CONTENT_SHOULD_NOT_PERSIST";
  writeFileSync(
    join(artifactWorkDir, "source-map-source.txt"),
    sourceMapSourceContent,
    "utf8",
  );
  writeFileSync(
    join(artifactWorkDir, "generate-source-map-fixture.cjs"),
    [
      "const fs = require('node:fs');",
      "fs.mkdirSync('dist', { recursive: true });",
      "const sourceContent = fs.readFileSync('source-map-source.txt', 'utf8');",
      "fs.writeFileSync('dist/real-life-lab.js', \"console.log('real-life artifact');\\n\");",
      "fs.writeFileSync('dist/real-life-lab.js.map', JSON.stringify({",
      "  version: 3,",
      "  file: 'real-life-lab.js',",
      "  sources: ['src/real-life-lab.ts'],",
      "  sourcesContent: [sourceContent],",
      "  names: ['boot'],",
      "  mappings: 'AAAA',",
      "}));",
    ].join("\n"),
    "utf8",
  );
  const artifactRun = await runCli("logs run artifact build", [
    "run",
    "--json",
    "--service",
    "real-life-lab-build",
    "--project",
    labId,
    "--cwd",
    artifactWorkDir,
    "--",
    process.execPath,
    "generate-source-map-fixture.cjs",
    "build",
  ]);
  commands.push(artifactRun);
  const artifactRunSummary = JSON.parse(artifactRun.stdout) as Record<
    string,
    unknown
  >;
  const artifactRunId = String(artifactRunSummary.run_id ?? "");
  assert(
    artifactRunId.startsWith("run_"),
    "artifact logs run returned a run_id",
  );
  assert(
    artifactRunSummary.status === "completed",
    "artifact logs run completed successfully",
  );
  const artifactSummary = objectValue(artifactRunSummary.artifacts);
  assert(
    artifactSummary?.scanner === "common-output-roots",
    "artifact logs run returned common output-root scanner metadata",
  );
  assert(
    artifactSummary?.available === true,
    "artifact logs run scanned a real output root",
  );
  assert(
    readRequiredNumber(artifactSummary, "discovered_count") >= 2,
    "artifact logs run discovered generated output files",
  );
  const artifactItems = arrayOfObjects(artifactSummary.artifacts);
  assert(
    artifactItems.some(
      (artifact) =>
        artifact.path === "dist/real-life-lab.js" &&
        artifact.artifact_type === "javascript",
    ),
    "artifact logs run classified generated JavaScript output",
  );
  assert(
    artifactItems.some(
      (artifact) =>
        artifact.path === "dist/real-life-lab.js.map" &&
        artifact.artifact_type === "source_map",
    ),
    "artifact logs run classified generated source map output",
  );
  const jsArtifact = artifactItems.find(
    (artifact) => artifact.path === "dist/real-life-lab.js",
  );
  const sourceMapArtifact = artifactItems.find(
    (artifact) => artifact.path === "dist/real-life-lab.js.map",
  );
  const sourceMapSummary = objectValue(sourceMapArtifact?.source_map);
  assert(
    sourceMapSummary?.validation_status === "parsed" &&
      sourceMapSummary.javascript_path === "dist/real-life-lab.js" &&
      sourceMapSummary.javascript_artifact_id === jsArtifact?.artifact_id,
    "artifact logs run validated and linked generated source map metadata",
  );
  assert(
    readRequiredNumber(sourceMapSummary, "source_count") === 1 &&
      readRequiredNumber(sourceMapSummary, "names_count") === 1 &&
      readRequiredNumber(sourceMapSummary, "mappings_length") === 4 &&
      sourceMapSummary.has_sources_content === true,
    "artifact logs run summarized source map sources, names, mappings, and sourcesContent presence",
  );
  assert(
    !JSON.stringify(sourceMapSummary).includes(sourceMapSourceContent),
    "artifact logs run source-map summary omits source content",
  );
  for (const artifact of artifactItems) {
    const artifactId = String(artifact.artifact_id ?? "");
    const artifactPath = String(artifact.path ?? "");
    assert(artifactId.length > 0, "artifact logs run returned artifact IDs");
    expectedEventIds.push(artifactId);
    const artifactRecord = readEventRecord(dbPath, artifactId);
    assert(
      artifactRecord?.event_type === "artifact",
      `artifact event ${artifactId} was indexed`,
    );
    assert(
      artifactRecord?.source_event_id ===
        `${artifactRunId}:artifact:${artifactId}`,
      `artifact event ${artifactId} preserves source_event_id mapping`,
    );
    const artifactMetadata = JSON.parse(
      artifactRecord?.metadata ?? "{}",
    ) as Record<string, unknown>;
    assert(
      artifactMetadata.category === "build_artifact",
      `artifact event ${artifactId} records build_artifact metadata`,
    );
    assert(
      typeof artifactMetadata.path === "string" &&
        artifactMetadata.path.startsWith("dist/"),
      `artifact event ${artifactId} stores a relative output path`,
    );
    assert(
      artifactMetadata.content_hash === artifact.content_hash,
      `artifact event ${artifactId} metadata preserves content hash`,
    );
    const artifactRow = readArtifactRow(dbPath, artifactId);
    assert(
      artifactRow?.path === artifactPath,
      `SQLite artifacts projection contains ${artifactPath}`,
    );
    assert(
      artifactRow?.content_hash === artifact.content_hash,
      `SQLite artifacts projection preserves hash for ${artifactPath}`,
    );
  }
  const sourceMapProjection = readSourceMapProjection(
    dbPath,
    String(sourceMapArtifact?.artifact_id ?? ""),
  );
  assert(
    sourceMapProjection?.javascript_path === "dist/real-life-lab.js" &&
      sourceMapProjection.validation_status === "parsed" &&
      sourceMapProjection.source_count === 1,
    "SQLite source_maps projection links generated source map to JavaScript output",
  );
  assert(
    sourceMapProjection?.has_sources_content === 1 &&
      !String(sourceMapProjection.metadata ?? "").includes(
        sourceMapSourceContent,
      ),
    "SQLite source_maps projection records sourcesContent presence without source content",
  );
  const sourceMapSourceRows = readSourceMapSources(
    dbPath,
    String(sourceMapArtifact?.artifact_id ?? ""),
  );
  assert(
    sourceMapSourceRows.length === 1 &&
      sourceMapSourceRows[0]?.source_path === "src/real-life-lab.ts" &&
      sourceMapSourceRows[0]?.has_content === 1 &&
      /^[a-f0-9]{64}$/.test(sourceMapSourceRows[0]?.content_hash ?? ""),
    "SQLite source_map_sources projection stores source path and content hash only",
  );
  assert(
    !JSON.stringify(sourceMapSourceRows).includes(sourceMapSourceContent),
    "SQLite source_map_sources projection omits source content",
  );

  const testReportWorkDir = join(dataDir, "test-report-workspace");
  mkdirSync(join(testReportWorkDir, "test-results"), { recursive: true });
  writeFileSync(
    join(testReportWorkDir, "real-life-junit.test.ts"),
    [
      'import { expect, test } from "bun:test";',
      'test("real life junit report metadata", () => {',
      "  expect(1 + 1).toBe(2);",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  const testReportRun = await runCli("logs run JUnit test report", [
    "run",
    "--json",
    "--service",
    "real-life-lab-junit",
    "--project",
    labId,
    "--cwd",
    testReportWorkDir,
    "--",
    process.execPath,
    "test",
    "--reporter=junit",
    "--reporter-outfile",
    "test-results/junit.xml",
    "real-life-junit.test.ts",
  ]);
  commands.push(testReportRun);
  const testReportRunSummary = JSON.parse(testReportRun.stdout) as Record<
    string,
    unknown
  >;
  const testReportRunId = String(testReportRunSummary.run_id ?? "");
  assert(
    testReportRunId.startsWith("run_"),
    "test-report logs run returned a run_id",
  );
  assert(
    testReportRunSummary.status === "completed",
    "test-report logs run completed successfully",
  );
  const testReportSummary = objectValue(testReportRunSummary.test_reports);
  assert(
    testReportSummary?.scanner === "common-test-report-roots",
    "test-report logs run returned common test-report scanner metadata",
  );
  assert(
    testReportSummary?.available === true,
    "test-report logs run scanned a real report root",
  );
  assert(
    readRequiredNumber(testReportSummary, "discovered_count") >= 1,
    "test-report logs run discovered generated JUnit XML",
  );
  const testReportItems = arrayOfObjects(testReportSummary.reports);
  const junitReport = testReportItems.find(
    (report) => report.path === "test-results/junit.xml",
  );
  assert(
    Boolean(junitReport),
    "test-report logs run returned JUnit report path",
  );
  assert(
    junitReport?.format === "junit_xml" &&
      junitReport?.parser === "junit-xml-v1" &&
      junitReport?.parse_status === "parsed",
    "test-report logs run parsed JUnit XML metadata",
  );
  assert(
    readRequiredNumber(junitReport ?? {}, "tests") >= 1,
    "test-report logs run parsed at least one test case",
  );
  assert(
    readRequiredNumber(junitReport ?? {}, "failures") === 0 &&
      readRequiredNumber(junitReport ?? {}, "errors") === 0,
    "test-report logs run parsed passing JUnit failure/error counts",
  );
  const testReportId = String(junitReport?.report_id ?? "");
  assert(testReportId.length > 0, "test-report logs run returned report ID");
  expectedEventIds.push(testReportId);
  const testReportRecord = readEventRecord(dbPath, testReportId);
  assert(
    testReportRecord?.event_type === "build",
    "test report was indexed as a build event",
  );
  assert(
    testReportRecord?.source_event_id ===
      `${testReportRunId}:test_report:${testReportId}`,
    "test report event preserves source_event_id mapping",
  );
  const testReportMetadata = JSON.parse(
    testReportRecord?.metadata ?? "{}",
  ) as Record<string, unknown>;
  assert(
    testReportMetadata.category === "test_report",
    "test report event records test_report metadata category",
  );
  assert(
    testReportMetadata.path === "test-results/junit.xml",
    "test report event stores a relative report path",
  );
  assert(
    testReportMetadata.content_hash === junitReport?.content_hash,
    "test report event metadata preserves content hash",
  );
  const testReportProjection = readTestReportProjection(dbPath, testReportId);
  assert(
    testReportProjection?.event_id === testReportId &&
      testReportProjection?.run_id === testReportRunId,
    "SQLite test_reports projection maps report to event and run",
  );
  assert(
    testReportProjection?.path === "test-results/junit.xml" &&
      testReportProjection?.parser === "junit-xml-v1" &&
      testReportProjection?.parse_status === "parsed",
    "SQLite test_reports projection preserves report parser metadata",
  );
  assert(
    testReportProjection?.tests === junitReport?.tests &&
      testReportProjection?.failures === 0 &&
      testReportProjection?.errors === 0,
    "SQLite test_reports projection preserves JUnit counts",
  );
  assert(
    testReportProjection?.case_stored_count === 0 &&
      countTestCasesForReport(dbPath, testReportId) === 0,
    "SQLite test_cases projection stores no bounded case rows for passing report",
  );

  const apiTestReportList = (await getJson(
    `${baseUrl}/api/test-reports?run_id=${encodeURIComponent(testReportRunId)}&outcome=passed&text=junit&include_cases=true`,
    token,
  )) as Array<Record<string, unknown>>;
  const apiListedReport = apiTestReportList.find(
    (report) => report.id === testReportId,
  );
  assert(
    Boolean(apiListedReport),
    "API test-report list finds the captured passing JUnit report",
  );
  assert(
    Array.isArray(apiListedReport?.cases) && apiListedReport.cases.length === 0,
    "API test-report list includes bounded empty case rows for passing report",
  );
  const apiTestReportGet = (await getJson(
    `${baseUrl}/api/test-reports/${encodeURIComponent(testReportId)}`,
    token,
  )) as Record<string, unknown>;
  assert(
    apiTestReportGet.id === testReportId &&
      apiTestReportGet.event_id === testReportId,
    "API test-report get returns the captured report",
  );
  assert(
    Array.isArray(apiTestReportGet.cases) &&
      apiTestReportGet.cases.length === 0,
    "API test-report get returns bounded case rows",
  );
  assertNoRawTestReportPayload(
    apiTestReportGet,
    "API test-report get omits raw XML/system output/failure bodies",
  );

  const cliTestReportList = await runCli("logs test-reports list", [
    "test-reports",
    "list",
    "--run",
    testReportRunId,
    "--outcome",
    "passed",
    "--text",
    "junit",
    "--include-cases",
    "--format",
    "json",
  ]);
  commands.push(cliTestReportList);
  const cliListedReports = JSON.parse(cliTestReportList.stdout) as Array<
    Record<string, unknown>
  >;
  const cliListedReport = cliListedReports.find(
    (report) => report.id === testReportId,
  );
  assert(
    Boolean(cliListedReport),
    "CLI test-reports list finds the captured passing JUnit report",
  );
  assert(
    Array.isArray(cliListedReport?.cases) && cliListedReport.cases.length === 0,
    "CLI test-reports list includes bounded empty case rows for passing report",
  );
  const cliTestReportGet = await runCli("logs test-reports get", [
    "test-reports",
    "get",
    testReportId,
  ]);
  commands.push(cliTestReportGet);
  const cliGotReport = JSON.parse(cliTestReportGet.stdout) as Record<
    string,
    unknown
  >;
  assert(
    cliGotReport.id === testReportId && cliGotReport.event_id === testReportId,
    "CLI test-reports get returns the captured report",
  );
  assert(
    Array.isArray(cliGotReport.cases) && cliGotReport.cases.length === 0,
    "CLI test-reports get returns bounded case rows",
  );
  assertNoRawTestReportPayload(
    cliGotReport,
    "CLI test-reports get omits raw XML/system output/failure bodies",
  );

  const mcpTestReportSearch = await callMcpTool(
    "test_report_search",
    {
      run_id: testReportRunId,
      outcome: "passed",
      text: "junit",
      include_cases: true,
    },
    dataDir,
  );
  const mcpListedReports = JSON.parse(
    mcpToolText(mcpTestReportSearch),
  ) as Array<Record<string, unknown>>;
  const mcpListedReport = mcpListedReports.find(
    (report) => report.id === testReportId,
  );
  assert(
    Boolean(mcpListedReport),
    "MCP test_report_search finds the captured passing JUnit report",
  );
  assert(
    Array.isArray(mcpListedReport?.cases) && mcpListedReport.cases.length === 0,
    "MCP test_report_search includes bounded empty case rows for passing report",
  );
  const mcpTestReportGet = await callMcpTool(
    "test_report_get",
    { report_id: testReportId },
    dataDir,
  );
  const mcpGotReport = JSON.parse(mcpToolText(mcpTestReportGet)) as Record<
    string,
    unknown
  >;
  assert(
    mcpGotReport.id === testReportId && mcpGotReport.event_id === testReportId,
    "MCP test_report_get returns the captured report",
  );
  assert(
    Array.isArray(mcpGotReport.cases) && mcpGotReport.cases.length === 0,
    "MCP test_report_get returns bounded case rows",
  );
  assertNoRawTestReportPayload(
    mcpGotReport,
    "MCP test_report_get omits raw XML/system output/failure bodies",
  );
  const testReportQueries = {
    api_list_count: apiTestReportList.length,
    api_get_cases: Array.isArray(apiTestReportGet.cases)
      ? apiTestReportGet.cases.length
      : -1,
    cli_list_count: cliListedReports.length,
    cli_get_cases: Array.isArray(cliGotReport.cases)
      ? cliGotReport.cases.length
      : -1,
    mcp_list_count: mcpListedReports.length,
    mcp_get_cases: Array.isArray(mcpGotReport.cases)
      ? mcpGotReport.cases.length
      : -1,
  };

  const watchAnchorId = `${labId}-watch-anchor`;
  const watchCatchupId = `${labId}-watch-catchup`;
  const watchLiveId = `${labId}-watch-live`;
  expectedEventIds.push(watchAnchorId, watchCatchupId, watchLiveId);
  await postEvent(baseUrl, token, {
    type: "metric",
    event_id: watchAnchorId,
    source: "sdk",
    severity: "info",
    project_id: projectId,
    message: "real-life lab watch anchor",
  });
  await postEvent(baseUrl, token, {
    type: "metric",
    event_id: watchCatchupId,
    source: "sdk",
    severity: "info",
    project_id: projectId,
    message: "real-life lab watch catch-up",
  });
  const catchupWatcher = spawnCli([
    "watch",
    "--server",
    baseUrl,
    "--token",
    token,
    "--type",
    "metric",
    "--last-event-id",
    watchAnchorId,
    "--once",
    "--format",
    "json",
  ]);
  const catchupWatch = await waitForProcess(
    "logs watch --server catch-up",
    [
      process.execPath,
      "src/cli/index.ts",
      "watch",
      "--server",
      baseUrl,
      "--token",
      token,
      "--type",
      "metric",
      "--last-event-id",
      watchAnchorId,
      "--once",
      "--format",
      "json",
    ],
    catchupWatcher,
    10_000,
  );
  commands.push(catchupWatch);
  const remoteCatchupEvents = parseRemoteWatchEvents(catchupWatch.stdout);
  assert(
    remoteCatchupEvents.length === 1,
    "logs watch --server catch-up emitted exactly one event",
  );
  assert(
    remoteCatchupEvents[0]?.event_id === watchCatchupId,
    "logs watch --server caught up a pre-existing event after Last-Event-ID",
  );
  assert(
    !remoteCatchupEvents.some((event) => event.event_id === watchAnchorId),
    "logs watch --server did not replay the Last-Event-ID anchor",
  );
  const watcher = spawnCli([
    "watch",
    "--server",
    baseUrl,
    "--token",
    token,
    "--type",
    "metric",
    "--last-event-id",
    watchCatchupId,
    "--once",
    "--format",
    "json",
  ]);
  const watcherResult = waitForProcess(
    "logs watch --server",
    [
      process.execPath,
      "src/cli/index.ts",
      "watch",
      "--server",
      baseUrl,
      "--token",
      token,
      "--type",
      "metric",
      "--last-event-id",
      watchCatchupId,
      "--once",
      "--format",
      "json",
    ],
    watcher,
    10_000,
  );
  await sleep(200);
  await postEvent(baseUrl, token, {
    type: "metric",
    event_id: watchLiveId,
    source: "sdk",
    severity: "info",
    project_id: projectId,
    message: "real-life lab watch live",
  });
  const watch = await watcherResult;
  commands.push(watch);
  const remoteLiveEvents = parseRemoteWatchEvents(watch.stdout);
  assert(
    remoteLiveEvents.length === 1,
    "logs watch --server live follow-up emitted exactly one event",
  );
  assert(
    remoteLiveEvents[0]?.event_id === watchLiveId,
    "logs watch --server received live event after Last-Event-ID",
  );
  const remoteWatchEvents = [...remoteCatchupEvents, ...remoteLiveEvents];

  const crashEventId = `${labId}-crash-raw-before-index`;
  expectedEventIds.push(crashEventId);
  const crash = await runRawAppendCrashWorker(crashEventId);
  commands.push(crash);
  assert(
    crash.exit_code === 42,
    "crash drill producer exited after raw append before indexing",
  );
  assert(crash.stderr === "", "crash drill producer wrote no stderr");

  const preRebuildDoctor = await runCliWithAllowedExitCodes(
    "logs doctor segments before crash rebuild",
    ["doctor", "segments", "--json"],
    [1],
  );
  commands.push(preRebuildDoctor);
  const preRebuildDoctorResult = JSON.parse(preRebuildDoctor.stdout) as Record<
    string,
    unknown
  >;
  assert(
    preRebuildDoctorResult.ok === false,
    "doctor segments detected crash-appended raw event before rebuild",
  );
  assert(
    readRequiredNumber(preRebuildDoctorResult, "unindexed_raw_events") === 1,
    "doctor segments reported exactly one unindexed crash-drill raw event",
  );
  assert(
    JSON.stringify(preRebuildDoctorResult.errors ?? []).includes(
      "Raw event is not indexed in SQLite",
    ),
    "doctor segments explained the unindexed crash-drill raw event",
  );

  const crashRebuild = await runCli("logs doctor rebuild-index after crash", [
    "doctor",
    "rebuild-index",
    "--json",
  ]);
  commands.push(crashRebuild);
  const crashRebuildResult = JSON.parse(crashRebuild.stdout) as Record<
    string,
    unknown
  >;
  const crashRebuildStats = objectValue(crashRebuildResult.rebuild);
  const crashRebuildVerification = objectValue(crashRebuildResult.verification);
  assert(
    crashRebuildStats?.errors &&
      Array.isArray(crashRebuildStats.errors) &&
      crashRebuildStats.errors.length === 0,
    "crash rebuild completed without rebuild errors",
  );
  assert(
    crashRebuildVerification?.ok === true,
    "crash rebuild verification returned to ok",
  );
  assert(
    readRequiredNumber(
      crashRebuildVerification ?? {},
      "unindexed_raw_events",
    ) === 0,
    "crash rebuild cleared all unindexed raw events",
  );
  const crashRecord = readEventRecord(dbPath, crashEventId);
  assert(
    crashRecord?.event_type === "log",
    "crash rebuild indexed the raw-appended log event",
  );
  assert(
    readLogMessage(dbPath, crashEventId) === "producer died after raw append",
    "crash rebuild reconstructed the log projection from raw evidence",
  );
  const crashRecovery = {
    event_id: crashEventId,
    crash_exit_code: crash.exit_code,
    before_rebuild: preRebuildDoctorResult,
    rebuild: crashRebuildResult,
  };

  const exportFile = join(dataDir, "events-export.json");
  commands.push(
    await runCli("logs events export", [
      "events",
      "export",
      "--include-raw",
      "--output",
      exportFile,
    ]),
  );
  const exported = JSON.parse(readFileSync(exportFile, "utf8")) as unknown[];
  assert(
    exported.length >= expectedEventIds.length,
    "event export contains lab events",
  );
  assertExportContainsRawEvents(exported, expectedEventIds);

  const doctor = await runCli("logs doctor segments", [
    "doctor",
    "segments",
    "--json",
  ]);
  commands.push(doctor);
  const doctorResult = JSON.parse(doctor.stdout) as Record<string, unknown>;
  assert(doctorResult.ok === true, "doctor segments verified raw store");
  const doctorCheckedRecords = readRequiredNumber(
    doctorResult,
    "checked_records",
  );
  const doctorCheckedSegments = readRequiredNumber(
    doctorResult,
    "checked_segments",
  );
  const doctorCheckedRawEvents = readRequiredNumber(
    doctorResult,
    "checked_raw_events",
  );
  const doctorUnindexedRawEvents = readRequiredNumber(
    doctorResult,
    "unindexed_raw_events",
  );

  const counts = readCounts(dbPath, runId, doctorCheckedRawEvents);
  for (const eventId of expectedEventIds) {
    assert(eventExists(dbPath, eventId), `event_records contains ${eventId}`);
  }
  assert(counts.run_events > 0, "run_id has indexed process/log events");
  assert(counts.event_segments > 0, "raw segment rows exist");
  assert(
    doctorCheckedSegments === counts.event_segments,
    "doctor checked every raw segment",
  );
  assert(
    doctorCheckedRecords === counts.event_records,
    "doctor checked every indexed event record",
  );
  assert(
    doctorCheckedRawEvents === counts.event_records,
    "doctor checked raw rows for every indexed event record",
  );
  assert(
    doctorUnindexedRawEvents === 0,
    "doctor found no unindexed raw events",
  );

  const reportFile =
    options.output ??
    (options.keep || options.dataDir
      ? join(dataDir, "real-life-validation-report.json")
      : null);
  const report: LabReport = {
    ok: true,
    lab_id: labId,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    data_dir: dataDir,
    data_dir_retained: Boolean(options.keep || options.dataDir),
    server: { base_url: baseUrl, port },
    commands,
    streamed_events: streamedEvents,
    remote_watch_events: remoteWatchEvents,
    crash_recovery: crashRecovery,
    run_summary: runSummary,
    artifact_run_summary: artifactRunSummary,
    test_report_run_summary: testReportRunSummary,
    test_report_queries: testReportQueries,
    doctor: doctorResult,
    counts,
    expected_event_ids: expectedEventIds,
    export_file: exportFile,
    report_file: reportFile,
    assertions,
  };

  if (reportFile) {
    mkdirSync(dirname(reportFile), { recursive: true });
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  if (server) await stopServer(server);
  if (!options.keep && !options.dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

function parseArgs(args: string[]): LabOptions {
  const result: LabOptions = { keep: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--keep") {
      result.keep = true;
      continue;
    }
    if (arg === "--data-dir") {
      index += 1;
      result.dataDir = requireValue(args, index, arg);
      continue;
    }
    if (arg === "--output") {
      index += 1;
      result.output = requireValue(args, index, arg);
      continue;
    }
    if (arg === "--port") {
      index += 1;
      result.port = Number(requireValue(args, index, arg));
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: bun scripts/real-life-validation-lab.ts [--keep] [--data-dir <dir>] [--output <file>] [--port <n>]",
          "",
          "Runs a real multi-process telemetry validation lab over the CLI, REST API, SSE stream, and raw segment verifier.",
        ].join("\n"),
      );
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return result;
}

function requireValue(args: string[], index: number, label: string): string {
  const value = args[index];
  if (!value) throw new Error(`${label} requires a value`);
  return value;
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to allocate free port"));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

async function waitForHealth(
  baseUrl: string,
  child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>,
): Promise<void> {
  const started = performance.now();
  while (performance.now() - started < 8_000) {
    const exited = await Promise.race([
      child.exited.then((code) => ({ code })),
      sleep(50).then(() => null),
    ]);
    if (exited)
      throw new Error(`Server exited before health check: ${exited.code}`);
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Retry until timeout.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${baseUrl}/health`);
}

async function runCli(label: string, args: string[]): Promise<CommandResult> {
  const child = spawnCli(args);
  return await waitForProcess(
    label,
    [process.execPath, "src/cli/index.ts", ...args],
    child,
    20_000,
  );
}

async function runCliWithAllowedExitCodes(
  label: string,
  args: string[],
  allowedExitCodes: number[],
): Promise<CommandResult> {
  const child = spawnCli(args);
  return await waitForProcess(
    label,
    [process.execPath, "src/cli/index.ts", ...args],
    child,
    20_000,
    allowedExitCodes,
  );
}

function spawnCli(
  args: string[],
): ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> {
  return Bun.spawn([process.execPath, "src/cli/index.ts", ...args], {
    cwd: repoRoot,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function runRawAppendCrashWorker(
  eventId: string,
): Promise<CommandResult> {
  const script = `
    import { getDb } from "./src/db/index.ts";
    import { appendRawEvent } from "./src/lib/event-store.ts";

    const db = getDb();
    const now = new Date().toISOString();
    appendRawEvent(db, {
      schema_version: 1,
      event_id: ${JSON.stringify(eventId)},
      source_event_id: "producer-crash-raw-before-index",
      event_time: now,
      ingest_time: now,
      type: "log",
      source: "sdk",
      severity: "error",
      privacy: "internal",
      message: "producer died after raw append",
      body: {
        log: {
          id: ${JSON.stringify(eventId)},
          timestamp: now,
          level: "error",
          source: "sdk",
          service: "crash-drill",
          message: "producer died after raw append",
          metadata: { crash_drill: true },
        },
      },
      attributes: {
        service: "crash-drill",
        privacy_tier: "internal",
      },
    });
    process.exit(42);
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: repoRoot,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return await waitForProcess(
    "raw append crash worker",
    [process.execPath, "-e", "/* raw append crash worker */"],
    child,
    20_000,
    [42],
  );
}

async function waitForProcess(
  label: string,
  command: string[],
  child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>,
  timeoutMs: number,
  allowedExitCodes = [0],
): Promise<CommandResult> {
  const started = performance.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);
  const stdoutPromise = new Response(child.stdout).text();
  const stderrPromise = new Response(child.stderr).text();
  const exitCode = await child.exited;
  clearTimeout(timer);
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  const result = {
    label,
    command,
    exit_code: exitCode,
    stdout,
    stderr,
    duration_ms: Math.max(0, Math.round(performance.now() - started)),
  };
  if (timedOut) throw new Error(`${label} timed out after ${timeoutMs}ms`);
  if (!allowedExitCodes.includes(exitCode)) {
    throw new Error(
      `${label} failed with exit ${exitCode}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
    );
  }
  return result;
}

function parseCreatedProjectId(stdout: string): string {
  const match = /Created project:\s+([^\s]+)/.exec(stdout);
  if (!match?.[1])
    throw new Error(`Unable to parse project id from: ${stdout}`);
  return match[1];
}

function parseEventJsonLines(stdout: string): EventCatalogLine[] {
  return stdout
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map((event) => ({
      event_id: typeof event.event_id === "string" ? event.event_id : null,
      event_type:
        typeof event.event_type === "string" ? event.event_type : null,
      source: typeof event.source === "string" ? event.source : null,
      message: typeof event.message === "string" ? event.message : null,
    }));
}

function parseRemoteWatchEvents(
  stdout: string,
): Array<{ event_id: string; event_type: string; message: string | null }> {
  return stdout
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .map((event) => ({
      event_id: String(event.event_id),
      event_type: String(event.event_type),
      message: typeof event.message === "string" ? event.message : null,
    }));
}

async function postEvent(
  baseUrl: string,
  token: string,
  body: unknown,
): Promise<void> {
  const response = await fetch(`${baseUrl}/api/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `POST /api/events failed ${response.status}: ${await response.text()}`,
    );
  }
}

async function getJson(url: string, token: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    throw new Error(
      `GET ${url} failed ${response.status}: ${await response.text()}`,
    );
  }
  return await response.json();
}

async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
  dataDirectory: string,
): Promise<unknown> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", "src/mcp/index.ts"],
    cwd: repoRoot,
    env: mcpChildEnv(dataDirectory),
    stderr: "pipe",
  });
  const client = new Client(
    { name: "open-logs-real-life-validation", version: "0.0.0" },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close().catch(() => {});
  }
}

function mcpChildEnv(dataDirectory: string): Record<string, string> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") childEnv[key] = value;
  }
  childEnv.HASNA_LOGS_DATA_DIR = dataDirectory;
  childEnv.HASNA_LOGS_DB_PATH = join(dataDirectory, "logs.db");
  childEnv.HASNA_LOGS_FSYNC = "0";
  return childEnv;
}

function mcpToolText(result: unknown): string {
  const content = objectValue(result)?.content;
  if (!Array.isArray(content)) return "";
  const first = content[0];
  const text = objectValue(first)?.text;
  return typeof text === "string" ? text : "";
}

function assertNoRawTestReportPayload(value: unknown, label: string): void {
  const text = JSON.stringify(value).toLowerCase();
  assert(
    !text.includes("<testsuite") &&
      !text.includes("<testcase") &&
      !text.includes("<system-out") &&
      !text.includes("<system-err") &&
      !text.includes("failure body") &&
      !text.includes("raw_xml"),
    label,
  );
}

function assertExportContainsRawEvents(
  exported: unknown[],
  expectedEventIds: string[],
): void {
  const rowsById = new Map<string, Record<string, unknown>>();
  for (const row of exported) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    if (typeof record.event_id === "string")
      rowsById.set(record.event_id, record);
  }
  for (const eventId of expectedEventIds) {
    const row = rowsById.get(eventId);
    assert(Boolean(row), `event export contains ${eventId}`);
    const raw = row?.raw;
    assert(
      Boolean(raw) && typeof raw === "object",
      `event export includes raw envelope for ${eventId}`,
    );
    assert(
      (raw as Record<string, unknown>).event_id === eventId,
      `event export raw envelope matches ${eventId}`,
    );
  }
}

function readRequiredNumber(
  source: Record<string, unknown>,
  field: string,
): number {
  const value = source[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected numeric doctor field: ${field}`);
  }
  return value;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function arrayOfObjects(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
}

function readCounts(
  dbFile: string,
  runId: string,
  rawEventRowsChecked: number,
): LabReport["counts"] {
  const db = new Database(dbFile, { readonly: true });
  try {
    const typeRows = db
      .prepare(
        "SELECT event_type, COUNT(*) AS count FROM event_records GROUP BY event_type ORDER BY event_type",
      )
      .all() as Array<{ event_type: string; count: number }>;
    return {
      event_records: countRows(db, "event_records"),
      logs: countRows(db, "logs"),
      runs: countRows(db, "runs"),
      processes: countRows(db, "processes"),
      artifacts: countRows(db, "artifacts"),
      source_maps: countRows(db, "source_maps"),
      source_map_sources: countRows(db, "source_map_sources"),
      test_reports: countRows(db, "test_reports"),
      test_cases: countRows(db, "test_cases"),
      event_segments: countRows(db, "event_segments"),
      raw_event_rows_checked: rawEventRowsChecked,
      event_types: Object.fromEntries(
        typeRows.map((row) => [row.event_type, row.count]),
      ),
      run_events: Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM event_records WHERE run_id = ?",
            )
            .get(runId) as { count: number }
        ).count,
      ),
    };
  } finally {
    db.close();
  }
}

function countRows(db: Database, table: string): number {
  return Number(
    (
      db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number;
      }
    ).count,
  );
}

function readTestReportProjection(
  dbFile: string,
  reportId: string,
): {
  event_id: string;
  run_id: string | null;
  path: string | null;
  parser: string | null;
  parse_status: string | null;
  tests: number | null;
  failures: number | null;
  errors: number | null;
  case_stored_count: number;
} | null {
  const db = new Database(dbFile, { readonly: true });
  try {
    return db
      .prepare(
        "SELECT event_id, run_id, path, parser, parse_status, tests, failures, errors, case_stored_count FROM test_reports WHERE id = ?",
      )
      .get(reportId) as {
      event_id: string;
      run_id: string | null;
      path: string | null;
      parser: string | null;
      parse_status: string | null;
      tests: number | null;
      failures: number | null;
      errors: number | null;
      case_stored_count: number;
    } | null;
  } finally {
    db.close();
  }
}

function countTestCasesForReport(dbFile: string, reportId: string): number {
  const db = new Database(dbFile, { readonly: true });
  try {
    return Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM test_cases WHERE report_id = ?",
          )
          .get(reportId) as { count: number }
      ).count,
    );
  } finally {
    db.close();
  }
}

function readEventRecord(
  dbFile: string,
  eventId: string,
): {
  event_type: string;
  source_event_id: string | null;
  metadata: string | null;
} | null {
  const db = new Database(dbFile, { readonly: true });
  try {
    return db
      .prepare(
        "SELECT event_type, source_event_id, metadata FROM event_records WHERE event_id = ?",
      )
      .get(eventId) as {
      event_type: string;
      source_event_id: string | null;
      metadata: string | null;
    } | null;
  } finally {
    db.close();
  }
}

function readLogMessage(dbFile: string, logId: string): string | null {
  const db = new Database(dbFile, { readonly: true });
  try {
    const row = db
      .prepare("SELECT message FROM logs WHERE id = ?")
      .get(logId) as { message: string | null } | null;
    return row?.message ?? null;
  } finally {
    db.close();
  }
}

function readArtifactRow(
  dbFile: string,
  artifactId: string,
): {
  path: string | null;
  content_hash: string | null;
} | null {
  const db = new Database(dbFile, { readonly: true });
  try {
    return db
      .prepare("SELECT path, content_hash FROM artifacts WHERE id = ?")
      .get(artifactId) as {
      path: string | null;
      content_hash: string | null;
    } | null;
  } finally {
    db.close();
  }
}

function readSourceMapProjection(
  dbFile: string,
  sourceMapId: string,
): {
  javascript_path: string | null;
  validation_status: string | null;
  source_count: number | null;
  has_sources_content: number | null;
  metadata: string | null;
} | null {
  const db = new Database(dbFile, { readonly: true });
  try {
    return db
      .prepare(
        `
          SELECT
            javascript_path, validation_status, source_count,
            has_sources_content, metadata
          FROM source_maps
          WHERE id = ?
        `,
      )
      .get(sourceMapId) as {
      javascript_path: string | null;
      validation_status: string | null;
      source_count: number | null;
      has_sources_content: number | null;
      metadata: string | null;
    } | null;
  } finally {
    db.close();
  }
}

function readSourceMapSources(
  dbFile: string,
  sourceMapId: string,
): Array<{
  source_path: string | null;
  has_content: number | null;
  content_hash: string | null;
}> {
  const db = new Database(dbFile, { readonly: true });
  try {
    return db
      .prepare(
        `
          SELECT source_path, has_content, content_hash
          FROM source_map_sources
          WHERE source_map_id = ?
          ORDER BY ordinal
        `,
      )
      .all(sourceMapId) as Array<{
      source_path: string | null;
      has_content: number | null;
      content_hash: string | null;
    }>;
  } finally {
    db.close();
  }
}

function eventExists(dbFile: string, eventId: string): boolean {
  const db = new Database(dbFile, { readonly: true });
  try {
    const row = db
      .prepare("SELECT event_id FROM event_records WHERE event_id = ?")
      .get(eventId);
    return Boolean(row);
  } finally {
    db.close();
  }
}

async function stopServer(
  child: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>,
): Promise<void> {
  child.kill("SIGTERM");
  const result = await Promise.race([
    child.exited.then(() => "exited" as const),
    sleep(2_000).then(() => "timeout" as const),
  ]);
  if (result === "timeout") {
    child.kill("SIGKILL");
    await child.exited.catch(() => {});
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  assertions.push(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
