import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  type Dirent,
  type Stats,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { LogLevel, LogSource } from "../types/index.ts";
import { publishEventCatalogEvent } from "./event-bus.ts";
import {
  type TelemetryEnvelope,
  appendRawEvent,
  indexRawEvent,
  withEventStoreLock,
} from "./event-store.ts";
import { getEvent } from "./events.ts";
import { detectRuntimeIdentity } from "./identity.ts";
import { ingestLog } from "./ingest.ts";
import {
  type RedactionReport,
  mergeRedactionReports,
  redactString,
  redactValue,
  redactionMetadata,
} from "./redaction.ts";
import {
  sanitizeSourceMapPathValue,
  upsertSourceMapProjection,
} from "./source-map-projections.ts";
import { upsertTestReportProjection } from "./test-report-projections.ts";

export interface CommandRunOptions {
  cwd?: string;
  project_id?: string;
  service?: string;
  environment?: string;
  tee?: boolean;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export interface CommandRunResult {
  run_id: string;
  process_id: string;
  command: string[];
  cwd: string;
  run_type: CommandRunType;
  tool: string;
  package_manager: string | null;
  framework: string | null;
  pid: number | null;
  exit_code: number;
  signal: string | null;
  status: "completed" | "failed";
  started_at: string;
  ended_at: string;
  duration_ms: number;
  stdout_lines: number;
  stderr_lines: number;
  stdout_chunks: number;
  stderr_chunks: number;
  stdout_bytes: number;
  stderr_bytes: number;
  summary: CommandRunOutputSummary;
  resource_usage: CommandRunResourceSummary;
  process_tree: CommandRunProcessTreeSummary;
  artifacts: CommandRunArtifactSummary;
  test_reports: CommandRunTestReportSummary;
}

type StreamName = "stdout" | "stderr";
export type CommandRunType = "test" | "build" | "dev-server" | "command";

export interface CommandRunClassifier {
  run_type: CommandRunType;
  tool: string;
  package_manager: string | null;
  framework: string | null;
  script: string | null;
}

export interface CommandRunOutputSummary {
  chunk_count: number;
  byte_count: number;
  line_count: number;
  error_lines: number;
  warning_lines: number;
  compiler_error_lines: number;
  test_failure_lines: number;
  test_success_lines: number;
  server_ready_lines: number;
  uncaught_exception_lines: number;
  categories: Record<string, number>;
  detected_urls: string[];
  detected_ports: number[];
  diagnostic_codes: string[];
  first_error: string | null;
  first_warning: string | null;
}

export interface CommandRunResourceSummary {
  sampler: "linux-procfs" | "unsupported";
  available: boolean;
  sample_count: number;
  first_observed_at: string | null;
  last_observed_at: string | null;
  rss_bytes_last: number | null;
  rss_bytes_peak: number | null;
  vms_bytes_last: number | null;
  vms_bytes_peak: number | null;
  threads_last: number | null;
  threads_peak: number | null;
  cpu_user_ticks_last: number | null;
  cpu_system_ticks_last: number | null;
  cpu_total_ticks_last: number | null;
}

export interface CommandRunProcessTreeNode {
  pid: number;
  ppid: number;
  depth: number;
  name: string | null;
  state: string | null;
}

export interface CommandRunProcessTreeSummary {
  sampler: "linux-procfs" | "unsupported";
  available: boolean;
  sample_count: number;
  root_pid: number | null;
  first_observed_at: string | null;
  last_observed_at: string | null;
  descendant_count_last: number;
  descendant_count_peak: number;
  direct_child_count_last: number;
  direct_child_count_peak: number;
  max_depth_peak: number;
  observed_pid_count: number;
  observed_pids: number[];
  last_tree: CommandRunProcessTreeNode[];
  peak_tree: CommandRunProcessTreeNode[];
  truncated: boolean;
}

export interface CommandRunArtifactInfo {
  artifact_id: string;
  path: string;
  artifact_type: string;
  size_bytes: number;
  content_hash: string | null;
  changed: "created" | "modified";
  mtime_ms: number;
  source_map?: CommandRunSourceMapInfo;
}

export interface CommandRunSourceMapSource {
  ordinal: number;
  source_path: string | null;
  has_content: boolean;
  content_hash: string | null;
}

export interface CommandRunSourceMapInfo {
  source_map_id: string;
  source_map_artifact_id: string;
  source_map_path: string;
  javascript_artifact_id: string | null;
  javascript_path: string | null;
  linked_by: "adjacent_path" | "file_field" | "none";
  version: number | null;
  validation_status: "parsed" | "malformed" | "too_large" | "unsupported";
  validation_error: string | null;
  file: string | null;
  source_root: string | null;
  source_count: number;
  names_count: number;
  mappings_length: number;
  has_sources_content: boolean;
  sources: CommandRunSourceMapSource[];
  truncated: boolean;
  source_storage_policy: "paths_and_hashes_only";
}

export interface CommandRunArtifactSummary {
  scanner: "common-output-roots";
  available: boolean;
  scanned_roots: string[];
  discovered_count: number;
  emitted_count: number;
  truncated: boolean;
  artifacts: CommandRunArtifactInfo[];
}

export interface CommandRunTestCaseSummary {
  name: string | null;
  classname: string | null;
  file: string | null;
  status: "passed" | "failed" | "error" | "skipped";
  time_seconds: number | null;
}

export interface CommandRunTestSuiteSummary {
  name: string | null;
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  time_seconds: number | null;
  testcase_count: number;
  cases: CommandRunTestCaseSummary[];
  truncated: boolean;
}

export interface CommandRunTestReportInfo {
  report_id: string;
  path: string;
  format: "junit_xml";
  parser: "junit-xml-v1";
  parse_status: "parsed" | "malformed" | "unsafe" | "too_large" | "unsupported";
  parse_error: string | null;
  size_bytes: number;
  content_hash: string | null;
  changed: "created" | "modified";
  mtime_ms: number;
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  time_seconds: number | null;
  suite_count: number;
  testcase_count: number;
  suites: CommandRunTestSuiteSummary[];
  truncated: boolean;
}

export interface CommandRunTestReportSummary {
  scanner: "common-test-report-roots";
  available: boolean;
  scanned_roots: string[];
  discovered_count: number;
  emitted_count: number;
  truncated: boolean;
  reports: CommandRunTestReportInfo[];
}

interface SharedSequence {
  value: number;
}

type LineCategory =
  | "output"
  | "warning"
  | "error"
  | "compiler_diagnostic"
  | "test_failure"
  | "test_success"
  | "server_ready"
  | "exception";

interface ProcessLineInsight {
  category: LineCategory;
  severity: LogLevel;
  urls: string[];
  ports: number[];
  diagnostic_codes: string[];
}

const MAX_SUMMARY_VALUES = 20;
const MAX_SUMMARY_SNIPPET = 500;
const MAX_PROCESS_TREE_NODES = 256;
const MAX_ARTIFACT_FILES = 64;
const MAX_ARTIFACT_HASH_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_MAP_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_MAP_SOURCES = 200;
const MAX_TEST_REPORT_FILES = 32;
const MAX_TEST_REPORT_BYTES = 1024 * 1024;
const MAX_TEST_REPORT_SUITES = 20;
const MAX_TEST_REPORT_CASES = 50;
const MAX_TEST_REPORT_NODES = 5000;
const MAX_TEST_REPORT_SCAN_DEPTH = 6;
const MAX_TEST_REPORT_STRING = 240;
const ARTIFACT_ROOTS = ["dist", "build", "out", ".next", ".nuxt", "coverage"];
const TEST_REPORT_ROOTS = [
  "test-results",
  "reports",
  "junit",
  "coverage",
  ".test-results",
  "target/surefire-reports",
  "target/failsafe-reports",
  "build/test-results",
  "build/reports/tests",
  "playwright-report",
];
const TEST_REPORT_ROOT_FILES = [
  "junit.xml",
  "junit-report.xml",
  "test-results.xml",
  "test-report.xml",
  "results.xml",
];

export async function runCommand(
  db: Database,
  command: string[],
  opts: CommandRunOptions = {},
): Promise<CommandRunResult> {
  if (command.length === 0) {
    throw new Error("No command provided. Use: logs run -- <cmd> [...args]");
  }

  const cwd = resolve(opts.cwd ?? process.cwd());
  const startedAt = new Date().toISOString();
  const monotonicStart = performance.now();
  const processId = `proc_${randomId()}`;
  const runId = `run_${randomId()}`;
  const classifier = classifyCommand(command);
  const commandLine = command.join(" ");
  const projectId = existingProjectId(db, opts.project_id);
  const identity = detectRuntimeIdentity(db, cwd, {
    project_id: projectId,
    environment: opts.environment,
  });
  const service = opts.service ?? defaultServiceName(command, classifier);
  const artifactBaseline = snapshotBuildArtifacts(cwd);
  const testReportBaseline = snapshotTestReports(cwd);

  const child = Bun.spawn(command, {
    cwd,
    env: opts.env ?? process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const pid = child.pid ?? null;
  const resourceSampler = startProcessResourceSampler(pid);
  const processTreeSampler = startProcessTreeSampler(pid);
  const abortForwarder = installAbortForwarder(child, opts.signal);
  const observedSequence: SharedSequence = { value: 0 };

  insertProcessAndRun(db, {
    process_id: processId,
    run_id: runId,
    machine_id: identity.machine_id,
    repo_id: identity.repo_id,
    app_id: identity.app_id,
    pid,
    ppid: process.ppid,
    command,
    cwd,
    started_at: startedAt,
    environment: identity.environment,
    project_id: projectId,
    classifier,
  });

  recordProcessEvent(db, {
    event_id: `evt_${randomId()}`,
    event_time: startedAt,
    phase: "start",
    severity: "info",
    message: `Process started: ${commandLine}`,
    process_id: processId,
    run_id: runId,
    machine_id: identity.machine_id,
    repo_id: identity.repo_id,
    app_id: identity.app_id,
    environment: identity.environment,
    body: {
      process: {
        id: processId,
        run_id: runId,
        pid,
        ppid: process.ppid,
        command,
        cwd,
        started_at: startedAt,
        run_type: classifier.run_type,
        tool: classifier.tool,
        package_manager: classifier.package_manager,
        framework: classifier.framework,
      },
    },
    metadata: {
      command,
      cwd,
      pid,
      ppid: process.ppid,
      phase: "start",
      run_type: classifier.run_type,
      tool: classifier.tool,
      package_manager: classifier.package_manager,
      framework: classifier.framework,
      script: classifier.script,
    },
  });

  const stdoutPromise = consumeProcessStream(db, child.stdout, "stdout", {
    run_id: runId,
    process_id: processId,
    command,
    cwd,
    pid,
    project_id: projectId,
    service,
    machine_id: identity.machine_id,
    repo_id: identity.repo_id,
    app_id: identity.app_id,
    environment: identity.environment,
    classifier,
    observed_sequence: observedSequence,
    tee: opts.tee === true,
  });
  const stderrPromise = consumeProcessStream(db, child.stderr, "stderr", {
    run_id: runId,
    process_id: processId,
    command,
    cwd,
    pid,
    project_id: projectId,
    service,
    machine_id: identity.machine_id,
    repo_id: identity.repo_id,
    app_id: identity.app_id,
    environment: identity.environment,
    classifier,
    observed_sequence: observedSequence,
    tee: opts.tee === true,
  });

  let exitCode: number;
  try {
    exitCode = await child.exited;
  } finally {
    abortForwarder.cleanup();
  }
  const resourceUsage = resourceSampler.stop();
  const processTree = processTreeSampler.stop();
  const artifactSummary = discoverChangedArtifacts(
    cwd,
    artifactBaseline,
    runId,
  );
  const safeArtifactSummary = redactValue(artifactSummary, "artifacts")
    .value as CommandRunArtifactSummary;
  const testReportSummary = discoverChangedTestReports(
    cwd,
    testReportBaseline,
    runId,
    classifier.run_type,
  );
  const safeTestReportSummary = redactValue(testReportSummary, "test_reports")
    .value as CommandRunTestReportSummary;
  const [stdoutSummary, stderrSummary] = await Promise.all([
    stdoutPromise,
    stderrPromise,
  ]);
  const outputSummary = mergeOutputSummaries(stdoutSummary, stderrSummary);
  const stdoutLines = stdoutSummary.line_count;
  const stderrLines = stderrSummary.line_count;
  const stdoutChunks = stdoutSummary.chunk_count;
  const stderrChunks = stderrSummary.chunk_count;
  const stdoutBytes = stdoutSummary.byte_count;
  const stderrBytes = stderrSummary.byte_count;
  const endedAt = new Date().toISOString();
  const durationMs = Math.max(
    0,
    Math.round(performance.now() - monotonicStart),
  );
  const signal = readSignalCode(child) ?? abortForwarder.getSignal();
  const status = exitCode === 0 && !signal ? "completed" : "failed";

  updateProcessAndRun(db, {
    process_id: processId,
    run_id: runId,
    ended_at: endedAt,
    exit_code: exitCode,
    signal,
    status,
    duration_ms: durationMs,
    stdout_lines: stdoutLines,
    stderr_lines: stderrLines,
    stdout_chunks: stdoutChunks,
    stderr_chunks: stderrChunks,
    stdout_bytes: stdoutBytes,
    stderr_bytes: stderrBytes,
    command,
    cwd,
    environment: identity.environment,
    project_id: projectId,
    classifier,
    summary: outputSummary,
    resource_usage: resourceUsage,
    process_tree: processTree,
    artifacts: safeArtifactSummary,
    test_reports: safeTestReportSummary,
  });

  recordProcessEvent(db, {
    event_id: `evt_${randomId()}`,
    event_time: endedAt,
    phase: "exit",
    severity: status === "completed" ? "info" : "error",
    message: `Process exited ${exitCode}: ${commandLine}`,
    process_id: processId,
    run_id: runId,
    machine_id: identity.machine_id,
    repo_id: identity.repo_id,
    app_id: identity.app_id,
    environment: identity.environment,
    body: {
      process: {
        id: processId,
        run_id: runId,
        pid,
        command,
        cwd,
        started_at: startedAt,
        ended_at: endedAt,
        exit_code: exitCode,
        signal,
        status,
        duration_ms: durationMs,
        stdout_lines: stdoutLines,
        stderr_lines: stderrLines,
        stdout_chunks: stdoutChunks,
        stderr_chunks: stderrChunks,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        run_type: classifier.run_type,
        tool: classifier.tool,
        package_manager: classifier.package_manager,
        framework: classifier.framework,
        summary: outputSummary,
        resource_usage: resourceUsage,
        process_tree: processTree,
        artifacts: safeArtifactSummary,
        test_reports: safeTestReportSummary,
      },
    },
    metadata: {
      command,
      cwd,
      pid,
      phase: "exit",
      exit_code: exitCode,
      signal,
      status,
      duration_ms: durationMs,
      stdout_lines: stdoutLines,
      stderr_lines: stderrLines,
      stdout_chunks: stdoutChunks,
      stderr_chunks: stderrChunks,
      stdout_bytes: stdoutBytes,
      stderr_bytes: stderrBytes,
      run_type: classifier.run_type,
      tool: classifier.tool,
      package_manager: classifier.package_manager,
      framework: classifier.framework,
      script: classifier.script,
      summary: outputSummary,
      resource_usage: resourceUsage,
      process_tree: processTree,
      artifacts: safeArtifactSummary,
      test_reports: safeTestReportSummary,
    },
  });

  recordProcessResourceMetricEvent(db, {
    event_time: endedAt,
    run_id: runId,
    process_id: processId,
    machine_id: identity.machine_id,
    repo_id: identity.repo_id,
    app_id: identity.app_id,
    environment: identity.environment,
    project_id: projectId,
    classifier,
    pid,
    resource_usage: resourceUsage,
  });

  recordProcessTreeEvent(db, {
    event_time: endedAt,
    run_id: runId,
    process_id: processId,
    machine_id: identity.machine_id,
    repo_id: identity.repo_id,
    app_id: identity.app_id,
    environment: identity.environment,
    project_id: projectId,
    classifier,
    pid,
    process_tree: processTree,
  });

  recordArtifactEvents(db, {
    event_time: endedAt,
    run_id: runId,
    process_id: processId,
    machine_id: identity.machine_id,
    repo_id: identity.repo_id,
    app_id: identity.app_id,
    environment: identity.environment,
    project_id: projectId,
    classifier,
    artifacts: artifactSummary,
  });

  recordTestReportEvents(db, {
    event_time: endedAt,
    run_id: runId,
    process_id: processId,
    machine_id: identity.machine_id,
    repo_id: identity.repo_id,
    app_id: identity.app_id,
    environment: identity.environment,
    project_id: projectId,
    classifier,
    test_reports: testReportSummary,
  });

  recordLifecycleSummaryEvent(db, {
    run_id: runId,
    process_id: processId,
    machine_id: identity.machine_id,
    repo_id: identity.repo_id,
    app_id: identity.app_id,
    environment: identity.environment,
    project_id: projectId,
    classifier,
    command,
    cwd,
    pid,
    started_at: startedAt,
    ended_at: endedAt,
    exit_code: exitCode,
    signal,
    status,
    duration_ms: durationMs,
    stdout_lines: stdoutLines,
    stderr_lines: stderrLines,
    stdout_chunks: stdoutChunks,
    stderr_chunks: stderrChunks,
    stdout_bytes: stdoutBytes,
    stderr_bytes: stderrBytes,
    summary: outputSummary,
    resource_usage: resourceUsage,
    process_tree: processTree,
    artifacts: safeArtifactSummary,
    test_reports: safeTestReportSummary,
  });

  const safeResultCommand = redactValue(command, "command").value as string[];
  const safeResultCwd = redactString(cwd, "cwd").value;

  return {
    run_id: runId,
    process_id: processId,
    command: safeResultCommand,
    cwd: safeResultCwd,
    run_type: classifier.run_type,
    tool: classifier.tool,
    package_manager: classifier.package_manager,
    framework: classifier.framework,
    pid,
    exit_code: exitCode,
    signal,
    status,
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms: durationMs,
    stdout_lines: stdoutLines,
    stderr_lines: stderrLines,
    stdout_chunks: stdoutChunks,
    stderr_chunks: stderrChunks,
    stdout_bytes: stdoutBytes,
    stderr_bytes: stderrBytes,
    summary: outputSummary,
    resource_usage: resourceUsage,
    process_tree: processTree,
    artifacts: safeArtifactSummary,
    test_reports: safeTestReportSummary,
  };
}

function insertProcessAndRun(
  db: Database,
  data: {
    process_id: string;
    run_id: string;
    machine_id: string;
    repo_id: string | null;
    app_id: string | null;
    pid: number | null;
    ppid: number;
    command: string[];
    cwd: string;
    started_at: string;
    environment: string;
    project_id: string | null;
    classifier: CommandRunClassifier;
  },
): void {
  const commandResult = redactValue(data.command, "command");
  const cwdResult = redactString(data.cwd, "cwd");
  const report = mergeRedactionReports(commandResult.report, cwdResult.report);
  const safeCommand = commandResult.value as string[];
  const safeCwd = cwdResult.value;
  const classifierMetadata = classifierMetadataObject(data.classifier);
  const processMetadata: Record<string, unknown> = {
    command: safeCommand,
    environment: data.environment,
    project_id: data.project_id,
    ...classifierMetadata,
  };
  const runMetadata: Record<string, unknown> = {
    command: safeCommand,
    cwd: safeCwd,
    environment: data.environment,
    project_id: data.project_id,
    ...classifierMetadata,
  };
  if (report.applied) {
    processMetadata.redaction = redactionMetadata(report);
    runMetadata.redaction = redactionMetadata(report);
  }

  db.transaction(() => {
    db.prepare(`
      INSERT INTO processes (id, machine_id, repo_id, app_id, pid, ppid, command, cwd, started_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.process_id,
      data.machine_id,
      data.repo_id,
      data.app_id,
      data.pid,
      data.ppid,
      safeCommand.join(" "),
      safeCwd,
      data.started_at,
      JSON.stringify(processMetadata),
    );

    db.prepare(`
      INSERT INTO runs (id, process_id, run_type, name, status, started_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.run_id,
      data.process_id,
      data.classifier.run_type,
      safeCommand.join(" "),
      "running",
      data.started_at,
      JSON.stringify(runMetadata),
    );
  })();
}

function updateProcessAndRun(
  db: Database,
  data: {
    process_id: string;
    run_id: string;
    ended_at: string;
    exit_code: number;
    signal: string | null;
    status: "completed" | "failed";
    duration_ms: number;
    stdout_lines: number;
    stderr_lines: number;
    command: string[];
    cwd: string;
    environment: string;
    project_id: string | null;
    classifier: CommandRunClassifier;
    summary: CommandRunOutputSummary;
    resource_usage: CommandRunResourceSummary;
    process_tree: CommandRunProcessTreeSummary;
    artifacts: CommandRunArtifactSummary;
    test_reports: CommandRunTestReportSummary;
    stdout_chunks: number;
    stderr_chunks: number;
    stdout_bytes: number;
    stderr_bytes: number;
  },
): void {
  const commandResult = redactValue(data.command, "command");
  const cwdResult = redactString(data.cwd, "cwd");
  const summaryResult = redactValue(data.summary, "summary");
  const artifactResult = redactValue(data.artifacts, "artifacts");
  const testReportResult = redactValue(data.test_reports, "test_reports");
  const report = mergeRedactionReports(
    commandResult.report,
    cwdResult.report,
    summaryResult.report,
    artifactResult.report,
    testReportResult.report,
  );
  const safeCommand = commandResult.value as string[];
  const metadataObject: Record<string, unknown> = {
    command: safeCommand,
    cwd: cwdResult.value,
    environment: data.environment,
    project_id: data.project_id,
    ...classifierMetadataObject(data.classifier),
    signal: data.signal,
    duration_ms: data.duration_ms,
    stdout_lines: data.stdout_lines,
    stderr_lines: data.stderr_lines,
    stdout_chunks: data.stdout_chunks,
    stderr_chunks: data.stderr_chunks,
    stdout_bytes: data.stdout_bytes,
    stderr_bytes: data.stderr_bytes,
    summary: summaryResult.value,
    resource_usage: data.resource_usage,
    process_tree: data.process_tree,
    artifacts: artifactResult.value,
    test_reports: testReportResult.value,
  };
  if (report.applied) {
    metadataObject.redaction = redactionMetadata(report);
  }
  const metadata = JSON.stringify(metadataObject);

  db.transaction(() => {
    db.prepare(
      "UPDATE processes SET ended_at = ?, exit_code = ?, metadata = ? WHERE id = ?",
    ).run(data.ended_at, data.exit_code, metadata, data.process_id);
    db.prepare(
      "UPDATE runs SET ended_at = ?, exit_code = ?, status = ?, metadata = ? WHERE id = ?",
    ).run(data.ended_at, data.exit_code, data.status, metadata, data.run_id);
  })();
}

async function consumeProcessStream(
  db: Database,
  stream: ReadableStream<Uint8Array> | null,
  streamName: StreamName,
  context: {
    run_id: string;
    process_id: string;
    command: string[];
    cwd: string;
    pid: number | null;
    project_id: string | null;
    service: string;
    machine_id: string;
    repo_id: string | null;
    app_id: string | null;
    environment: string;
    classifier: CommandRunClassifier;
    observed_sequence: SharedSequence;
    tee: boolean;
  },
): Promise<CommandRunOutputSummary> {
  const summary = emptyOutputSummary();
  if (!stream) return summary;

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunkRecorder = createStreamChunkRecorder(db, streamName, context);
  let buffered = "";
  let lineNumber = 0;

  const emitLine = (line: string) => {
    lineNumber += 1;
    const message = line.replace(/\r$/, "");
    const insight = inspectProcessLine(message, streamName);
    addLineToSummary(summary, message, insight);
    ingestLog(db, {
      id: `${context.run_id}-${streamName}-${lineNumber}`,
      timestamp: new Date().toISOString(),
      level: insight.severity,
      source: sourceForRunType(context.classifier.run_type),
      service: context.service,
      project_id: context.project_id ?? undefined,
      message,
      privacy: "internal",
      machine_id: context.machine_id,
      repo_id: context.repo_id ?? undefined,
      app_id: context.app_id ?? undefined,
      process_id: context.process_id,
      run_id: context.run_id,
      environment: context.environment,
      metadata: {
        event_type: "process_stream",
        stream: streamName,
        line_number: lineNumber,
        command: context.command,
        cwd: context.cwd,
        pid: context.pid,
        run_type: context.classifier.run_type,
        tool: context.classifier.tool,
        package_manager: context.classifier.package_manager,
        framework: context.classifier.framework,
        script: context.classifier.script,
        line_category: insight.category,
        line_severity: insight.severity,
        detected_urls: insight.urls,
        detected_ports: insight.ports,
        diagnostic_codes: insight.diagnostic_codes,
      },
    });
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    summary.byte_count += value.byteLength;
    const text = decoder.decode(value, { stream: true });
    if (context.tee) writeChildBytes(streamName, value);
    summary.chunk_count += chunkRecorder.push(value);
    buffered += text;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) emitLine(line);
  }

  const tail = decoder.decode();
  if (tail) {
    buffered += tail;
  }
  if (buffered.length > 0) emitLine(buffered);
  summary.chunk_count += chunkRecorder.flush();

  return summary;
}

function createStreamChunkRecorder(
  db: Database,
  streamName: StreamName,
  context: {
    run_id: string;
    process_id: string;
    command: string[];
    cwd: string;
    pid: number | null;
    project_id: string | null;
    service: string;
    machine_id: string;
    repo_id: string | null;
    app_id: string | null;
    environment: string;
    classifier: CommandRunClassifier;
    observed_sequence: SharedSequence;
  },
): { push: (bytes: Uint8Array) => number; flush: () => number } {
  let pending: number[] = [];
  let chunkSequence = 0;

  const emit = (bytes: Uint8Array): void => {
    if (bytes.byteLength === 0) return;
    chunkSequence += 1;
    const observedSequence = ++context.observed_sequence.value;
    recordProcessStreamChunk(db, {
      event_id: `${context.run_id}-${streamName}-chunk-${chunkSequence}`,
      event_time: new Date().toISOString(),
      stream: streamName,
      chunk_sequence: chunkSequence,
      observed_sequence: observedSequence,
      bytes,
      context,
    });
  };

  return {
    push: (bytes: Uint8Array) => {
      let emitted = 0;
      for (const byte of bytes) {
        pending.push(byte);
        if (byte === 10) {
          emit(Uint8Array.from(pending));
          pending = [];
          emitted += 1;
        }
      }
      return emitted;
    },
    flush: () => {
      if (pending.length === 0) return 0;
      emit(Uint8Array.from(pending));
      pending = [];
      return 1;
    },
  };
}

function recordProcessStreamChunk(
  db: Database,
  event: {
    event_id: string;
    event_time: string;
    stream: StreamName;
    chunk_sequence: number;
    observed_sequence: number;
    bytes: Uint8Array;
    context: {
      run_id: string;
      process_id: string;
      command: string[];
      cwd: string;
      pid: number | null;
      project_id: string | null;
      service: string;
      machine_id: string;
      repo_id: string | null;
      app_id: string | null;
      environment: string;
      classifier: CommandRunClassifier;
    };
  },
): void {
  const prepared = prepareChunkBytes(event.bytes);
  const source = sourceForRunType(event.context.classifier.run_type);
  const severity: LogLevel = event.stream === "stderr" ? "error" : "info";
  const ingestTime = new Date().toISOString();
  const message = `Process ${event.stream} chunk ${event.chunk_sequence}`;
  const chunkRedaction = prepared.redaction.applied
    ? redactionMetadata(prepared.redaction)
    : null;
  const body = {
    process_stream_chunk: {
      stream: event.stream,
      chunk_sequence: event.chunk_sequence,
      observed_sequence: event.observed_sequence,
      encoding: "base64",
      data_base64: prepared.data_base64,
      original_byte_length: prepared.original_byte_length,
      stored_byte_length: prepared.stored_byte_length,
      stored_sha256: prepared.stored_sha256,
      contains_invalid_utf8: prepared.contains_invalid_utf8,
      ends_with_newline: event.bytes.at(-1) === 10,
      ends_with_carriage_return: event.bytes.at(-1) === 13,
      text_preview: prepared.text_preview,
      redaction: chunkRedaction,
    },
  };
  const metadata = {
    category: "process_stream_chunk",
    event_type: "process_stream_chunk",
    stream: event.stream,
    chunk_sequence: event.chunk_sequence,
    observed_sequence: event.observed_sequence,
    original_byte_length: prepared.original_byte_length,
    stored_byte_length: prepared.stored_byte_length,
    stored_sha256: prepared.stored_sha256,
    contains_invalid_utf8: prepared.contains_invalid_utf8,
    ends_with_newline: event.bytes.at(-1) === 10,
    ends_with_carriage_return: event.bytes.at(-1) === 13,
    command: event.context.command,
    cwd: event.context.cwd,
    pid: event.context.pid,
    run_type: event.context.classifier.run_type,
    tool: event.context.classifier.tool,
    package_manager: event.context.classifier.package_manager,
    framework: event.context.classifier.framework,
    script: event.context.classifier.script,
    redaction: chunkRedaction,
  };
  const messageResult = redactString(message, "message");
  const bodyResult = redactValue(body, "body");
  const metadataResult = redactValue(metadata, "metadata");
  const redaction = mergeRedactionReports(
    prepared.redaction,
    messageResult.report,
    bodyResult.report,
    metadataResult.report,
  );
  const safeMetadata = metadataResult.value as Record<string, unknown>;
  if (redaction.applied) safeMetadata.redaction = redactionMetadata(redaction);

  const envelope: TelemetryEnvelope = {
    schema_version: 1,
    event_id: event.event_id,
    source_event_id: `${event.context.run_id}:${event.stream}:chunk:${event.chunk_sequence}`,
    event_time: event.event_time,
    ingest_time: ingestTime,
    type: "process",
    source,
    severity,
    privacy: "internal",
    machine_id: event.context.machine_id,
    repo_id: event.context.repo_id,
    app_id: event.context.app_id,
    process_id: event.context.process_id,
    run_id: event.context.run_id,
    environment: event.context.environment,
    message: messageResult.value,
    body: bodyResult.value as Record<string, unknown>,
    attributes: {
      category: "process_stream_chunk",
      stream: event.stream,
      chunk_sequence: event.chunk_sequence,
      observed_sequence: event.observed_sequence,
      machine_id: event.context.machine_id,
      repo_id: event.context.repo_id,
      app_id: event.context.app_id,
      process_id: event.context.process_id,
      run_id: event.context.run_id,
      environment: event.context.environment,
      run_type: event.context.classifier.run_type,
      tool: event.context.classifier.tool,
      package_manager: event.context.classifier.package_manager,
      framework: event.context.classifier.framework,
    },
  };
  const catalogEvent = withEventStoreLock(db, () => {
    const write = appendRawEvent(db, envelope);
    indexRawEvent(
      db,
      {
        event_id: event.event_id,
        schema_version: envelope.schema_version,
        source_event_id: envelope.source_event_id,
        event_type: envelope.type,
        event_time: envelope.event_time,
        ingest_time: envelope.ingest_time,
        severity: envelope.severity,
        source: envelope.source,
        project_id: event.context.project_id,
        machine_id: event.context.machine_id,
        repo_id: event.context.repo_id,
        app_id: event.context.app_id,
        process_id: event.context.process_id,
        run_id: event.context.run_id,
        environment: event.context.environment,
        privacy_tier: "internal",
        message: messageResult.value,
        metadata: safeMetadata,
      },
      write,
    );
    return getEvent(db, event.event_id, false);
  });
  if (catalogEvent) publishEventCatalogEvent(catalogEvent);
}

function recordProcessEvent(
  db: Database,
  event: {
    event_id: string;
    event_time: string;
    phase: "start" | "exit";
    severity: "info" | "error";
    message: string;
    process_id: string;
    run_id: string;
    machine_id: string;
    repo_id: string | null;
    app_id: string | null;
    environment: string;
    body: Record<string, unknown>;
    metadata: Record<string, unknown>;
  },
): void {
  const ingestTime = new Date().toISOString();
  const messageResult = redactString(event.message, "message");
  const bodyResult = redactValue(event.body, "body");
  const metadataResult = redactValue(event.metadata, "metadata");
  const redaction = mergeRedactionReports(
    messageResult.report,
    bodyResult.report,
    metadataResult.report,
  );
  const safeMetadata = metadataResult.value as Record<string, unknown>;
  if (redaction.applied) {
    safeMetadata.redaction = redactionMetadata(redaction);
  }

  const envelope: TelemetryEnvelope = {
    schema_version: 1,
    event_id: event.event_id,
    source_event_id: `${event.run_id}:process:${event.phase}`,
    event_time: event.event_time,
    ingest_time: ingestTime,
    type: "process",
    source: "cli",
    severity: event.severity,
    privacy: "internal",
    machine_id: event.machine_id,
    repo_id: event.repo_id,
    app_id: event.app_id,
    process_id: event.process_id,
    run_id: event.run_id,
    environment: event.environment,
    message: messageResult.value,
    body: bodyResult.value as Record<string, unknown>,
    attributes: {
      machine_id: event.machine_id,
      repo_id: event.repo_id,
      app_id: event.app_id,
      process_id: event.process_id,
      run_id: event.run_id,
      environment: event.environment,
      phase: event.phase,
    },
  };
  const catalogEvent = withEventStoreLock(db, () => {
    const write = appendRawEvent(db, envelope);
    indexRawEvent(
      db,
      {
        event_id: event.event_id,
        schema_version: envelope.schema_version,
        source_event_id: envelope.source_event_id,
        event_type: envelope.type,
        event_time: envelope.event_time,
        ingest_time: envelope.ingest_time,
        severity: envelope.severity,
        source: envelope.source,
        machine_id: event.machine_id,
        repo_id: event.repo_id,
        app_id: event.app_id,
        process_id: event.process_id,
        run_id: event.run_id,
        environment: event.environment,
        privacy_tier: "internal",
        message: messageResult.value,
        metadata: safeMetadata,
      },
      write,
    );
    return getEvent(db, event.event_id, false);
  });
  if (catalogEvent) publishEventCatalogEvent(catalogEvent);
}

function recordProcessResourceMetricEvent(
  db: Database,
  data: {
    event_time: string;
    run_id: string;
    process_id: string;
    machine_id: string;
    repo_id: string | null;
    app_id: string | null;
    environment: string;
    project_id: string | null;
    classifier: CommandRunClassifier;
    pid: number | null;
    resource_usage: CommandRunResourceSummary;
  },
): void {
  const eventId = `${data.run_id}-resource`;
  const ingestTime = new Date().toISOString();
  const source = sourceForRunType(data.classifier.run_type);
  const metricValue =
    data.resource_usage.rss_bytes_peak ?? data.resource_usage.rss_bytes_last;
  const metricUnit = "bytes";
  const body = {
    name: "process.resource.peak_rss",
    value: metricValue,
    kind: "gauge",
    unit: metricUnit,
    process_resource: {
      pid: data.pid,
      ...data.resource_usage,
    },
  };
  const metadata = {
    category: "process_resource_usage",
    metric_name: "process.resource.peak_rss",
    metric_kind: "gauge",
    metric_unit: metricUnit,
    pid: data.pid,
    run_type: data.classifier.run_type,
    tool: data.classifier.tool,
    package_manager: data.classifier.package_manager,
    framework: data.classifier.framework,
    script: data.classifier.script,
    sampler: data.resource_usage.sampler,
    resource_available: data.resource_usage.available,
    sample_count: data.resource_usage.sample_count,
    rss_bytes_peak: data.resource_usage.rss_bytes_peak,
    rss_bytes_last: data.resource_usage.rss_bytes_last,
    vms_bytes_peak: data.resource_usage.vms_bytes_peak,
    vms_bytes_last: data.resource_usage.vms_bytes_last,
    threads_peak: data.resource_usage.threads_peak,
    threads_last: data.resource_usage.threads_last,
    cpu_total_ticks_last: data.resource_usage.cpu_total_ticks_last,
  };
  const messageResult = redactString(
    "Process resource usage summary",
    "message",
  );
  const bodyResult = redactValue(body, "body");
  const metadataResult = redactValue(metadata, "metadata");
  const redaction = mergeRedactionReports(
    messageResult.report,
    bodyResult.report,
    metadataResult.report,
  );
  const safeMetadata = metadataResult.value as Record<string, unknown>;
  if (redaction.applied) safeMetadata.redaction = redactionMetadata(redaction);

  const envelope: TelemetryEnvelope = {
    schema_version: 1,
    event_id: eventId,
    source_event_id: `${data.run_id}:process:resource_usage`,
    event_time: data.event_time,
    ingest_time: ingestTime,
    type: "metric",
    source,
    severity: "info",
    privacy: "internal",
    machine_id: data.machine_id,
    repo_id: data.repo_id,
    app_id: data.app_id,
    process_id: data.process_id,
    run_id: data.run_id,
    environment: data.environment,
    message: messageResult.value,
    body: bodyResult.value as Record<string, unknown>,
    attributes: {
      category: "process_resource_usage",
      metric_name: "process.resource.peak_rss",
      metric_kind: "gauge",
      metric_unit: metricUnit,
      sampler: data.resource_usage.sampler,
      resource_available: data.resource_usage.available,
      sample_count: data.resource_usage.sample_count,
      run_type: data.classifier.run_type,
      tool: data.classifier.tool,
      package_manager: data.classifier.package_manager,
      framework: data.classifier.framework,
      script: data.classifier.script,
      machine_id: data.machine_id,
      repo_id: data.repo_id,
      app_id: data.app_id,
      process_id: data.process_id,
      run_id: data.run_id,
      environment: data.environment,
    },
  };
  const catalogEvent = withEventStoreLock(db, () => {
    const write = appendRawEvent(db, envelope);
    indexRawEvent(
      db,
      {
        event_id: eventId,
        schema_version: envelope.schema_version,
        source_event_id: envelope.source_event_id,
        event_type: envelope.type,
        event_time: envelope.event_time,
        ingest_time: envelope.ingest_time,
        severity: envelope.severity,
        source: envelope.source,
        project_id: data.project_id,
        machine_id: data.machine_id,
        repo_id: data.repo_id,
        app_id: data.app_id,
        process_id: data.process_id,
        run_id: data.run_id,
        environment: data.environment,
        privacy_tier: "internal",
        message: messageResult.value,
        metadata: safeMetadata,
      },
      write,
    );
    return getEvent(db, eventId, false);
  });
  if (catalogEvent) publishEventCatalogEvent(catalogEvent);
}

function recordProcessTreeEvent(
  db: Database,
  data: {
    event_time: string;
    run_id: string;
    process_id: string;
    machine_id: string;
    repo_id: string | null;
    app_id: string | null;
    environment: string;
    project_id: string | null;
    classifier: CommandRunClassifier;
    pid: number | null;
    process_tree: CommandRunProcessTreeSummary;
  },
): void {
  const eventId = `${data.run_id}-process-tree`;
  const ingestTime = new Date().toISOString();
  const source = sourceForRunType(data.classifier.run_type);
  const body = {
    process_tree: {
      ...data.process_tree,
    },
  };
  const metadata = {
    category: "process_tree",
    pid: data.pid,
    run_type: data.classifier.run_type,
    tool: data.classifier.tool,
    package_manager: data.classifier.package_manager,
    framework: data.classifier.framework,
    script: data.classifier.script,
    sampler: data.process_tree.sampler,
    tree_available: data.process_tree.available,
    sample_count: data.process_tree.sample_count,
    descendant_count_last: data.process_tree.descendant_count_last,
    descendant_count_peak: data.process_tree.descendant_count_peak,
    direct_child_count_last: data.process_tree.direct_child_count_last,
    direct_child_count_peak: data.process_tree.direct_child_count_peak,
    max_depth_peak: data.process_tree.max_depth_peak,
    observed_pid_count: data.process_tree.observed_pid_count,
    truncated: data.process_tree.truncated,
  };
  const messageResult = redactString("Process tree summary", "message");
  const bodyResult = redactValue(body, "body");
  const metadataResult = redactValue(metadata, "metadata");
  const redaction = mergeRedactionReports(
    messageResult.report,
    bodyResult.report,
    metadataResult.report,
  );
  const safeMetadata = metadataResult.value as Record<string, unknown>;
  if (redaction.applied) safeMetadata.redaction = redactionMetadata(redaction);

  const envelope: TelemetryEnvelope = {
    schema_version: 1,
    event_id: eventId,
    source_event_id: `${data.run_id}:process:tree`,
    event_time: data.event_time,
    ingest_time: ingestTime,
    type: "process",
    source,
    severity: "info",
    privacy: "internal",
    machine_id: data.machine_id,
    repo_id: data.repo_id,
    app_id: data.app_id,
    process_id: data.process_id,
    run_id: data.run_id,
    environment: data.environment,
    message: messageResult.value,
    body: bodyResult.value as Record<string, unknown>,
    attributes: {
      category: "process_tree",
      sampler: data.process_tree.sampler,
      tree_available: data.process_tree.available,
      sample_count: data.process_tree.sample_count,
      descendant_count_peak: data.process_tree.descendant_count_peak,
      direct_child_count_peak: data.process_tree.direct_child_count_peak,
      max_depth_peak: data.process_tree.max_depth_peak,
      truncated: data.process_tree.truncated,
      machine_id: data.machine_id,
      repo_id: data.repo_id,
      app_id: data.app_id,
      process_id: data.process_id,
      run_id: data.run_id,
      environment: data.environment,
    },
  };
  const catalogEvent = withEventStoreLock(db, () => {
    const write = appendRawEvent(db, envelope);
    indexRawEvent(
      db,
      {
        event_id: eventId,
        schema_version: envelope.schema_version,
        source_event_id: envelope.source_event_id,
        event_type: envelope.type,
        event_time: envelope.event_time,
        ingest_time: envelope.ingest_time,
        severity: envelope.severity,
        source: envelope.source,
        project_id: data.project_id,
        machine_id: data.machine_id,
        repo_id: data.repo_id,
        app_id: data.app_id,
        process_id: data.process_id,
        run_id: data.run_id,
        environment: data.environment,
        privacy_tier: "internal",
        message: messageResult.value,
        metadata: safeMetadata,
      },
      write,
    );
    return getEvent(db, eventId, false);
  });
  if (catalogEvent) publishEventCatalogEvent(catalogEvent);
}

function recordArtifactEvents(
  db: Database,
  data: {
    event_time: string;
    run_id: string;
    process_id: string;
    machine_id: string;
    repo_id: string | null;
    app_id: string | null;
    environment: string;
    project_id: string | null;
    classifier: CommandRunClassifier;
    artifacts: CommandRunArtifactSummary;
  },
): void {
  if (data.artifacts.artifacts.length === 0) return;
  const source = sourceForRunType(data.classifier.run_type);
  for (const artifact of data.artifacts.artifacts) {
    const ingestTime = new Date().toISOString();
    const body = {
      artifact: {
        artifact_id: artifact.artifact_id,
        artifact_type: artifact.artifact_type,
        path: artifact.path,
        size_bytes: artifact.size_bytes,
        content_hash: artifact.content_hash,
        changed: artifact.changed,
        mtime_ms: artifact.mtime_ms,
        source_map: artifact.source_map,
      },
    };
    const metadata = {
      category: "build_artifact",
      scanner: data.artifacts.scanner,
      run_type: data.classifier.run_type,
      tool: data.classifier.tool,
      package_manager: data.classifier.package_manager,
      framework: data.classifier.framework,
      script: data.classifier.script,
      artifact_id: artifact.artifact_id,
      artifact_type: artifact.artifact_type,
      path: artifact.path,
      size_bytes: artifact.size_bytes,
      content_hash: artifact.content_hash,
      changed: artifact.changed,
      mtime_ms: artifact.mtime_ms,
      source_map: artifact.source_map,
      truncated: data.artifacts.truncated,
    };
    const attributes = {
      category: "build_artifact",
      artifact_id: artifact.artifact_id,
      artifact_type: artifact.artifact_type,
      path: artifact.path,
      size_bytes: artifact.size_bytes,
      content_hash: artifact.content_hash,
      changed: artifact.changed,
      source_map_status: artifact.source_map?.validation_status,
      source_map_path: artifact.source_map?.source_map_path,
      javascript_path: artifact.source_map?.javascript_path,
      scanner: data.artifacts.scanner,
      run_type: data.classifier.run_type,
      tool: data.classifier.tool,
      package_manager: data.classifier.package_manager,
      framework: data.classifier.framework,
      script: data.classifier.script,
      machine_id: data.machine_id,
      repo_id: data.repo_id,
      app_id: data.app_id,
      process_id: data.process_id,
      run_id: data.run_id,
      environment: data.environment,
    };
    const messageResult = redactString(
      `Build artifact discovered: ${artifact.path}`,
      "message",
    );
    const bodyResult = redactValue(body, "body");
    const attributesResult = redactValue(attributes, "attributes");
    const metadataResult = redactValue(metadata, "metadata");
    const redaction = mergeRedactionReports(
      messageResult.report,
      bodyResult.report,
      attributesResult.report,
      metadataResult.report,
    );
    const safeMetadata = metadataResult.value as Record<string, unknown>;
    const safeAttributes = attributesResult.value as Record<string, unknown>;
    if (redaction.applied)
      safeMetadata.redaction = redactionMetadata(redaction);

    const envelope: TelemetryEnvelope = {
      schema_version: 1,
      event_id: artifact.artifact_id,
      source_event_id: `${data.run_id}:artifact:${artifact.artifact_id}`,
      event_time: data.event_time,
      ingest_time: ingestTime,
      type: "artifact",
      source,
      severity: "info",
      privacy: "internal",
      machine_id: data.machine_id,
      repo_id: data.repo_id,
      app_id: data.app_id,
      process_id: data.process_id,
      run_id: data.run_id,
      environment: data.environment,
      message: messageResult.value,
      body: bodyResult.value as Record<string, unknown>,
      attributes: safeAttributes,
    };
    const catalogEvent = withEventStoreLock(db, () => {
      const write = appendRawEvent(db, envelope);
      const index = {
        event_id: artifact.artifact_id,
        schema_version: envelope.schema_version,
        source_event_id: envelope.source_event_id,
        event_type: envelope.type,
        event_time: envelope.event_time,
        ingest_time: envelope.ingest_time,
        severity: envelope.severity,
        source: envelope.source,
        project_id: data.project_id,
        machine_id: data.machine_id,
        repo_id: data.repo_id,
        app_id: data.app_id,
        process_id: data.process_id,
        run_id: data.run_id,
        environment: data.environment,
        artifact_id: artifact.artifact_id,
        privacy_tier: "internal",
        message: messageResult.value,
        metadata: safeMetadata,
      };
      indexRawEvent(db, index, write);
      upsertCommandRunArtifact(db, artifact, safeMetadata);
      upsertSourceMapProjection(db, envelope, index);
      return getEvent(db, artifact.artifact_id, false);
    });
    if (catalogEvent) publishEventCatalogEvent(catalogEvent);
  }
}

function recordTestReportEvents(
  db: Database,
  data: {
    event_time: string;
    run_id: string;
    process_id: string;
    machine_id: string;
    repo_id: string | null;
    app_id: string | null;
    environment: string;
    project_id: string | null;
    classifier: CommandRunClassifier;
    test_reports: CommandRunTestReportSummary;
  },
): void {
  if (data.test_reports.reports.length === 0) return;
  const source = sourceForRunType(data.classifier.run_type);
  for (const report of data.test_reports.reports) {
    const ingestTime = new Date().toISOString();
    const severity =
      report.failures > 0 ||
      report.errors > 0 ||
      report.parse_status === "malformed" ||
      report.parse_status === "unsafe"
        ? "error"
        : report.parse_status === "too_large" ||
            report.parse_status === "unsupported"
          ? "warn"
          : "info";
    const body = {
      test_report: {
        report_id: report.report_id,
        path: report.path,
        format: report.format,
        parser: report.parser,
        parse_status: report.parse_status,
        parse_error: report.parse_error,
        size_bytes: report.size_bytes,
        content_hash: report.content_hash,
        changed: report.changed,
        mtime_ms: report.mtime_ms,
        tests: report.tests,
        failures: report.failures,
        errors: report.errors,
        skipped: report.skipped,
        time_seconds: report.time_seconds,
        suite_count: report.suite_count,
        testcase_count: report.testcase_count,
        suites: report.suites,
        truncated: report.truncated,
      },
    };
    const metadata = {
      category: "test_report",
      scanner: data.test_reports.scanner,
      run_type: data.classifier.run_type,
      tool: data.classifier.tool,
      package_manager: data.classifier.package_manager,
      framework: data.classifier.framework,
      script: data.classifier.script,
      report_id: report.report_id,
      report_format: report.format,
      parser: report.parser,
      parse_status: report.parse_status,
      parse_error: report.parse_error,
      path: report.path,
      size_bytes: report.size_bytes,
      content_hash: report.content_hash,
      changed: report.changed,
      mtime_ms: report.mtime_ms,
      tests: report.tests,
      failures: report.failures,
      errors: report.errors,
      skipped: report.skipped,
      time_seconds: report.time_seconds,
      suite_count: report.suite_count,
      testcase_count: report.testcase_count,
      truncated: report.truncated || data.test_reports.truncated,
      suites: report.suites,
    };
    const attributes = {
      category: "test_report",
      scanner: data.test_reports.scanner,
      report_id: report.report_id,
      report_format: report.format,
      parser: report.parser,
      parse_status: report.parse_status,
      path: report.path,
      size_bytes: report.size_bytes,
      content_hash: report.content_hash,
      changed: report.changed,
      tests: report.tests,
      failures: report.failures,
      errors: report.errors,
      skipped: report.skipped,
      time_seconds: report.time_seconds,
      suite_count: report.suite_count,
      testcase_count: report.testcase_count,
      truncated: report.truncated || data.test_reports.truncated,
      run_type: data.classifier.run_type,
      tool: data.classifier.tool,
      package_manager: data.classifier.package_manager,
      framework: data.classifier.framework,
      script: data.classifier.script,
      machine_id: data.machine_id,
      repo_id: data.repo_id,
      app_id: data.app_id,
      process_id: data.process_id,
      run_id: data.run_id,
      environment: data.environment,
    };
    const messageResult = redactString(
      `Test report discovered: ${report.path}`,
      "message",
    );
    const bodyResult = redactValue(body, "body");
    const attributesResult = redactValue(attributes, "attributes");
    const metadataResult = redactValue(metadata, "metadata");
    const redaction = mergeRedactionReports(
      messageResult.report,
      bodyResult.report,
      attributesResult.report,
      metadataResult.report,
    );
    const safeMetadata = metadataResult.value as Record<string, unknown>;
    const safeAttributes = attributesResult.value as Record<string, unknown>;
    if (redaction.applied)
      safeMetadata.redaction = redactionMetadata(redaction);

    const envelope: TelemetryEnvelope = {
      schema_version: 1,
      event_id: report.report_id,
      source_event_id: `${data.run_id}:test_report:${report.report_id}`,
      event_time: data.event_time,
      ingest_time: ingestTime,
      type: "build",
      source,
      severity,
      privacy: "internal",
      machine_id: data.machine_id,
      repo_id: data.repo_id,
      app_id: data.app_id,
      process_id: data.process_id,
      run_id: data.run_id,
      environment: data.environment,
      message: messageResult.value,
      body: bodyResult.value as Record<string, unknown>,
      attributes: safeAttributes,
    };
    const catalogEvent = withEventStoreLock(db, () => {
      const write = appendRawEvent(db, envelope);
      const index = {
        event_id: report.report_id,
        schema_version: envelope.schema_version,
        source_event_id: envelope.source_event_id,
        event_type: envelope.type,
        event_time: envelope.event_time,
        ingest_time: envelope.ingest_time,
        severity: envelope.severity,
        source: envelope.source,
        project_id: data.project_id,
        machine_id: data.machine_id,
        repo_id: data.repo_id,
        app_id: data.app_id,
        process_id: data.process_id,
        run_id: data.run_id,
        environment: data.environment,
        privacy_tier: "internal",
        message: messageResult.value,
        metadata: safeMetadata,
      };
      indexRawEvent(db, index, write);
      upsertTestReportProjection(db, envelope, index);
      return getEvent(db, report.report_id, false);
    });
    if (catalogEvent) publishEventCatalogEvent(catalogEvent);
  }
}

function upsertCommandRunArtifact(
  db: Database,
  artifact: CommandRunArtifactInfo,
  metadata: Record<string, unknown>,
): void {
  const artifactType =
    typeof metadata.artifact_type === "string"
      ? metadata.artifact_type
      : artifact.artifact_type;
  const artifactPath =
    typeof metadata.path === "string" ? metadata.path : artifact.path;
  const contentHash =
    typeof metadata.content_hash === "string"
      ? metadata.content_hash
      : artifact.content_hash;
  const sizeBytes =
    typeof metadata.size_bytes === "number"
      ? metadata.size_bytes
      : artifact.size_bytes;
  db.prepare(`
    INSERT INTO artifacts (id, release_id, artifact_type, path, content_hash, size_bytes, metadata)
    VALUES (?, NULL, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      artifact_type = COALESCE(excluded.artifact_type, artifacts.artifact_type),
      path = COALESCE(excluded.path, artifacts.path),
      content_hash = COALESCE(excluded.content_hash, artifacts.content_hash),
      size_bytes = COALESCE(excluded.size_bytes, artifacts.size_bytes),
      metadata = excluded.metadata
  `).run(
    artifact.artifact_id,
    artifactType,
    artifactPath,
    contentHash,
    sizeBytes,
    JSON.stringify(metadata),
  );
}

function recordLifecycleSummaryEvent(
  db: Database,
  data: {
    run_id: string;
    process_id: string;
    machine_id: string;
    repo_id: string | null;
    app_id: string | null;
    environment: string;
    project_id: string | null;
    classifier: CommandRunClassifier;
    command: string[];
    cwd: string;
    pid: number | null;
    started_at: string;
    ended_at: string;
    exit_code: number;
    signal: string | null;
    status: "completed" | "failed";
    duration_ms: number;
    stdout_lines: number;
    stderr_lines: number;
    stdout_chunks: number;
    stderr_chunks: number;
    stdout_bytes: number;
    stderr_bytes: number;
    summary: CommandRunOutputSummary;
    resource_usage: CommandRunResourceSummary;
    process_tree: CommandRunProcessTreeSummary;
    artifacts: CommandRunArtifactSummary;
    test_reports: CommandRunTestReportSummary;
  },
): void {
  if (data.classifier.run_type === "command") return;

  const commandLine = data.command.join(" ");
  const label = runTypeLabel(data.classifier.run_type);
  const eventId = `${data.run_id}-summary`;
  const eventTime = data.ended_at;
  const ingestTime = new Date().toISOString();
  const source = sourceForRunType(data.classifier.run_type);
  const severity = lifecycleSeverity(
    data.exit_code,
    data.summary,
    data.signal,
    data.test_reports,
  );
  const message = `${label} ${data.status}: ${commandLine}`;
  const reportTotals = summarizeTestReportTotals(data.test_reports);
  const body = {
    lifecycle: {
      kind: data.classifier.run_type,
      tool: data.classifier.tool,
      package_manager: data.classifier.package_manager,
      framework: data.classifier.framework,
      script: data.classifier.script,
      command: data.command,
      cwd: data.cwd,
      pid: data.pid,
      started_at: data.started_at,
      ended_at: data.ended_at,
      exit_code: data.exit_code,
      signal: data.signal,
      status: data.status,
      duration_ms: data.duration_ms,
      stdout_lines: data.stdout_lines,
      stderr_lines: data.stderr_lines,
      stdout_chunks: data.stdout_chunks,
      stderr_chunks: data.stderr_chunks,
      stdout_bytes: data.stdout_bytes,
      stderr_bytes: data.stderr_bytes,
      summary: data.summary,
      resource_usage: data.resource_usage,
      process_tree: data.process_tree,
      artifacts: data.artifacts,
      test_reports: data.test_reports,
    },
  };
  const metadata = {
    category: "command_run_summary",
    run_type: data.classifier.run_type,
    tool: data.classifier.tool,
    package_manager: data.classifier.package_manager,
    framework: data.classifier.framework,
    script: data.classifier.script,
    command: commandLine,
    cwd: data.cwd,
    name: commandLine,
    status: data.status,
    started_at: data.started_at,
    ended_at: data.ended_at,
    exit_code: data.exit_code,
    signal: data.signal,
    duration_ms: data.duration_ms,
    stdout_lines: data.stdout_lines,
    stderr_lines: data.stderr_lines,
    stdout_chunks: data.stdout_chunks,
    stderr_chunks: data.stderr_chunks,
    stdout_bytes: data.stdout_bytes,
    stderr_bytes: data.stderr_bytes,
    error_lines: data.summary.error_lines,
    warning_lines: data.summary.warning_lines,
    compiler_error_lines: data.summary.compiler_error_lines,
    test_failure_lines: data.summary.test_failure_lines,
    test_success_lines: data.summary.test_success_lines,
    server_ready_lines: data.summary.server_ready_lines,
    detected_url_count: data.summary.detected_urls.length,
    detected_port_count: data.summary.detected_ports.length,
    summary: data.summary,
    resource_usage: data.resource_usage,
    process_tree: data.process_tree,
    artifacts: data.artifacts,
    test_reports: data.test_reports,
    test_report_count: data.test_reports.reports.length,
    test_report_tests: reportTotals.tests,
    test_report_failures: reportTotals.failures,
    test_report_errors: reportTotals.errors,
    test_report_skipped: reportTotals.skipped,
  };
  const messageResult = redactString(message, "message");
  const bodyResult = redactValue(body, "body");
  const metadataResult = redactValue(metadata, "metadata");
  const redaction = mergeRedactionReports(
    messageResult.report,
    bodyResult.report,
    metadataResult.report,
  );
  const safeMetadata = metadataResult.value as Record<string, unknown>;
  if (redaction.applied) safeMetadata.redaction = redactionMetadata(redaction);

  const envelope: TelemetryEnvelope = {
    schema_version: 1,
    event_id: eventId,
    source_event_id: `${data.run_id}:lifecycle:summary`,
    event_time: eventTime,
    ingest_time: ingestTime,
    type: "build",
    source,
    severity,
    privacy: "internal",
    machine_id: data.machine_id,
    repo_id: data.repo_id,
    app_id: data.app_id,
    process_id: data.process_id,
    run_id: data.run_id,
    environment: data.environment,
    message: messageResult.value,
    body: bodyResult.value as Record<string, unknown>,
    attributes: {
      category: "command_run_summary",
      run_type: data.classifier.run_type,
      tool: data.classifier.tool,
      package_manager: data.classifier.package_manager,
      framework: data.classifier.framework,
      script: data.classifier.script,
      machine_id: data.machine_id,
      repo_id: data.repo_id,
      app_id: data.app_id,
      process_id: data.process_id,
      run_id: data.run_id,
      environment: data.environment,
      status: data.status,
      exit_code: data.exit_code,
      signal: data.signal,
      duration_ms: data.duration_ms,
    },
  };
  const catalogEvent = withEventStoreLock(db, () => {
    const write = appendRawEvent(db, envelope);
    indexRawEvent(
      db,
      {
        event_id: eventId,
        schema_version: envelope.schema_version,
        source_event_id: envelope.source_event_id,
        event_type: envelope.type,
        event_time: envelope.event_time,
        ingest_time: envelope.ingest_time,
        severity: envelope.severity,
        source: envelope.source,
        project_id: data.project_id,
        machine_id: data.machine_id,
        repo_id: data.repo_id,
        app_id: data.app_id,
        process_id: data.process_id,
        run_id: data.run_id,
        environment: data.environment,
        privacy_tier: "internal",
        message: messageResult.value,
        metadata: safeMetadata,
      },
      write,
    );
    return getEvent(db, eventId, false);
  });
  if (catalogEvent) publishEventCatalogEvent(catalogEvent);
}

function classifyCommand(command: string[]): CommandRunClassifier {
  const executable = normalizeCommandToken(command[0] ?? "command");
  const tokens = command.map(normalizeCommandToken);
  const packageManager = detectPackageManager(executable);
  const script = detectScript(tokens, packageManager);
  const joined = tokens.join(" ");
  const framework = detectFramework(joined);
  const matchedTool = detectTool(tokens, joined);
  const runType = detectRunType(tokens, joined, script, matchedTool);
  const tool = matchedTool ?? script ?? executable;
  return {
    run_type: runType,
    tool,
    package_manager: packageManager,
    framework,
    script,
  };
}

function detectPackageManager(executable: string): string | null {
  return ["npm", "pnpm", "yarn", "bun"].includes(executable)
    ? executable
    : null;
}

function detectScript(
  tokens: string[],
  packageManager: string | null,
): string | null {
  if (!packageManager) return null;
  const runIndex = tokens.indexOf("run");
  if (runIndex >= 0) {
    const explicitScript = tokens[runIndex + 1];
    if (explicitScript) return explicitScript;
  }
  for (const token of tokens.slice(1)) {
    if (
      [
        "test",
        "build",
        "dev",
        "start",
        "serve",
        "lint",
        "typecheck",
        "check",
      ].includes(token)
    )
      return token;
  }
  return null;
}

function detectTool(tokens: string[], joined: string): string | null {
  const knownTools = [
    "next",
    "vite",
    "tsc",
    "jest",
    "vitest",
    "playwright",
    "eslint",
    "biome",
    "webpack",
    "rollup",
    "astro",
    "nuxt",
    "turbo",
    "mocha",
    "ava",
  ];
  for (const tool of knownTools) {
    if (tokens.includes(tool) || joined.includes(` ${tool} `)) return tool;
  }
  if (joined.includes("svelte-kit")) return "svelte-kit";
  return null;
}

function detectFramework(joined: string): string | null {
  if (joined.includes("next")) return "next";
  if (joined.includes("vite")) return "vite";
  if (joined.includes("nuxt")) return "nuxt";
  if (joined.includes("astro")) return "astro";
  if (joined.includes("remix")) return "remix";
  if (joined.includes("svelte-kit")) return "svelte-kit";
  return null;
}

function detectRunType(
  tokens: string[],
  joined: string,
  script: string | null,
  tool: string | null,
): CommandRunType {
  const scriptOrTool = `${script ?? ""} ${tool ?? ""}`;
  if (
    /\b(test|spec|vitest|jest|playwright|mocha|ava)\b/.test(
      `${joined} ${scriptOrTool}`,
    )
  )
    return "test";
  if (
    /\b(build|typecheck|check|compile|tsc|webpack|rollup|turbo)\b/.test(
      `${joined} ${scriptOrTool}`,
    )
  )
    return "build";
  if (/\b(dev|serve|start|preview)\b/.test(`${joined} ${scriptOrTool}`))
    return "dev-server";
  if (tokens.includes("lint") || tool === "eslint" || tool === "biome")
    return "build";
  return "command";
}

function normalizeCommandToken(value: string): string {
  return basename(value)
    .replace(/\.(?:exe|cmd)$/i, "")
    .toLowerCase();
}

function defaultServiceName(
  command: string[],
  classifier: CommandRunClassifier,
): string {
  if (classifier.framework) return classifier.framework;
  if (classifier.tool) return classifier.tool;
  return command[0] ?? "command";
}

function classifierMetadataObject(
  classifier: CommandRunClassifier,
): Record<string, unknown> {
  return {
    run_type: classifier.run_type,
    tool: classifier.tool,
    package_manager: classifier.package_manager,
    framework: classifier.framework,
    script: classifier.script,
  };
}

function sourceForRunType(runType: CommandRunType): LogSource {
  if (runType === "test") return "test";
  if (runType === "build") return "build";
  return "cli";
}

function inspectProcessLine(
  line: string,
  streamName: StreamName,
): ProcessLineInsight {
  const text = stripAnsi(line);
  const urls = extractUrls(text);
  const ports = extractPorts(text);
  const diagnosticCodes = extractDiagnosticCodes(text);
  const hasFatal =
    /\b(fatal|panic|segmentation fault|out of memory|uncaught)\b/i.test(text);
  const hasWarning = /\b(warn|warning|deprecated)\b/i.test(text);
  const hasError =
    /\b(error|failed|failure|exception|traceback|syntaxerror|typeerror|referenceerror)\b/i.test(
      text,
    );

  let category: LineCategory = "output";
  if (
    urls.length > 0 &&
    /\b(local|network|ready|started|server|listening|localhost|127\.0\.0\.1)\b/i.test(
      text,
    )
  ) {
    category = "server_ready";
  } else if (
    /^\s*(fail|failed|not ok)\b/i.test(text) ||
    /\b(assertionerror|test failed|failed tests?)\b/i.test(text)
  ) {
    category = "test_failure";
  } else if (
    /^\s*(pass|passed|ok)\b/i.test(text) ||
    /\b(tests? passed|passing)\b/i.test(text)
  ) {
    category = "test_success";
  } else if (
    diagnosticCodes.length > 0 ||
    /:\s*(error|warning)\b/i.test(text)
  ) {
    category = hasWarning && !hasError ? "warning" : "compiler_diagnostic";
  } else if (/\b(uncaught|unhandled|exception|traceback)\b/i.test(text)) {
    category = "exception";
  } else if (hasError) {
    category = "error";
  } else if (hasWarning) {
    category = "warning";
  }

  let severity: LogLevel = streamName === "stderr" ? "error" : "info";
  if (category === "warning") severity = "warn";
  if (
    category === "server_ready" ||
    category === "test_success" ||
    category === "output"
  )
    severity = streamName === "stderr" ? "error" : "info";
  if (
    category === "compiler_diagnostic" ||
    category === "test_failure" ||
    category === "error" ||
    category === "exception"
  )
    severity = hasFatal ? "fatal" : "error";

  return { category, severity, urls, ports, diagnostic_codes: diagnosticCodes };
}

function emptyOutputSummary(): CommandRunOutputSummary {
  return {
    chunk_count: 0,
    byte_count: 0,
    line_count: 0,
    error_lines: 0,
    warning_lines: 0,
    compiler_error_lines: 0,
    test_failure_lines: 0,
    test_success_lines: 0,
    server_ready_lines: 0,
    uncaught_exception_lines: 0,
    categories: {},
    detected_urls: [],
    detected_ports: [],
    diagnostic_codes: [],
    first_error: null,
    first_warning: null,
  };
}

function addLineToSummary(
  summary: CommandRunOutputSummary,
  line: string,
  insight: ProcessLineInsight,
): void {
  summary.line_count += 1;
  summary.categories[insight.category] =
    (summary.categories[insight.category] ?? 0) + 1;
  if (insight.severity === "error" || insight.severity === "fatal") {
    summary.error_lines += 1;
    summary.first_error ??= safeSnippet(line);
  }
  if (insight.severity === "warn") {
    summary.warning_lines += 1;
    summary.first_warning ??= safeSnippet(line);
  }
  if (insight.category === "compiler_diagnostic")
    summary.compiler_error_lines += 1;
  if (insight.category === "test_failure") summary.test_failure_lines += 1;
  if (insight.category === "test_success") summary.test_success_lines += 1;
  if (insight.category === "server_ready") summary.server_ready_lines += 1;
  if (insight.category === "exception") summary.uncaught_exception_lines += 1;
  pushUniqueStrings(summary.detected_urls, insight.urls);
  pushUniqueNumbers(summary.detected_ports, insight.ports);
  pushUniqueStrings(summary.diagnostic_codes, insight.diagnostic_codes);
}

function mergeOutputSummaries(
  ...summaries: CommandRunOutputSummary[]
): CommandRunOutputSummary {
  const merged = emptyOutputSummary();
  for (const summary of summaries) {
    merged.chunk_count += summary.chunk_count;
    merged.byte_count += summary.byte_count;
    merged.line_count += summary.line_count;
    merged.error_lines += summary.error_lines;
    merged.warning_lines += summary.warning_lines;
    merged.compiler_error_lines += summary.compiler_error_lines;
    merged.test_failure_lines += summary.test_failure_lines;
    merged.test_success_lines += summary.test_success_lines;
    merged.server_ready_lines += summary.server_ready_lines;
    merged.uncaught_exception_lines += summary.uncaught_exception_lines;
    merged.first_error ??= summary.first_error;
    merged.first_warning ??= summary.first_warning;
    for (const [category, count] of Object.entries(summary.categories)) {
      merged.categories[category] = (merged.categories[category] ?? 0) + count;
    }
    pushUniqueStrings(merged.detected_urls, summary.detected_urls);
    pushUniqueNumbers(merged.detected_ports, summary.detected_ports);
    pushUniqueStrings(merged.diagnostic_codes, summary.diagnostic_codes);
  }
  return merged;
}

function lifecycleSeverity(
  exitCode: number,
  summary: CommandRunOutputSummary,
  signal?: string | null,
  testReports?: CommandRunTestReportSummary,
): LogLevel {
  if (signal || exitCode !== 0 || summary.error_lines > 0) return "error";
  const reportTotals = testReports
    ? summarizeTestReportTotals(testReports)
    : null;
  if (reportTotals && (reportTotals.failures > 0 || reportTotals.errors > 0))
    return "error";
  if (summary.warning_lines > 0) return "warn";
  return "info";
}

function runTypeLabel(runType: CommandRunType): string {
  if (runType === "test") return "Test run";
  if (runType === "build") return "Build run";
  if (runType === "dev-server") return "Dev server";
  return "Command";
}

function stripAnsi(value: string): string {
  const escapeChar = String.fromCharCode(27);
  let output = "";
  let index = 0;
  while (index < value.length) {
    if (value[index] === escapeChar && value[index + 1] === "[") {
      index += 2;
      while (index < value.length) {
        const code = value.charCodeAt(index);
        index += 1;
        if (code >= 0x40 && code <= 0x7e) break;
      }
      continue;
    }
    output += value[index] ?? "";
    index += 1;
  }
  return output;
}

function extractUrls(value: string): string[] {
  return [...value.matchAll(/\bhttps?:\/\/[^\s"'<>]+/gi)].map(
    (match) => redactString(match[0] ?? "", "url").value,
  );
}

function extractPorts(value: string): number[] {
  const ports = new Set<number>();
  for (const match of value.matchAll(
    /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/gi,
  )) {
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
  }
  for (const match of value.matchAll(/\bport\s+(\d{2,5})\b/gi)) {
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
  }
  return [...ports];
}

function extractDiagnosticCodes(value: string): string[] {
  const codes = new Set<string>();
  for (const match of value.matchAll(/\b(?:TS|E|W|ERR|WARN)\d{3,6}\b/g)) {
    const code = match[0];
    if (code) codes.add(code);
  }
  return [...codes];
}

function safeSnippet(value: string): string {
  return redactString(stripAnsi(value).slice(0, MAX_SUMMARY_SNIPPET), "summary")
    .value;
}

function pushUniqueStrings(target: string[], values: string[]): void {
  for (const value of values) {
    const safe = redactString(value, "summary").value;
    if (!target.includes(safe)) target.push(safe);
    if (target.length >= MAX_SUMMARY_VALUES) return;
  }
}

function pushUniqueNumbers(target: number[], values: number[]): void {
  for (const value of values) {
    if (!target.includes(value)) target.push(value);
    if (target.length >= MAX_SUMMARY_VALUES) return;
  }
}

function prepareChunkBytes(bytes: Uint8Array): {
  data_base64: string;
  original_byte_length: number;
  stored_byte_length: number;
  stored_sha256: string;
  contains_invalid_utf8: boolean;
  text_preview: string | null;
  redaction: RedactionReport;
} {
  const originalByteLength = bytes.byteLength;
  const decoded = decodeUtf8Strict(bytes);
  if (decoded === null) {
    const redacted = redactString(
      bytesToBinaryString(bytes),
      "stream_chunk_bytes",
    );
    const storedBytes = binaryStringToBytes(redacted.value);
    return {
      data_base64: Buffer.from(storedBytes).toString("base64"),
      original_byte_length: originalByteLength,
      stored_byte_length: storedBytes.byteLength,
      stored_sha256: sha256Bytes(storedBytes),
      contains_invalid_utf8: true,
      text_preview: null,
      redaction: redacted.report,
    };
  }

  const redacted = redactString(decoded, "stream_chunk");
  const storedBytes = new TextEncoder().encode(redacted.value);
  return {
    data_base64: Buffer.from(storedBytes).toString("base64"),
    original_byte_length: originalByteLength,
    stored_byte_length: storedBytes.byteLength,
    stored_sha256: sha256Bytes(storedBytes),
    contains_invalid_utf8: false,
    text_preview: safeSnippet(redacted.value),
    redaction: redacted.report,
  };
}

function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function bytesToBinaryString(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) output += String.fromCharCode(byte);
  return output;
}

function binaryStringToBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index) & 0xff;
  }
  return bytes;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function writeChildBytes(streamName: StreamName, bytes: Uint8Array): void {
  if (streamName === "stderr") {
    process.stderr.write(Buffer.from(bytes));
  } else {
    process.stdout.write(Buffer.from(bytes));
  }
}

function installAbortForwarder(
  child: { kill: (signal?: NodeJS.Signals) => void },
  signal: AbortSignal | undefined,
): { cleanup: () => void; getSignal: () => string | null } {
  let forwardedSignal: NodeJS.Signals | null = null;
  if (!signal) return { cleanup: () => {}, getSignal: () => forwardedSignal };

  const abort = () => {
    forwardedSignal = abortReasonToSignal(signal.reason);
    try {
      child.kill(forwardedSignal);
    } catch {
      // The child may already have exited; telemetry finalization should continue.
    }
  };

  if (signal.aborted) {
    abort();
    return { cleanup: () => {}, getSignal: () => forwardedSignal };
  }

  signal.addEventListener("abort", abort, { once: true });
  return {
    cleanup: () => signal.removeEventListener("abort", abort),
    getSignal: () => forwardedSignal,
  };
}

function abortReasonToSignal(reason: unknown): NodeJS.Signals {
  if (reason === "SIGINT" || reason === "SIGTERM") return reason;
  return "SIGTERM";
}

function readSignalCode(child: unknown): string | null {
  const signal = (child as { signalCode?: unknown }).signalCode;
  return typeof signal === "string" ? signal : null;
}

interface ProcessResourceSnapshot {
  observed_at: string;
  rss_bytes: number | null;
  peak_rss_bytes: number | null;
  vms_bytes: number | null;
  threads: number | null;
  cpu_user_ticks: number | null;
  cpu_system_ticks: number | null;
  cpu_total_ticks: number | null;
}

interface ProcessTreeSnapshot {
  observed_at: string;
  root_pid: number;
  nodes: CommandRunProcessTreeNode[];
  truncated: boolean;
}

interface ProcStatusInfo {
  pid: number;
  ppid: number;
  name: string | null;
  state: string | null;
}

interface ArtifactSnapshotFile {
  path: string;
  absolute_path: string;
  size_bytes: number;
  mtime_ms: number;
  dev: number;
  ino: number;
}

interface ArtifactSnapshot {
  files: Map<string, ArtifactSnapshotFile>;
  scanned_roots: string[];
  truncated: boolean;
}

interface TestReportSnapshotFile extends ArtifactSnapshotFile {
  content_hash: string | null;
}

interface TestReportSnapshot {
  files: Map<string, TestReportSnapshotFile>;
  scanned_roots: string[];
  truncated: boolean;
}

function startProcessResourceSampler(pid: number | null): {
  stop: () => CommandRunResourceSummary;
} {
  const sampler: CommandRunResourceSummary["sampler"] =
    process.platform === "linux" && pid !== null
      ? "linux-procfs"
      : "unsupported";
  const samples: ProcessResourceSnapshot[] = [];
  let stopped = false;
  const sample = () => {
    if (stopped || sampler !== "linux-procfs" || pid === null) return;
    const snapshot = readLinuxProcResourceSnapshot(pid);
    if (snapshot) samples.push(snapshot);
  };
  sample();
  const interval =
    sampler === "linux-procfs" ? setInterval(sample, 50) : undefined;
  interval?.unref?.();
  return {
    stop: () => {
      if (!stopped) {
        sample();
        stopped = true;
        if (interval) clearInterval(interval);
      }
      return summarizeProcessResourceSamples(sampler, samples);
    },
  };
}

function startProcessTreeSampler(pid: number | null): {
  stop: () => CommandRunProcessTreeSummary;
} {
  const sampler: CommandRunProcessTreeSummary["sampler"] =
    process.platform === "linux" && pid !== null
      ? "linux-procfs"
      : "unsupported";
  const samples: ProcessTreeSnapshot[] = [];
  let stopped = false;
  const sample = () => {
    if (stopped || sampler !== "linux-procfs" || pid === null) return;
    const snapshot = readLinuxProcTreeSnapshot(pid);
    if (snapshot) samples.push(snapshot);
  };
  sample();
  const interval =
    sampler === "linux-procfs" ? setInterval(sample, 100) : undefined;
  interval?.unref?.();
  return {
    stop: () => {
      if (!stopped) {
        sample();
        stopped = true;
        if (interval) clearInterval(interval);
      }
      return summarizeProcessTreeSamples(sampler, pid, samples);
    },
  };
}

function readLinuxProcResourceSnapshot(
  pid: number,
): ProcessResourceSnapshot | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const cpu = parseProcStatCpuTicks(stat);
    const rssBytes = procStatusKbField(status, "VmRSS");
    const peakRssBytes = procStatusKbField(status, "VmHWM");
    return {
      observed_at: new Date().toISOString(),
      rss_bytes: rssBytes,
      peak_rss_bytes: peakRssBytes ?? rssBytes,
      vms_bytes: procStatusKbField(status, "VmSize"),
      threads: procStatusNumberField(status, "Threads"),
      cpu_user_ticks: cpu.user,
      cpu_system_ticks: cpu.system,
      cpu_total_ticks:
        cpu.user !== null || cpu.system !== null
          ? (cpu.user ?? 0) + (cpu.system ?? 0)
          : null,
    };
  } catch {
    return null;
  }
}

