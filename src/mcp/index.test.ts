import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ingestLog } from "../lib/ingest.ts";
import { upsertIssue } from "../lib/issues.ts";

const entry = fileURLToPath(new URL("./index.ts", import.meta.url));

function createMcpClient(dataDir?: string) {
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", entry],
    env: dataDir
      ? testEnv({
          HASNA_LOGS_DATA_DIR: dataDir,
          HASNA_LOGS_DB_PATH: join(dataDir, "logs.db"),
          HASNA_LOGS_FSYNC: "0",
        })
      : testEnv(),
  });
  const client = new Client(
    { name: "logs-mcp-test", version: "0.0.0" },
    { capabilities: {} },
  );
  return { client, transport };
}

function testEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return { ...env, ...extra };
}

function textContent(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  return content?.[0]?.text ?? "";
}

function readAgentEvents(dataDir: string): Array<{
  event_id: string;
  message: string | null;
  metadata: string | null;
}> {
  const db = new Database(join(dataDir, "logs.db"));
  try {
    return db
      .prepare(
        "SELECT event_id, message, metadata FROM event_records WHERE event_type = 'agent' ORDER BY rowid ASC",
      )
      .all() as Array<{
      event_id: string;
      message: string | null;
      metadata: string | null;
    }>;
  } finally {
    db.close();
  }
}

test("logs MCP lists tools over stdio", async () => {
  const { client, transport } = createMcpClient();

  try {
    await client.connect(transport);
    const result = await client.listTools();
    const toolNames = result.tools.map((tool) => tool.name);

    expect(toolNames.length).toBeGreaterThan(0);
    expect(toolNames).toContain("get_health");
    expect(toolNames).toContain("log_export");
    expect(toolNames).toContain("log_search");
    expect(toolNames).toContain("log_stats");
    expect(toolNames).toContain("event_push");
    expect(toolNames).toContain("event_search");
    expect(toolNames).toContain("event_get");
    expect(toolNames).toContain("event_export");
    expect(toolNames).toContain("event_watch");
    expect(toolNames).toContain("test_report_search");
    expect(toolNames).toContain("test_report_get");
    expect(toolNames).toContain("storage_status");
    expect(toolNames).toContain("storage_push");
    expect(toolNames).not.toContain("cloud_status");
  } finally {
    await client.close().catch(() => {});
  }
});

