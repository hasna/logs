import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function runCli(args: string[], dataDir: string) {
  return spawnSync("bun", ["src/cli/index.ts", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      HASNA_LOGS_DATA_DIR: dataDir,
      HASNA_LOGS_DB_PATH: join(dataDir, "logs.db"),
      HASNA_LOGS_FSYNC: "0",
    },
  });
}

describe("logs events CLI", () => {
  test("pushes a raw-first universal event", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "open-logs-events-push-cli-"));
    try {
      const push = runCli(
        [
          "events",
          "push",
          "--type",
          "span",
          "--id",
          "cli-universal-span-1",
          "--source",
          "otel",
          "--severity",
          "info",
          "--message",
          "cli span",
          "--environment",
          "test",
          "--trace",
          "cli-universal-trace",
          "--span",
          "cli-universal-span",
          "--attributes",
          JSON.stringify({
            name: "cli span",
            operation: "cli.test",
            duration_ms: 5,
          }),
        ],
        dataDir,
      );
      expect(push.status).toBe(0);
      expect(push.stdout).toContain("Event logged: cli-universal-span-1");

      const get = runCli(["events", "get", "cli-universal-span-1"], dataDir);
      expect(get.status).toBe(0);
      const event = JSON.parse(get.stdout) as {
        event_id: string;
        event_type: string;
        raw?: { trace_id?: string | null };
      };
      expect(event.event_id).toBe("cli-universal-span-1");
      expect(event.event_type).toBe("span");
      expect(event.raw?.trace_id).toBe("cli-universal-trace");

      const db = new Database(join(dataDir, "logs.db"));
      try {
        const record = db
          .prepare(
            "SELECT machine_id, repo_id, app_id, environment FROM event_records WHERE event_id = ?",
          )
          .get("cli-universal-span-1") as {
          machine_id: string | null;
          repo_id: string | null;
          app_id: string | null;
          environment: string | null;
        } | null;
        const machineId = record?.machine_id;
        const appId = record?.app_id;
        expect(machineId).toStartWith("machine_");
        expect(appId).toStartWith("app_");
        if (!machineId || !appId)
          throw new Error(
            "Expected events push to detect machine and app identity",
          );
        expect(record?.environment).toBe("test");
        expect(
          db
            .prepare("SELECT COUNT(*) AS count FROM machines WHERE id = ?")
            .get(machineId) as { count: number },
        ).toEqual({ count: 1 });
        expect(
          db
            .prepare("SELECT COUNT(*) AS count FROM apps WHERE id = ?")
            .get(appId) as { count: number },
        ).toEqual({ count: 1 });
        if (record?.repo_id) {
          expect(
            db
              .prepare(
                "SELECT COUNT(*) AS count FROM repositories WHERE id = ?",
              )
              .get(record.repo_id) as { count: number },
          ).toEqual({ count: 1 });
        }
      } finally {
        db.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("events push validates before local identity mutation", () => {
    const dataDir = mkdtempSync(
      join(tmpdir(), "open-logs-events-invalid-identity-cli-"),
    );
    try {
      const push = runCli(
        [
          "events",
          "push",
          "--type",
          "span",
          "--id",
          "cli-invalid-identity-mutation",
          "--severity",
          "bogus",
        ],
        dataDir,
      );
      expect(push.status).toBe(1);
      expect(push.stderr).toContain("severity");

      const db = new Database(join(dataDir, "logs.db"));
      try {
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM event_records").get() as {
            count: number;
          },
        ).toEqual({ count: 0 });
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM machines").get() as {
            count: number;
          },
        ).toEqual({ count: 0 });
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM repositories").get() as {
            count: number;
          },
        ).toEqual({ count: 0 });
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM apps").get() as {
            count: number;
          },
        ).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("events push skips local discovery when explicit identity is supplied", () => {
    const dataDir = mkdtempSync(
      join(tmpdir(), "open-logs-events-explicit-identity-cli-"),
    );
    try {
      const push = runCli(
        [
          "events",
          "push",
          "--type",
          "metric",
          "--id",
          "cli-explicit-identity",
          "--machine",
          "machine_external",
          "--repo",
          "repo_external",
          "--app",
          "app_external",
          "--environment",
          "external",
        ],
        dataDir,
      );
      expect(push.status).toBe(0);

      const db = new Database(join(dataDir, "logs.db"));
      try {
        const record = db
          .prepare(
            "SELECT machine_id, repo_id, app_id, environment FROM event_records WHERE event_id = ?",
          )
          .get("cli-explicit-identity") as {
          machine_id: string | null;
          repo_id: string | null;
          app_id: string | null;
          environment: string | null;
        } | null;
        expect(record).toEqual({
          machine_id: "machine_external",
          repo_id: "repo_external",
          app_id: "app_external",
          environment: "external",
        });
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM machines").get() as {
            count: number;
          },
        ).toEqual({ count: 0 });
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM repositories").get() as {
            count: number;
          },
        ).toEqual({ count: 0 });
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM apps").get() as {
            count: number;
          },
        ).toEqual({ count: 0 });
      } finally {
        db.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("events push does not pass unknown project IDs into identity upserts", () => {
    const dataDir = mkdtempSync(
      join(tmpdir(), "open-logs-events-unknown-project-cli-"),
    );
    try {
      const push = runCli(
        [
          "events",
          "push",
          "--type",
          "metric",
          "--id",
          "cli-unknown-project-identity",
          "--project",
          "missing-project",
        ],
        dataDir,
      );
      expect(push.status).toBe(0);

      const db = new Database(join(dataDir, "logs.db"));
      try {
        const record = db
          .prepare(
            "SELECT project_id, app_id FROM event_records WHERE event_id = ?",
          )
          .get("cli-unknown-project-identity") as {
          project_id: string | null;
          app_id: string | null;
        } | null;
        expect(record?.project_id).toBeNull();
        if (record?.app_id) {
          const app = db
            .prepare("SELECT project_id FROM apps WHERE id = ?")
            .get(record.app_id) as { project_id: string | null } | null;
          expect(app?.project_id).toBeNull();
        }
      } finally {
        db.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("lists, gets, and exports raw-backed event catalog records", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "open-logs-events-cli-"));
    try {
      const push = runCli(
        [
          "push",
          "event catalog cli needle",
          "--id",
          "cli-event-catalog-1",
          "--level",
          "warn",
          "--service",
          "cli-events",
          "--trace",
          "cli-event-trace",
        ],
        dataDir,
      );
      expect(push.status).toBe(0);

      const list = runCli(
        [
          "events",
          "list",
          "--type",
          "log",
          "--source",
          "sdk",
          "--severity",
          "warn",
          "--trace",
          "cli-event-trace",
          "--text",
          "needle",
          "--format",
          "json",
        ],
        dataDir,
      );
      expect(list.status).toBe(0);
      const rows = JSON.parse(list.stdout) as Array<{
        event_id: string;
        metadata: unknown;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.event_id).toBe("cli-event-catalog-1");

      const get = runCli(["events", "get", "cli-event-catalog-1"], dataDir);
      expect(get.status).toBe(0);
      const one = JSON.parse(get.stdout) as {
        event_id: string;
        raw?: { event_id: string; message?: string };
      };
      expect(one.event_id).toBe("cli-event-catalog-1");
      expect(one.raw?.event_id).toBe("cli-event-catalog-1");

      const exported = runCli(
        ["events", "export", "--trace", "cli-event-trace", "--include-raw"],
        dataDir,
      );
      expect(exported.status).toBe(0);
      const body = JSON.parse(exported.stdout) as Array<{
        event_id: string;
        raw?: { trace_id?: string | null };
      }>;
      expect(body).toHaveLength(1);
      expect(body[0]?.raw?.trace_id).toBe("cli-event-trace");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("queries projected test reports", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "open-logs-test-reports-cli-"));
    try {
      const push = runCli(
        [
          "events",
          "push",
          "--type",
          "build",
          "--id",
          "cli-test-report-event",
          "--source",
          "test",
          "--severity",
          "error",
          "--run",
          "run-cli-test-report",
          "--process",
          "proc-cli-test-report",
          "--attributes",
          JSON.stringify({ category: "test_report", scanner: "cli-test" }),
          "--body",
          JSON.stringify({
            test_report: {
              report_id: "report-cli-test",
              path: "test-results/cli.xml",
              parser: "junit-xml-v1",
              parse_status: "parsed",
              tests: 1,
              failures: 1,
              errors: 0,
              skipped: 0,
              suite_count: 1,
              testcase_count: 1,
              suites: [
                {
                  name: "cli suite",
                  cases: [
                    {
                      name: "fails over cli",
                      classname: "cli.Case",
                      status: "failed",
                    },
                  ],
                },
              ],
            },
          }),
        ],
        dataDir,
      );
      expect(push.status).toBe(0);

      const aggregatePush = runCli(
        [
          "events",
          "push",
          "--type",
          "build",
          "--id",
          "cli-aggregate-test-report-event",
          "--source",
          "test",
          "--severity",
          "error",
          "--run",
          "run-cli-test-report",
          "--attributes",
          JSON.stringify({ category: "test_report", scanner: "cli-test" }),
          "--body",
          JSON.stringify({
            test_report: {
              report_id: "report-cli-aggregate-failed",
              path: "test-results/cli-aggregate.xml",
              parser: "external-junit",
              parse_status: "parsed",
              tests: 3,
              failures: 1,
              errors: 0,
              skipped: 0,
              testcase_count: 3,
            },
          }),
        ],
        dataDir,
      );
      expect(aggregatePush.status).toBe(0);

      const list = runCli(
        [
          "test-reports",
          "list",
          "--run",
          "run-cli-test-report",
          "--case-status",
          "failed",
          "--include-cases",
          "--format",
          "json",
        ],
        dataDir,
      );
      expect(list.status).toBe(0);
      const reports = JSON.parse(list.stdout) as Array<{
        id: string;
        cases?: Array<{ name: string; status: string }>;
      }>;
      expect(reports).toHaveLength(1);
      expect(reports[0]?.id).toBe("report-cli-test");
      expect(reports[0]?.cases?.[0]).toMatchObject({
        name: "fails over cli",
        status: "failed",
      });

      const get = runCli(["test-reports", "get", "report-cli-test"], dataDir);
      expect(get.status).toBe(0);
      const one = JSON.parse(get.stdout) as {
        event_id: string;
        cases?: unknown[];
      };
      expect(one.event_id).toBe("cli-test-report-event");
      expect(one.cases).toHaveLength(1);

      const aggregateList = runCli(
        [
          "test-reports",
          "list",
          "--run",
          "run-cli-test-report",
          "--outcome",
          "failed",
          "--text",
          "aggregate",
          "--format",
          "json",
        ],
        dataDir,
      );
      expect(aggregateList.status).toBe(0);
      const aggregateReports = JSON.parse(aggregateList.stdout) as Array<{
        id: string;
        failures: number;
        case_stored_count: number;
      }>;
      expect(aggregateReports).toEqual([
        expect.objectContaining({
          id: "report-cli-aggregate-failed",
          failures: 1,
          case_stored_count: 0,
        }),
      ]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("watches local event catalog records once as JSON", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "open-logs-events-watch-cli-"));
    try {
      expect(
        runCli(
          [
            "push",
            "watch catalog log",
            "--id",
            "cli-watch-log-1",
            "--level",
            "warn",
            "--service",
            "cli-watch",
          ],
          dataDir,
        ).status,
      ).toBe(0);
      expect(
        runCli(
          [
            "events",
            "push",
            "--type",
            "metric",
            "--id",
            "cli-watch-metric-1",
            "--source",
            "sdk",
            "--message",
            "watch catalog metric",
          ],
          dataDir,
        ).status,
      ).toBe(0);

      const watch = runCli(
        [
          "watch",
          "--events",
          "--type",
          "log,metric",
          "--since",
          "1h",
          "--once",
          "--format",
          "json",
        ],
        dataDir,
      );
      expect(watch.status).toBe(0);
      const rows = JSON.parse(watch.stdout) as Array<{
        event_id: string;
        event_type: string;
        message: string;
      }>;
      expect(rows.map((row) => row.event_id)).toContain("cli-watch-log-1");
      expect(rows.map((row) => row.event_id)).toContain("cli-watch-metric-1");
      expect(
        rows.find((row) => row.event_id === "cli-watch-metric-1")?.event_type,
      ).toBe("metric");
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("watches local event catalog records after a last event id", () => {
    const dataDir = mkdtempSync(
      join(tmpdir(), "open-logs-events-watch-cursor-cli-"),
    );
    try {
      expect(
        runCli(
          [
            "events",
            "push",
            "--type",
            "metric",
            "--id",
            "cli-watch-cursor-1",
            "--source",
            "sdk",
            "--message",
            "first cursor metric",
          ],
          dataDir,
        ).status,
      ).toBe(0);
      expect(
        runCli(
          [
            "events",
            "push",
            "--type",
            "metric",
            "--id",
            "cli-watch-cursor-2",
            "--source",
            "sdk",
            "--message",
            "second cursor metric",
          ],
          dataDir,
        ).status,
      ).toBe(0);

      const watch = runCli(
        [
          "watch",
          "--events",
          "--type",
          "metric",
          "--last-event-id",
          "cli-watch-cursor-1",
          "--once",
          "--format",
          "json",
        ],
        dataDir,
      );
      expect(watch.status).toBe(0);
      const rows = JSON.parse(watch.stdout) as Array<{
        event_id: string;
        message: string;
      }>;
      expect(rows.map((row) => row.event_id)).toEqual(["cli-watch-cursor-2"]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("reports an unknown local event catalog watch cursor without replaying history", () => {
    const dataDir = mkdtempSync(
      join(tmpdir(), "open-logs-events-watch-missing-cursor-cli-"),
    );
    try {
      expect(
        runCli(
          [
            "events",
            "push",
            "--type",
            "metric",
            "--id",
            "cli-watch-missing-cursor-existing",
            "--source",
            "sdk",
            "--message",
            "existing metric before missing cursor",
          ],
          dataDir,
        ).status,
      ).toBe(0);

      const watch = runCli(
        [
          "watch",
          "--events",
          "--type",
          "metric",
          "--last-event-id",
          "missing-cursor",
          "--once",
          "--format",
          "json",
        ],
        dataDir,
      );
      expect(watch.status).toBe(0);
      expect(watch.stderr).toContain("last_event_id_unknown");
      const rows = JSON.parse(watch.stdout) as Array<{ event_id: string }>;
      expect(rows).toEqual([]);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("watches a secured remote event catalog stream once as JSON", async () => {
    const dataDir = mkdtempSync(
      join(tmpdir(), "open-logs-events-watch-remote-cli-"),
    );
    const port = await getFreePort();
    const token = "remote-watch-test-token";
    const server = spawn("bun", ["src/server/index.ts"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HASNA_LOGS_DATA_DIR: dataDir,
        HASNA_LOGS_DB_PATH: join(dataDir, "logs.db"),
        HASNA_LOGS_FSYNC: "0",
        HASNA_LOGS_API_TOKEN: token,
        LOGS_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    try {
      await waitForHealth(port, server);
      const baseUrl = `http://127.0.0.1:${port}`;
      await postRemoteEvent(baseUrl, token, {
        type: "metric",
        event_id: "cli-watch-remote-anchor",
        source: "sdk",
        message: "remote watch anchor",
      });

      const watcher = spawn(
        "bun",
        [
          "src/cli/index.ts",
          "watch",
          "--server",
          baseUrl,
          "--token",
          token,
          "--type",
          "metric",
          "--last-event-id",
          "cli-watch-remote-anchor",
          "--once",
          "--format",
          "json",
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            HASNA_LOGS_DATA_DIR: dataDir,
            HASNA_LOGS_DB_PATH: join(dataDir, "logs.db"),
            HASNA_LOGS_FSYNC: "0",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const watcherResult = waitForExit(watcher, 8_000);

      await postRemoteEvent(baseUrl, token, {
        type: "metric",
        event_id: "cli-watch-remote-live",
        source: "sdk",
        severity: "info",
        message: "remote watch live metric",
      });

      const result = await watcherResult;
      expect(result.code).toBe(0);
      expect(result.stderr).not.toContain("Stream failed");
      const rows = result.stdout
        .trim()
        .split(/\n+/)
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              event_id: string;
              event_type: string;
              message: string;
            },
        );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        event_id: "cli-watch-remote-live",
        event_type: "metric",
        message: "remote watch live metric",
      });
    } finally {
      server.kill("SIGTERM");
      await waitForExit(server, 2_000).catch(() => server.kill("SIGKILL"));
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 15_000);

  test("retries remote event catalog watch after an initial stream connection failure", async () => {
    const dataDir = mkdtempSync(
      join(tmpdir(), "open-logs-events-watch-remote-retry-cli-"),
    );
    const port = await getFreePort();
    const token = "remote-watch-retry-token";
    const baseUrl = `http://127.0.0.1:${port}`;
    const watcher = spawn(
      "bun",
      [
        "src/cli/index.ts",
        "watch",
        "--server",
        baseUrl,
        "--token",
        token,
        "--type",
        "metric",
        "--format",
        "json",
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          HASNA_LOGS_DATA_DIR: dataDir,
          HASNA_LOGS_DB_PATH: join(dataDir, "logs.db"),
          HASNA_LOGS_FSYNC: "0",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const watcherOutput = waitForOutput(
      watcher,
      "cli-watch-reconnect-live",
      12_000,
    );
    let server: ChildProcess | null = null;
    let producer: ReturnType<typeof setInterval> | null = null;

    try {
      await delay(800);
      server = spawn("bun", ["src/server/index.ts"], {
        cwd: repoRoot,
        env: {
          ...process.env,
          HASNA_LOGS_DATA_DIR: dataDir,
          HASNA_LOGS_DB_PATH: join(dataDir, "logs.db"),
          HASNA_LOGS_FSYNC: "0",
          HASNA_LOGS_API_TOKEN: token,
          LOGS_PORT: String(port),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      await waitForHealth(port, server);
      let sequence = 0;
      const postReconnectEvent = () => {
        sequence += 1;
        void postRemoteEvent(baseUrl, token, {
          type: "metric",
          event_id: `cli-watch-reconnect-live-${sequence}`,
          source: "sdk",
          severity: "info",
          message: "remote watch reconnected metric",
        }).catch(() => {});
      };
      postReconnectEvent();
      producer = setInterval(postReconnectEvent, 250);

      const output = await watcherOutput;
      const rows = output.stdout
        .trim()
        .split(/\n+/)
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as {
              type?: string;
              reason?: string;
              event_id?: string;
              message?: string;
            },
        );
      expect(
        rows.some(
          (row) =>
            row.type === "overflow" && row.reason === "stream_read_error",
        ),
      ).toBe(true);
      expect(
        rows.some(
          (row) =>
            row.event_id?.startsWith("cli-watch-reconnect-live-") &&
            row.message === "remote watch reconnected metric",
        ),
      ).toBe(true);
    } finally {
      if (producer) clearInterval(producer);
      watcher.kill("SIGTERM");
      await waitForExit(watcher, 2_000).catch(() => watcher.kill("SIGKILL"));
      if (server) {
        server.kill("SIGTERM");
        await waitForExit(server, 2_000).catch(() => server?.kill("SIGKILL"));
      }
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 20_000);
});

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate a TCP port")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(
  port: number,
  process: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null)
      throw new Error(`Server exited before health check: ${process.exitCode}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error("Timed out waiting for logs server health");
}

async function postRemoteEvent(
  baseUrl: string,
  token: string,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok)
    throw new Error(
      `POST /api/events failed: ${res.status} ${await res.text()}`,
    );
}

async function waitForExit(
  process: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  process.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  process.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      process.kill("SIGTERM");
      reject(
        new Error(
          `Process timed out after ${timeoutMs}ms\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, timeoutMs);
    process.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    process.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function waitForOutput(
  process: ChildProcess,
  needle: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  process.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  process.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });

  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (stdout.includes(needle)) {
        clearInterval(timer);
        clearTimeout(timeout);
        resolve({ stdout, stderr });
      }
    }, 50);
    const timeout = setTimeout(() => {
      clearInterval(timer);
      reject(
        new Error(
          `Timed out waiting for ${needle}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, timeoutMs);
    process.once("close", (code) => {
      clearInterval(timer);
      clearTimeout(timeout);
      reject(
        new Error(
          `Process exited before ${needle}: ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