function readLinuxProcTreeSnapshot(
  rootPid: number,
): ProcessTreeSnapshot | null {
  const root = readLinuxProcStatusInfo(rootPid);
  if (!root) return null;

  const childrenByParent = new Map<number, ProcStatusInfo[]>();
  try {
    for (const entry of readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pid = Number(entry.name);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      const info = readLinuxProcStatusInfo(pid);
      if (!info) continue;
      const children = childrenByParent.get(info.ppid) ?? [];
      children.push(info);
      childrenByParent.set(info.ppid, children);
    }
  } catch {
    return null;
  }

  for (const children of childrenByParent.values()) {
    children.sort((a, b) => a.pid - b.pid);
  }

  const nodes: CommandRunProcessTreeNode[] = [];
  const visited = new Set<number>([root.pid]);
  const queue = (childrenByParent.get(root.pid) ?? []).map((info) => ({
    info,
    depth: 1,
  }));
  let truncated = false;

  for (let index = 0; index < queue.length; index++) {
    const item = queue[index];
    if (!item) continue;
    const { info, depth } = item;
    if (visited.has(info.pid)) continue;
    visited.add(info.pid);
    if (nodes.length >= MAX_PROCESS_TREE_NODES) {
      truncated = true;
      break;
    }
    nodes.push({
      pid: info.pid,
      ppid: info.ppid,
      depth,
      name: info.name,
      state: info.state,
    });
    for (const child of childrenByParent.get(info.pid) ?? []) {
      if (!visited.has(child.pid))
        queue.push({ info: child, depth: depth + 1 });
    }
  }

  if (queue.length > nodes.length)
    truncated = truncated || nodes.length >= MAX_PROCESS_TREE_NODES;

  return {
    observed_at: new Date().toISOString(),
    root_pid: root.pid,
    nodes,
    truncated,
  };
}