test("logs MCP watches event catalog records by cursor", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "open-logs-mcp-watch-"));
  const { client, transport } = createMcpClient(dataDir);

  try {
    await client.connect(transport);
    await client.callTool({
      name: "event_push",
      arguments: {
        type: "metric",
        event_id: "mcp-watch-anchor",
        source: "sdk",
        message: "mcp watch anchor",
      },
    });
    await client.callTool({
      name: "event_push",
      arguments: {
        type: "metric",
        event_id: "mcp-watch-live",
        source: "sdk",
        severity: "info",
        message: "mcp watch live",
      },
    });

    const afterAnchor = await client.callTool({
      name: "event_watch",
      arguments: {
        event_type: "metric",
        last_event_id: "mcp-watch-anchor",
        limit: 10,
      },
    });
    const watched = JSON.parse(textContent(afterAnchor)) as {
      cursor: string | null;
      events: Array<{ event_id: string; event_type: string }>;
      overflow: unknown;
    };
    expect(watched.cursor).toBe("mcp-watch-live");
    expect(watched.overflow).toBeNull();
    expect(watched.events.map((event) => event.event_id)).toEqual([
      "mcp-watch-live",
    ]);
    expect(watched.events[0]?.event_type).toBe("metric");

    const db = new Database(join(dataDir, "logs.db"));
    try {
      const record = db
        .prepare(
          "SELECT machine_id, app_id, environment FROM event_records WHERE event_id = ?",
        )
        .get("mcp-watch-live") as {
        machine_id: string | null;
        app_id: string | null;
        environment: string | null;
      } | null;
      const machineId = record?.machine_id;
      const appId = record?.app_id;
      expect(machineId).toStartWith("machine_");
      expect(appId).toStartWith("app_");
      if (!machineId || !appId)
        throw new Error(
          "Expected MCP event_push to detect machine and app identity",
        );
      expect(record?.environment).toBe(process.env.NODE_ENV ?? "development");
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
    } finally {
      db.close();
    }

    const missing = await client.callTool({
      name: "event_watch",
      arguments: {
        event_type: "metric",
        last_event_id: "missing-mcp-cursor",
      },
    });
    const missingBody = JSON.parse(textContent(missing)) as {
      cursor: string | null;
      events: unknown[];
      overflow: { reason: string; last_event_id: string } | null;
    };
    expect(missingBody.events).toEqual([]);
    expect(missingBody.cursor).toBe("mcp-watch-live");
    expect(missingBody.overflow).toEqual({
      reason: "last_event_id_unknown",
      last_event_id: "missing-mcp-cursor",
    });
  } finally {
    await client.close().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("MCP log_context_from_id keeps the target log when capped", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "open-logs-mcp-context-cap-"));
  const { client, transport } = createMcpClient(dataDir);

  try {
    await client.connect(transport);
    const db = new Database(join(dataDir, "logs.db"));
    try {
      for (let i = 0; i < 40; i += 1) {
        ingestLog(db, {
          id: `context-cap-${String(i).padStart(2, "0")}`,
          timestamp: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
          level: "info",
          message: `context cap row ${i}`,
          trace_id: "context-cap-trace",
        });
      }
    } finally {
      db.close();
    }

    const result = await client.callTool({
      name: "log_context_from_id",
      arguments: {
        log_id: "context-cap-34",
        limit: 5,
      },
    });
    const rows = JSON.parse(textContent(result)) as Array<{ id: string }>;
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.id)).toContain("context-cap-34");
  } finally {
    await client.close().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("MCP list_issues compacts long issue messages by default", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "open-logs-mcp-issues-compact-"));
  const { client, transport } = createMcpClient(dataDir);
  const longMessage = `issue compact canary ${"z".repeat(240)} end`;

  try {
    await client.connect(transport);
    const db = new Database(join(dataDir, "logs.db"));
    try {
      upsertIssue(db, {
        level: "error",
        service: "issue-service-with-a-long-name",
        message: longMessage,
      });
    } finally {
      db.close();
    }

    const result = await client.callTool({
      name: "list_issues",
      arguments: {},
    });
    const rows = JSON.parse(textContent(result)) as Array<{
      message_template: string;
    }>;
    expect(rows[0]?.message_template).toContain("issue compact canary");
    expect(rows[0]?.message_template).not.toContain(" end");

    const full = await client.callTool({
      name: "list_issues",
      arguments: { brief: false },
    });
    const fullRows = JSON.parse(textContent(full)) as Array<{
      message_template: string;
    }>;
    expect(fullRows[0]?.message_template).toBe(longMessage);
  } finally {
    await client.close().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("MCP queries projected test reports", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "open-logs-mcp-test-reports-"));
  const { client, transport } = createMcpClient(dataDir);

  try {
    await client.connect(transport);
    await client.callTool({
      name: "event_push",
      arguments: {
        type: "build",
        event_id: "mcp-test-report-event",
        source: "test",
        severity: "error",
        run_id: "run-mcp-test-report",
        process_id: "proc-mcp-test-report",
        attributes: {
          category: "test_report",
          scanner: "mcp-test",
        },
        body: {
          test_report: {
            report_id: "report-mcp-test",
            path: "test-results/mcp.xml",
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
                name: "mcp suite",
                cases: [
                  {
                    name: "fails over mcp",
                    classname: "mcp.Case",
                    status: "failed",
                  },
                ],
              },
            ],
          },
        },
      },
    });
    await client.callTool({
      name: "event_push",
      arguments: {
        type: "build",
        event_id: "mcp-aggregate-test-report-event",
        source: "test",
        severity: "error",
        run_id: "run-mcp-test-report",
        attributes: {
          category: "test_report",
          scanner: "mcp-test",
        },
        body: {
          test_report: {
            report_id: "report-mcp-aggregate-failed",
            path: "test-results/mcp-aggregate.xml",
            parser: "external-junit",
            parse_status: "parsed",
            tests: 3,
            failures: 1,
            errors: 0,
            skipped: 0,
            testcase_count: 3,
          },
        },
      },
    });

    const search = await client.callTool({
      name: "test_report_search",
      arguments: {
        run_id: "run-mcp-test-report",
        case_status: "failed",
        include_cases: true,
      },
    });
    const reports = JSON.parse(textContent(search)) as Array<{
      id: string;
      cases?: Array<{ name: string; status: string }>;
    }>;
    expect(reports).toHaveLength(1);
    expect(reports[0]?.id).toBe("report-mcp-test");
    expect(reports[0]?.cases?.[0]).toMatchObject({
      name: "fails over mcp",
      status: "failed",
    });

    const get = await client.callTool({
      name: "test_report_get",
      arguments: {
        report_id: "report-mcp-test",
      },
    });
    const one = JSON.parse(textContent(get)) as {
      event_id: string;
      cases?: unknown[];
    };
    expect(one.event_id).toBe("mcp-test-report-event");
    expect(one.cases).toHaveLength(1);

    const aggregateSearch = await client.callTool({
      name: "test_report_search",
      arguments: {
        run_id: "run-mcp-test-report",
        outcome: "failed",
        text: "aggregate",
      },
    });
    const aggregateReports = JSON.parse(textContent(aggregateSearch)) as Array<{
      id: string;
      failures: number;
      case_stored_count: number;
    }>;
    expect(aggregateReports).toEqual([
      expect.objectContaining({
        id: "report-mcp-aggregate-failed",
        failures: 1,
        case_stored_count: 0,
      }),
    ]);
  } finally {
    await client.close().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("MCP event_push validates before local identity mutation", async () => {
  const dataDir = mkdtempSync(
    join(tmpdir(), "open-logs-mcp-invalid-identity-"),
  );
  const { client, transport } = createMcpClient(dataDir);

  try {
    await client.connect(transport);
    const result = await client
      .callTool({
        name: "event_push",
        arguments: {
          type: "metric",
          event_id: "mcp-invalid-identity-mutation",
          event_time: "not-a-date",
        },
      })
      .then(
        (value) => ({ value, error: null as unknown }),
        (error) => ({ value: null, error }),
      );
    expect(String(result.error ?? textContent(result.value))).toContain(
      "event_time",
    );

    const db = new Database(join(dataDir, "logs.db"));
    try {
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM event_records WHERE event_id = ?",
          )
          .get("mcp-invalid-identity-mutation") as { count: number },
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
    await client.close().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("MCP records tool-call telemetry with safe argument summaries", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "open-logs-mcp-tool-telemetry-"));
  const { client, transport } = createMcpClient(dataDir);
  const secret = "OPENLOGS_SECRET_CANARY_mcp_tool_arg_123";

  try {
    await client.connect(transport);
    await client.callTool({
      name: "log_search",
      arguments: {
        text: secret,
        limit: 3,
      },
    });

    const events = readAgentEvents(dataDir);
    const toolEvent = events.find(
      (event) => event.message === "MCP tool log_search completed",
    );
    expect(toolEvent).toBeTruthy();
    expect(toolEvent?.metadata).toContain('"category":"mcp_tool_call"');
    expect(toolEvent?.metadata).toContain('"tool_name":"log_search"');
    expect(toolEvent?.metadata).toContain('"argument_keys":"limit,text"');
    expect(JSON.stringify(events)).not.toContain(secret);
  } finally {
    await client.close().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("MCP records failed tool-call telemetry", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "open-logs-mcp-tool-error-"));
  const { client, transport } = createMcpClient(dataDir);

  try {
    await client.connect(transport);
    await client
      .callTool({
        name: "event_push",
        arguments: {
          type: "metric",
          event_id: "mcp-tool-error-invalid-event",
          event_time: "not-a-date",
        },
      })
      .catch(() => null);

    const events = readAgentEvents(dataDir);
    const toolEvent = events.find(
      (event) => event.message === "MCP tool event_push failed",
    );
    expect(toolEvent).toBeTruthy();
    expect(toolEvent?.metadata).toContain('"status":"error"');
    expect(toolEvent?.metadata).toContain('"tool_name":"event_push"');
  } finally {
    await client.close().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("MCP event_search and event_watch hide internal tool telemetry by default", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "open-logs-mcp-internal-filter-"));
  const { client, transport } = createMcpClient(dataDir);

  try {
    await client.connect(transport);
    await client.callTool({
      name: "log_search",
      arguments: {
        text: "no-match-internal-filter",
      },
    });

    const defaultSearch = await client.callTool({
      name: "event_search",
      arguments: {
        event_type: "agent",
        source: "mcp",
        text: "mcp_tool_call",
        limit: 20,
      },
    });
    expect(JSON.parse(textContent(defaultSearch)) as unknown[]).toEqual([]);

    const internalSearch = await client.callTool({
      name: "event_search",
      arguments: {
        event_type: "agent",
        source: "mcp",
        include_internal: true,
        limit: 20,
      },
    });
    const compactInternalRows = JSON.parse(
      textContent(internalSearch),
    ) as Array<{
      message: string;
      metadata?: unknown;
      has_metadata?: boolean;
    }>;
    expect(compactInternalRows.some((row) => row.has_metadata)).toBe(true);
    expect(compactInternalRows.some((row) => row.metadata)).toBe(false);

    const fullInternalSearch = await client.callTool({
      name: "event_search",
      arguments: {
        event_type: "agent",
        source: "mcp",
        include_internal: true,
        brief: false,
        limit: 20,
      },
    });
    const internalRows = JSON.parse(textContent(fullInternalSearch)) as Array<{
      message: string;
      metadata: Record<string, unknown> | null;
    }>;
    expect(
      internalRows.some((row) => row.metadata?.category === "mcp_tool_call"),
    ).toBe(true);

    const firstWatch = await client.callTool({
      name: "event_watch",
      arguments: {
        from_start: true,
      },
    });
    expect(
      (JSON.parse(textContent(firstWatch)) as { events: unknown[] }).events,
    ).toEqual([]);

    const secondWatch = await client.callTool({
      name: "event_watch",
      arguments: {
        from_start: true,
      },
    });
    expect(
      (JSON.parse(textContent(secondWatch)) as { events: unknown[] }).events,
    ).toEqual([]);
  } finally {
    await client.close().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("MCP records agent session activity as durable events", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "open-logs-mcp-agent-telemetry-"));
  const { client, transport } = createMcpClient(dataDir);

  try {
    await client.connect(transport);
    const registered = await client.callTool({
      name: "register_agent",
      arguments: {
        name: "review-agent",
        session_id: "session-review-agent",
      },
    });
    const agent = JSON.parse(textContent(registered)) as { id: string };
    await client.callTool({
      name: "heartbeat",
      arguments: { agent_id: agent.id },
    });
    await client.callTool({
      name: "set_focus",
      arguments: { agent_id: agent.id, project_id: "project-demo" },
    });

    const events = readAgentEvents(dataDir);
    expect(
      events.some(
        (event) => event.message === "MCP agent registered: review-agent",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) => event.message === "MCP agent heartbeat: review-agent",
      ),
    ).toBe(true);
    expect(
      events.some((event) => event.message === "MCP agent focus: review-agent"),
    ).toBe(true);
    const metadata = events.map((event) =>
      event.metadata
        ? (JSON.parse(event.metadata) as Record<string, unknown>)
        : {},
    );
    expect(metadata.some((item) => item.category === "mcp_agent_session")).toBe(
      true,
    );
    expect(metadata.some((item) => item.agent_name === "review-agent")).toBe(
      true,
    );
  } finally {
    await client.close().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("MCP event_push skips local discovery when explicit identity is supplied", async () => {
  const dataDir = mkdtempSync(
    join(tmpdir(), "open-logs-mcp-explicit-identity-"),
  );
  const { client, transport } = createMcpClient(dataDir);

  try {
    await client.connect(transport);
    const pushed = await client.callTool({
      name: "event_push",
      arguments: {
        type: "metric",
        event_id: "mcp-explicit-identity",
        machine_id: "machine_external",
        repo_id: "repo_external",
        app_id: "app_external",
        environment: "external",
      },
    });
    expect(textContent(pushed)).toContain("mcp-explicit-identity");

    const db = new Database(join(dataDir, "logs.db"));
    try {
      const record = db
        .prepare(
          "SELECT machine_id, repo_id, app_id, environment FROM event_records WHERE event_id = ?",
        )
        .get("mcp-explicit-identity") as {
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
    await client.close().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  }
});