function readLinuxProcStatusInfo(pid: number): ProcStatusInfo | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    return {
      pid,
      ppid: procStatusNumberField(status, "PPid") ?? 0,
      name: procStatusStringField(status, "Name"),
      state: procStatusStringField(status, "State"),
    };
  } catch {
    return null;
  }
}

function parseProcStatCpuTicks(stat: string): {
  user: number | null;
  system: number | null;
} {
  const closeParen = stat.lastIndexOf(")");
  if (closeParen < 0) return { user: null, system: null };
  const fields = stat
    .slice(closeParen + 2)
    .trim()
    .split(/\s+/);
  return {
    user: numericField(fields[11]),
    system: numericField(fields[12]),
  };
}

function procStatusKbField(status: string, field: string): number | null {
  const match = status.match(new RegExp(`^${field}:\\s+(\\d+)\\s+kB`, "m"));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value * 1024 : null;
}

function procStatusNumberField(status: string, field: string): number | null {
  const match = status.match(new RegExp(`^${field}:\\s+(\\d+)`, "m"));
  if (!match) return null;
  return numericField(match[1]);
}

function procStatusStringField(status: string, field: string): string | null {
  const match = status.match(new RegExp(`^${field}:\\s+(.+)$`, "m"));
  const value = match?.[1]?.trim();
  return value ? value.slice(0, 120) : null;
}

function summarizeProcessResourceSamples(
  sampler: CommandRunResourceSummary["sampler"],
  samples: ProcessResourceSnapshot[],
): CommandRunResourceSummary {
  const first = samples[0] ?? null;
  const last = samples.at(-1) ?? null;
  return {
    sampler,
    available: samples.length > 0,
    sample_count: samples.length,
    first_observed_at: first?.observed_at ?? null,
    last_observed_at: last?.observed_at ?? null,
    rss_bytes_last: last?.rss_bytes ?? null,
    rss_bytes_peak: maxNullable(
      samples.flatMap((sample) => [sample.rss_bytes, sample.peak_rss_bytes]),
    ),
    vms_bytes_last: last?.vms_bytes ?? null,
    vms_bytes_peak: maxNullable(samples.map((sample) => sample.vms_bytes)),
    threads_last: last?.threads ?? null,
    threads_peak: maxNullable(samples.map((sample) => sample.threads)),
    cpu_user_ticks_last: last?.cpu_user_ticks ?? null,
    cpu_system_ticks_last: last?.cpu_system_ticks ?? null,
    cpu_total_ticks_last: last?.cpu_total_ticks ?? null,
  };
}

function summarizeProcessTreeSamples(
  sampler: CommandRunProcessTreeSummary["sampler"],
  rootPid: number | null,
  samples: ProcessTreeSnapshot[],
): CommandRunProcessTreeSummary {
  const first = samples[0] ?? null;
  const last = samples.at(-1) ?? null;
  const peak =
    samples.reduce<ProcessTreeSnapshot | null>((current, sample) => {
      if (!current) return sample;
      if (sample.nodes.length > current.nodes.length) return sample;
      if (
        sample.nodes.length === current.nodes.length &&
        maxTreeDepth(sample.nodes) > maxTreeDepth(current.nodes)
      ) {
        return sample;
      }
      return current;
    }, null) ?? null;
  const observedPidSet = new Set<number>();
  for (const sample of samples) {
    for (const node of sample.nodes) observedPidSet.add(node.pid);
  }
  const observedPids = Array.from(observedPidSet).sort((a, b) => a - b);
  const directChildCountLast = countDirectChildren(last?.nodes ?? []);
  const directChildCountPeak = maxNullable(
    samples.map((sample) => countDirectChildren(sample.nodes)),
  );
  const descendantCountPeak = maxNullable(
    samples.map((sample) => sample.nodes.length),
  );
  const maxDepthPeak = maxNullable(
    samples.map((sample) => maxTreeDepth(sample.nodes)),
  );
  const truncated =
    samples.some((sample) => sample.truncated) ||
    observedPids.length > MAX_PROCESS_TREE_NODES;

  return {
    sampler,
    available: samples.length > 0,
    sample_count: samples.length,
    root_pid: rootPid,
    first_observed_at: first?.observed_at ?? null,
    last_observed_at: last?.observed_at ?? null,
    descendant_count_last: last?.nodes.length ?? 0,
    descendant_count_peak: descendantCountPeak ?? 0,
    direct_child_count_last: directChildCountLast,
    direct_child_count_peak: directChildCountPeak ?? 0,
    max_depth_peak: maxDepthPeak ?? 0,
    observed_pid_count: observedPids.length,
    observed_pids: observedPids.slice(0, MAX_PROCESS_TREE_NODES),
    last_tree: last?.nodes ?? [],
    peak_tree: peak?.nodes ?? [],
    truncated,
  };
}

function countDirectChildren(nodes: CommandRunProcessTreeNode[]): number {
  return nodes.filter((node) => node.depth === 1).length;
}

function maxTreeDepth(nodes: CommandRunProcessTreeNode[]): number {
  return maxNullable(nodes.map((node) => node.depth)) ?? 0;
}

function snapshotBuildArtifacts(cwd: string): ArtifactSnapshot {
  const files = new Map<string, ArtifactSnapshotFile>();
  const scannedRoots: string[] = [];
  let truncated = false;

  for (const root of ARTIFACT_ROOTS) {
    const absoluteRoot = resolve(cwd, root);
    if (!isPathInside(cwd, absoluteRoot)) continue;
    try {
      const stat = lstatSync(absoluteRoot);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    scannedRoots.push(root);
    truncated = scanArtifactRoot(cwd, absoluteRoot, files) || truncated;
    if (files.size >= MAX_ARTIFACT_FILES) {
      truncated = true;
      break;
    }
  }

  return {
    files,
    scanned_roots: scannedRoots,
    truncated,
  };
}

function discoverChangedArtifacts(
  cwd: string,
  before: ArtifactSnapshot,
  runId: string,
): CommandRunArtifactSummary {
  const after = snapshotBuildArtifacts(cwd);
  const artifacts: CommandRunArtifactInfo[] = [];
  const afterFiles = Array.from(after.files.values()).sort((a, b) =>
    a.path.localeCompare(b.path),
  );

  for (const file of afterFiles) {
    const previous = before.files.get(file.path);
    const changed = !previous
      ? "created"
      : previous.size_bytes !== file.size_bytes ||
          previous.mtime_ms !== file.mtime_ms
        ? "modified"
        : null;
    if (!changed) continue;
    artifacts.push({
      artifact_id: artifactIdForRun(runId, file.path),
      path: file.path,
      artifact_type: classifyArtifactType(file.path),
      size_bytes: file.size_bytes,
      content_hash: hashArtifactFile(cwd, file),
      changed,
      mtime_ms: file.mtime_ms,
    });
    if (artifacts.length >= MAX_ARTIFACT_FILES) break;
  }

  const artifactsByPath = new Map(
    artifacts.map((artifact) => [artifact.path, artifact]),
  );
  for (const artifact of artifacts) {
    if (artifact.artifact_type !== "source_map") continue;
    const file = after.files.get(artifact.path);
    if (!file) continue;
    artifact.source_map = inspectSourceMapFile(cwd, file, artifact, {
      hasArtifactPath: (path) => after.files.has(path),
      artifactIdForPath: (path) =>
        artifactsByPath.get(path)?.artifact_id ?? artifactIdForRun(runId, path),
    });
  }

  const scannedRoots = Array.from(
    new Set([...before.scanned_roots, ...after.scanned_roots]),
  ).sort();
  const truncated =
    before.truncated ||
    after.truncated ||
    afterFiles.length > MAX_ARTIFACT_FILES ||
    artifacts.length >= MAX_ARTIFACT_FILES;

  return {
    scanner: "common-output-roots",
    available: scannedRoots.length > 0,
    scanned_roots: scannedRoots,
    discovered_count: artifacts.length,
    emitted_count: artifacts.length,
    truncated,
    artifacts,
  };
}

function scanArtifactRoot(
  cwd: string,
  absolutePath: string,
  files: Map<string, ArtifactSnapshotFile>,
): boolean {
  if (files.size >= MAX_ARTIFACT_FILES) return true;
  let entries: Dirent[];
  try {
    entries = readdirSync(absolutePath, { withFileTypes: true });
  } catch {
    return false;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  let truncated = false;

  for (const entry of entries) {
    if (files.size >= MAX_ARTIFACT_FILES) {
      truncated = true;
      break;
    }
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const childPath = join(absolutePath, entry.name);
    let stat: Stats;
    try {
      stat = lstatSync(childPath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      if (entry.name === "cache" || entry.name === ".cache") continue;
      truncated = scanArtifactRoot(cwd, childPath, files) || truncated;
      continue;
    }
    if (!stat.isFile()) continue;
    const relativePath = toSafeRelativePath(cwd, childPath);
    if (!relativePath) continue;
    files.set(relativePath, {
      path: relativePath,
      absolute_path: childPath,
      size_bytes: stat.size,
      mtime_ms: stat.mtimeMs,
      dev: stat.dev,
      ino: stat.ino,
    });
  }

  return truncated;
}

function toSafeRelativePath(cwd: string, absolutePath: string): string | null {
  if (!isPathInside(cwd, absolutePath)) return null;
  const value = relative(cwd, absolutePath).split(sep).join("/");
  if (!value || value.startsWith("..") || value.includes("\0")) return null;
  return value;
}

function isPathInside(root: string, child: string): boolean {
  const relativePath = relative(root, child);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !relativePath.startsWith(sep))
  );
}

function classifyArtifactType(path: string): string {
  const normalized = path.toLowerCase();
  if (normalized.endsWith(".map")) return "source_map";
  if (normalized.includes("/coverage/") || normalized.startsWith("coverage/"))
    return "coverage";
  const extension = extname(normalized);
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs")
    return "javascript";
  if (extension === ".css") return "stylesheet";
  if (extension === ".html") return "html";
  if (extension === ".json") return "json";
  if (extension === ".wasm") return "wasm";
  return "file";
}

function inspectSourceMapFile(
  cwd: string,
  file: ArtifactSnapshotFile,
  artifact: CommandRunArtifactInfo,
  links: {
    hasArtifactPath(path: string): boolean;
    artifactIdForPath(path: string): string;
  },
): CommandRunSourceMapInfo {
  const inferred = inferSourceMapJavascriptPath(file.path, null);
  const base = (
    validation_status: CommandRunSourceMapInfo["validation_status"],
    validation_error: string | null,
    extra: Partial<CommandRunSourceMapInfo> = {},
  ): CommandRunSourceMapInfo => {
    const javascriptPath = extra.javascript_path ?? inferred.javascript_path;
    return {
      source_map_id: artifact.artifact_id,
      source_map_artifact_id: artifact.artifact_id,
      source_map_path: artifact.path,
      javascript_artifact_id:
        extra.javascript_artifact_id ??
        (javascriptPath && links.hasArtifactPath(javascriptPath)
          ? links.artifactIdForPath(javascriptPath)
          : null),
      javascript_path: javascriptPath,
      linked_by: extra.linked_by ?? inferred.linked_by,
      version: extra.version ?? null,
      validation_status,
      validation_error,
      file: extra.file ?? null,
      source_root: extra.source_root ?? null,
      source_count: extra.source_count ?? 0,
      names_count: extra.names_count ?? 0,
      mappings_length: extra.mappings_length ?? 0,
      has_sources_content: extra.has_sources_content ?? false,
      sources: extra.sources ?? [],
      truncated: extra.truncated ?? false,
      source_storage_policy: "paths_and_hashes_only",
    };
  };

  if (file.size_bytes > MAX_SOURCE_MAP_BYTES)
    return base("too_large", "source map exceeds bounded parser size");

  const text = readArtifactText(cwd, file);
  if (text === null) return base("malformed", "source map could not be read");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return base("malformed", "source map JSON is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return base("malformed", "source map root must be an object");

  const map = parsed as Record<string, unknown>;
  const version =
    typeof map.version === "number" ? Math.trunc(map.version) : null;
  const rawFileField = typeof map.file === "string" ? map.file : null;
  const fileField = sanitizeSourceMapPathValue(map.file);
  const linked = inferSourceMapJavascriptPath(file.path, rawFileField, (path) =>
    links.hasArtifactPath(path),
  );
  const javascriptPath = linked.javascript_path;
  const javascriptArtifactId =
    javascriptPath && links.hasArtifactPath(javascriptPath)
      ? links.artifactIdForPath(javascriptPath)
      : null;
  const sourceRoot = sanitizeSourceMapPathValue(map.sourceRoot);
  const rawSources = Array.isArray(map.sources) ? map.sources : null;
  const rawNames = Array.isArray(map.names) ? map.names : [];
  const mappings = typeof map.mappings === "string" ? map.mappings : null;

  if (version !== 3)
    return base("unsupported", "source map version must be 3", {
      file: fileField,
      javascript_artifact_id: javascriptArtifactId,
      javascript_path: javascriptPath,
      linked_by: linked.linked_by,
      version,
      source_root: sourceRoot,
    });
  if (!rawSources)
    return base("malformed", "source map sources must be an array", {
      file: fileField,
      javascript_artifact_id: javascriptArtifactId,
      javascript_path: javascriptPath,
      linked_by: linked.linked_by,
      version,
      source_root: sourceRoot,
    });
  if (mappings === null)
    return base("malformed", "source map mappings must be a string", {
      file: fileField,
      javascript_artifact_id: javascriptArtifactId,
      javascript_path: javascriptPath,
      linked_by: linked.linked_by,
      version,
      source_root: sourceRoot,
      source_count: rawSources.length,
      names_count: rawNames.length,
    });

  const rawSourcesContent = Array.isArray(map.sourcesContent)
    ? map.sourcesContent
    : [];
  const sources: CommandRunSourceMapSource[] = [];
  for (const [ordinal, source] of rawSources.entries()) {
    if (sources.length >= MAX_SOURCE_MAP_SOURCES) break;
    const content = rawSourcesContent[ordinal];
    sources.push({
      ordinal,
      source_path: sanitizeSourceMapPathValue(source),
      has_content: typeof content === "string",
      content_hash:
        typeof content === "string"
          ? createHash("sha256").update(content).digest("hex")
          : null,
    });
  }

  return base("parsed", null, {
    file: fileField,
    javascript_artifact_id: javascriptArtifactId,
    javascript_path: javascriptPath,
    linked_by: linked.linked_by,
    version,
    source_root: sourceRoot,
    source_count: rawSources.length,
    names_count: rawNames.length,
    mappings_length: mappings.length,
    has_sources_content: rawSourcesContent.some(
      (content) => typeof content === "string",
    ),
    sources,
    truncated: rawSources.length > MAX_SOURCE_MAP_SOURCES,
  });
}

function readArtifactText(
  cwd: string,
  file: ArtifactSnapshotFile,
): string | null {
  if (file.size_bytes > MAX_SOURCE_MAP_BYTES) return null;
  if (!isPathInside(cwd, file.absolute_path)) return null;
  let fd: number | null = null;
  try {
    const noFollow =
      typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(file.absolute_path, fsConstants.O_RDONLY | noFollow);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.dev !== file.dev ||
      stat.ino !== file.ino ||
      stat.size !== file.size_bytes
    )
      return null;
    return readFileSync(fd, "utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function inferSourceMapJavascriptPath(
  sourceMapPath: string,
  fileField: string | null,
  hasArtifactPath?: (path: string) => boolean,
): {
  javascript_path: string | null;
  linked_by: CommandRunSourceMapInfo["linked_by"];
} {
  const adjacent = sourceMapPath.endsWith(".map")
    ? normalizeRelativeArtifactPath(sourceMapPath.slice(0, -".map".length))
    : null;
  const fileCandidate = fileField
    ? normalizeSourceMapFileCandidate(sourceMapPath, fileField)
    : null;
  if (adjacent && fileCandidate && adjacent === fileCandidate)
    return { javascript_path: adjacent, linked_by: "adjacent_path" };
  if (hasArtifactPath) {
    if (adjacent && hasArtifactPath(adjacent))
      return { javascript_path: adjacent, linked_by: "adjacent_path" };
    if (fileCandidate && hasArtifactPath(fileCandidate))
      return { javascript_path: fileCandidate, linked_by: "file_field" };
  }
  if (sourceMapPath.endsWith(".map")) {
    if (adjacent)
      return { javascript_path: adjacent, linked_by: "adjacent_path" };
  }
  if (fileCandidate)
    return { javascript_path: fileCandidate, linked_by: "file_field" };
  return { javascript_path: null, linked_by: "none" };
}

function normalizeSourceMapFileCandidate(
  sourceMapPath: string,
  fileField: string,
): string | null {
  const normalizedFile = normalizeRelativeArtifactPath(fileField);
  if (!normalizedFile) return null;
  const directory = dirname(sourceMapPath).split(sep).join("/");
  const joined =
    directory === "." || directory === ""
      ? normalizedFile
      : `${directory}/${normalizedFile}`;
  return normalizeRelativeArtifactPath(joined);
}

function normalizeRelativeArtifactPath(value: string): string | null {
  const normalized = value.split("\\").join("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized)
  )
    return null;
  const parts: string[] = [];
  for (const part of normalized.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return parts.length > 0 ? parts.join("/") : null;
}

function artifactIdForRun(runId: string, path: string): string {
  return `${runId}-artifact-${createHash("sha256").update(path).digest("hex").slice(0, 16)}`;
}

function hashArtifactFile(
  cwd: string,
  file: ArtifactSnapshotFile,
): string | null {
  if (file.size_bytes > MAX_ARTIFACT_HASH_BYTES) return null;
  if (!isPathInside(cwd, file.absolute_path)) return null;
  let fd: number | null = null;
  try {
    const noFollow =
      typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(file.absolute_path, fsConstants.O_RDONLY | noFollow);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.dev !== file.dev ||
      stat.ino !== file.ino ||
      stat.size !== file.size_bytes
    )
      return null;
    return createHash("sha256").update(readFileSync(fd)).digest("hex");
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function emptyTestReportSummary(): CommandRunTestReportSummary {
  return {
    scanner: "common-test-report-roots",
    available: false,
    scanned_roots: [],
    discovered_count: 0,
    emitted_count: 0,
    truncated: false,
    reports: [],
  };
}

function snapshotTestReports(cwd: string): TestReportSnapshot {
  const files = new Map<string, TestReportSnapshotFile>();
  const scannedRoots: string[] = [];
  let truncated = false;

  for (const fileName of TEST_REPORT_ROOT_FILES) {
    const absolutePath = resolve(cwd, fileName);
    if (addTestReportSnapshotFile(cwd, absolutePath, files)) {
      if (!scannedRoots.includes(".")) scannedRoots.push(".");
    }
    if (files.size >= MAX_TEST_REPORT_FILES) {
      truncated = true;
      break;
    }
  }

  for (const root of TEST_REPORT_ROOTS) {
    if (files.size >= MAX_TEST_REPORT_FILES) {
      truncated = true;
      break;
    }
    const absoluteRoot = resolve(cwd, root);
    if (!isPathInside(cwd, absoluteRoot)) continue;
    try {
      const stat = lstatSync(absoluteRoot);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    scannedRoots.push(root);
    truncated = scanTestReportRoot(cwd, absoluteRoot, files, 0) || truncated;
  }

  return {
    files,
    scanned_roots: Array.from(new Set(scannedRoots)).sort(),
    truncated,
  };
}

function discoverChangedTestReports(
  cwd: string,
  before: TestReportSnapshot,
  runId: string,
  runType: CommandRunType,
): CommandRunTestReportSummary {
  if (runType !== "test") return emptyTestReportSummary();

  const after = snapshotTestReports(cwd);
  const reports: CommandRunTestReportInfo[] = [];
  const afterFiles = Array.from(after.files.values()).sort((a, b) =>
    a.path.localeCompare(b.path),
  );

  for (const file of afterFiles) {
    const previous = before.files.get(file.path);
    const changed = !previous
      ? "created"
      : didTestReportChange(previous, file)
        ? "modified"
        : null;
    if (!changed) continue;
    reports.push(parseJunitTestReportFile(cwd, file, runId, changed));
    if (reports.length >= MAX_TEST_REPORT_FILES) break;
  }

  const scannedRoots = Array.from(
    new Set([...before.scanned_roots, ...after.scanned_roots]),
  ).sort();
  const truncated =
    before.truncated ||
    after.truncated ||
    afterFiles.length > MAX_TEST_REPORT_FILES ||
    reports.length >= MAX_TEST_REPORT_FILES ||
    reports.some((report) => report.truncated);

  return {
    scanner: "common-test-report-roots",
    available: scannedRoots.length > 0,
    scanned_roots: scannedRoots,
    discovered_count: reports.length,
    emitted_count: reports.length,
    truncated,
    reports,
  };
}

function didTestReportChange(
  previous: TestReportSnapshotFile,
  current: TestReportSnapshotFile,
): boolean {
  if (previous.content_hash && current.content_hash)
    return previous.content_hash !== current.content_hash;
  return (
    previous.size_bytes !== current.size_bytes ||
    previous.mtime_ms !== current.mtime_ms ||
    previous.dev !== current.dev ||
    previous.ino !== current.ino
  );
}

function scanTestReportRoot(
  cwd: string,
  absolutePath: string,
  files: Map<string, TestReportSnapshotFile>,
  depth: number,
): boolean {
  if (files.size >= MAX_TEST_REPORT_FILES) return true;
  if (depth > MAX_TEST_REPORT_SCAN_DEPTH) return true;
  let entries: Dirent[];
  try {
    entries = readdirSync(absolutePath, { withFileTypes: true });
  } catch {
    return false;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  let truncated = false;

  for (const entry of entries) {
    if (files.size >= MAX_TEST_REPORT_FILES) {
      truncated = true;
      break;
    }
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    if (entry.name === "cache" || entry.name === ".cache") continue;
    const childPath = join(absolutePath, entry.name);
    let stat: Stats;
    try {
      stat = lstatSync(childPath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      truncated =
        scanTestReportRoot(cwd, childPath, files, depth + 1) || truncated;
      continue;
    }
    if (!stat.isFile()) continue;
    addTestReportSnapshotFile(cwd, childPath, files, stat);
  }

  return truncated;
}

function addTestReportSnapshotFile(
  cwd: string,
  absolutePath: string,
  files: Map<string, TestReportSnapshotFile>,
  knownStat?: Stats,
): boolean {
  if (files.size >= MAX_TEST_REPORT_FILES) return false;
  const relativePath = toSafeRelativePath(cwd, absolutePath);
  if (!relativePath || !isTestReportPath(relativePath)) return false;
  let stat: Stats;
  try {
    stat = knownStat ?? lstatSync(absolutePath);
  } catch {
    return false;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return false;
  files.set(relativePath, {
    path: relativePath,
    absolute_path: absolutePath,
    size_bytes: stat.size,
    mtime_ms: stat.mtimeMs,
    dev: stat.dev,
    ino: stat.ino,
    content_hash: hashTestReportFile(cwd, {
      path: relativePath,
      absolute_path: absolutePath,
      size_bytes: stat.size,
      mtime_ms: stat.mtimeMs,
      dev: stat.dev,
      ino: stat.ino,
      content_hash: null,
    }),
  });
  return true;
}

function isTestReportPath(path: string): boolean {
  const normalized = path.toLowerCase();
  if (!normalized.endsWith(".xml")) return false;
  const name = basename(normalized);
  if (TEST_REPORT_ROOT_FILES.includes(name)) return true;
  if (name === "test.xml" || name === "results.xml") return true;
  if (name.startsWith("test-") || name.startsWith("junit")) return true;
  return (
    normalized.includes("/junit") ||
    normalized.includes("/test-results/") ||
    normalized.includes("/surefire-reports/") ||
    normalized.includes("/failsafe-reports/")
  );
}

function parseJunitTestReportFile(
  cwd: string,
  file: TestReportSnapshotFile,
  runId: string,
  changed: "created" | "modified",
): CommandRunTestReportInfo {
  const base = baseTestReportInfo(file, runId, changed);
  if (file.size_bytes > MAX_TEST_REPORT_BYTES) {
    return {
      ...base,
      parse_status: "too_large",
      parse_error: "test report exceeds parser byte limit",
      truncated: true,
    };
  }

  const xml = readSnapshotFileText(cwd, file, MAX_TEST_REPORT_BYTES);
  if (xml === null) {
    return {
      ...base,
      parse_status: "malformed",
      parse_error: "test report could not be read safely",
    };
  }
  if (hasUnsafeXmlDeclarations(xml)) {
    return {
      ...base,
      parse_status: "unsafe",
      parse_error: "test report contains disallowed DTD or entity declarations",
    };
  }

  const validation = XMLValidator.validate(xml, {
    allowBooleanAttributes: false,
    unpairedTags: [],
  });
  if (validation !== true) {
    return {
      ...base,
      parse_status: "malformed",
      parse_error: safeParserError(validation),
    };
  }

  try {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: true,
      removeNSPrefix: true,
      allowBooleanAttributes: false,
      processEntities: false,
      maxNestedTags: 32,
      isArray: (name) =>
        name === "testsuite" ||
        name === "testcase" ||
        name === "failure" ||
        name === "error" ||
        name === "skipped",
    });
    const parsed = parser.parse(xml, false) as unknown;
    if (countXmlObjectNodes(parsed) > MAX_TEST_REPORT_NODES) {
      return {
        ...base,
        parse_status: "too_large",
        parse_error: "test report exceeds parser node limit",
        truncated: true,
      };
    }
    const parsedReport = extractJunitReport(parsed, cwd);
    if (!parsedReport) {
      return {
        ...base,
        parse_status: "unsupported",
        parse_error: "no supported JUnit testsuite elements found",
      };
    }
    return {
      ...base,
      ...parsedReport,
      parse_status: "parsed",
      parse_error: null,
    };
  } catch (error) {
    return {
      ...base,
      parse_status: "malformed",
      parse_error: safeSnippet(
        error instanceof Error ? error.message : String(error),
      ),
    };
  }
}

function baseTestReportInfo(
  file: TestReportSnapshotFile,
  runId: string,
  changed: "created" | "modified",
): CommandRunTestReportInfo {
  return {
    report_id: testReportIdForRun(runId, file.path),
    path: file.path,
    format: "junit_xml",
    parser: "junit-xml-v1",
    parse_status: "malformed",
    parse_error: null,
    size_bytes: file.size_bytes,
    content_hash: file.content_hash,
    changed,
    mtime_ms: file.mtime_ms,
    tests: 0,
    failures: 0,
    errors: 0,
    skipped: 0,
    time_seconds: null,
    suite_count: 0,
    testcase_count: 0,
    suites: [],
    truncated: false,
  };
}

function extractJunitReport(
  parsed: unknown,
  cwd: string,
): Pick<
  CommandRunTestReportInfo,
  | "tests"
  | "failures"
  | "errors"
  | "skipped"
  | "time_seconds"
  | "suite_count"
  | "testcase_count"
  | "suites"
  | "truncated"
> | null {
  const root = objectRecordLocal(parsed);
  const rootSuites = objectRecordLocal(root.testsuites);
  const suiteNodes = [
    ...asObjectArray(root.testsuite),
    ...asObjectArray(rootSuites.testsuite),
  ];
  if (suiteNodes.length === 0) return null;

  const collectedSuites: CommandRunTestSuiteSummary[] = [];
  let totalCases = 0;
  let storedCases = 0;
  let truncated = suiteNodes.length > MAX_TEST_REPORT_SUITES;
  const suiteSummaries = suiteNodes.flatMap((suite) =>
    summarizeJunitSuite(suite, cwd),
  );

  for (const suite of suiteSummaries) {
    totalCases += suite.testcase_count;
    const remainingSuites = MAX_TEST_REPORT_SUITES - collectedSuites.length;
    if (remainingSuites <= 0) {
      truncated = true;
      continue;
    }
    const remainingCases = MAX_TEST_REPORT_CASES - storedCases;
    const cases = suite.cases.slice(0, Math.max(0, remainingCases));
    if (cases.length < suite.cases.length) truncated = true;
    storedCases += cases.length;
    collectedSuites.push({
      ...suite,
      cases,
      truncated: suite.truncated || cases.length < suite.cases.length,
    });
  }

  const summed = summarizeSuites(suiteSummaries);
  return {
    tests: numberAttributeLocal(rootSuites, "tests") ?? summed.tests,
    failures: numberAttributeLocal(rootSuites, "failures") ?? summed.failures,
    errors: numberAttributeLocal(rootSuites, "errors") ?? summed.errors,
    skipped:
      numberAttributeLocal(rootSuites, "skipped") ??
      numberAttributeLocal(rootSuites, "disabled") ??
      summed.skipped,
    time_seconds:
      numberAttributeLocal(rootSuites, "time") ?? summed.time_seconds,
    suite_count: suiteSummaries.length,
    testcase_count: totalCases,
    suites: collectedSuites,
    truncated,
  };
}

function summarizeJunitSuite(
  suite: Record<string, unknown>,
  cwd: string,
): CommandRunTestSuiteSummary[] {
  const nestedSuites = asObjectArray(suite.testsuite).flatMap((child) =>
    summarizeJunitSuite(child, cwd),
  );
  const testcases = asObjectArray(suite.testcase);
  const failedCases: CommandRunTestCaseSummary[] = [];
  let failureCount = 0;
  let errorCount = 0;
  let skippedCount = 0;

  for (const testcase of testcases) {
    const status = junitCaseStatus(testcase);
    if (status === "failed") failureCount += 1;
    if (status === "error") errorCount += 1;
    if (status === "skipped") skippedCount += 1;
    if (status === "passed") continue;
    failedCases.push({
      name: safeReportString(testcase.name),
      classname: safeReportString(testcase.classname),
      file: safeReportFile(cwd, testcase.file),
      status,
      time_seconds: numberAttributeLocal(testcase, "time"),
    });
  }

  const self: CommandRunTestSuiteSummary = {
    name: safeReportString(suite.name),
    tests: numberAttributeLocal(suite, "tests") ?? testcases.length,
    failures: numberAttributeLocal(suite, "failures") ?? failureCount,
    errors: numberAttributeLocal(suite, "errors") ?? errorCount,
    skipped:
      numberAttributeLocal(suite, "skipped") ??
      numberAttributeLocal(suite, "disabled") ??
      skippedCount,
    time_seconds: numberAttributeLocal(suite, "time"),
    testcase_count: testcases.length,
    cases: failedCases,
    truncated: failedCases.length > MAX_TEST_REPORT_CASES,
  };

  return [self, ...nestedSuites];
}

function junitCaseStatus(
  testcase: Record<string, unknown>,
): CommandRunTestCaseSummary["status"] {
  if (asArray(testcase.error).length > 0) return "error";
  if (asArray(testcase.failure).length > 0) return "failed";
  if (asArray(testcase.skipped).length > 0) return "skipped";
  return "passed";
}

function summarizeSuites(
  suites: CommandRunTestSuiteSummary[],
): Pick<
  CommandRunTestReportInfo,
  "tests" | "failures" | "errors" | "skipped" | "time_seconds"
> {
  const timeValues = suites
    .map((suite) => suite.time_seconds)
    .filter((value): value is number => value !== null);
  return {
    tests: sumNumbers(suites.map((suite) => suite.tests)),
    failures: sumNumbers(suites.map((suite) => suite.failures)),
    errors: sumNumbers(suites.map((suite) => suite.errors)),
    skipped: sumNumbers(suites.map((suite) => suite.skipped)),
    time_seconds: timeValues.length > 0 ? sumNumbers(timeValues) : null,
  };
}

function summarizeTestReportTotals(
  reports: CommandRunTestReportSummary,
): Pick<CommandRunTestReportInfo, "tests" | "failures" | "errors" | "skipped"> {
  return {
    tests: sumNumbers(reports.reports.map((report) => report.tests)),
    failures: sumNumbers(reports.reports.map((report) => report.failures)),
    errors: sumNumbers(reports.reports.map((report) => report.errors)),
    skipped: sumNumbers(reports.reports.map((report) => report.skipped)),
  };
}

function readSnapshotFileText(
  cwd: string,
  file: ArtifactSnapshotFile,
  maxBytes: number,
): string | null {
  if (file.size_bytes > maxBytes) return null;
  if (!isPathInside(cwd, file.absolute_path)) return null;
  let fd: number | null = null;
  try {
    const noFollow =
      typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
    fd = openSync(file.absolute_path, fsConstants.O_RDONLY | noFollow);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.dev !== file.dev ||
      stat.ino !== file.ino ||
      stat.size !== file.size_bytes
    )
      return null;
    return readFileSync(fd, "utf8");
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function hashTestReportFile(
  cwd: string,
  file: TestReportSnapshotFile,
): string | null {
  const text = readSnapshotFileText(cwd, file, MAX_TEST_REPORT_BYTES);
  return text === null ? null : createHash("sha256").update(text).digest("hex");
}

function hasUnsafeXmlDeclarations(xml: string): boolean {
  const lower = xml.toLowerCase();
  return lower.includes("<!doctype") || lower.includes("<!entity");
}

function safeParserError(error: unknown): string {
  const record = objectRecordLocal(error);
  const err = objectRecordLocal(record.err);
  const code = typeof err.code === "string" ? err.code : "InvalidXml";
  const msg = typeof err.msg === "string" ? err.msg : "invalid XML";
  return safeSnippet(`${code}: ${msg}`);
}

function countXmlObjectNodes(value: unknown, seen = { count: 0 }): number {
  if (!value || typeof value !== "object") return seen.count;
  seen.count += 1;
  if (seen.count > MAX_TEST_REPORT_NODES) return seen.count;
  if (Array.isArray(value)) {
    for (const item of value) {
      countXmlObjectNodes(item, seen);
      if (seen.count > MAX_TEST_REPORT_NODES) break;
    }
    return seen.count;
  }
  for (const child of Object.values(value as Record<string, unknown>)) {
    countXmlObjectNodes(child, seen);
    if (seen.count > MAX_TEST_REPORT_NODES) break;
  }
  return seen.count;
}

function safeReportString(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = stripAnsi(String(value)).replace(/\s+/g, " ").trim();
  const text = redactString(normalized, "test_report").value.slice(
    0,
    MAX_TEST_REPORT_STRING,
  );
  if (!text) return null;
  return text;
}

function safeReportFile(cwd: string, value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.split("\\").join("/");
  const absoluteLike = normalized.startsWith("/");
  if (absoluteLike) {
    const safeRelative = toSafeRelativePath(cwd, resolve(normalized));
    return safeReportString(safeRelative ?? basename(normalized));
  }
  const withoutDotSegments = normalized
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  return safeReportString(withoutDotSegments || basename(normalized));
}

function asObjectArray(value: unknown): Array<Record<string, unknown>> {
  return asArray(value).filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function objectRecordLocal(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberAttributeLocal(
  attrs: Record<string, unknown>,
  key: string,
): number | null {
  const value = attrs[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function sumNumbers(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

function testReportIdForRun(runId: string, path: string): string {
  return `${runId}-test-report-${createHash("sha256").update(path).digest("hex").slice(0, 16)}`;
}

function maxNullable(values: Array<number | null>): number | null {
  const numeric = values.filter((value): value is number => value !== null);
  if (numeric.length === 0) return null;
  return Math.max(...numeric);
}

function numericField(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function randomId(): string {
  return randomBytes(12).toString("hex");
}

function existingProjectId(
  db: Database,
  projectId: string | undefined,
): string | null {
  if (!projectId) return null;
  const row = db
    .prepare("SELECT id FROM projects WHERE id = ?")
    .get(projectId) as { id: string } | null;
  return row?.id ?? null;
}
