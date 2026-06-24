import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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

describe("compact CLI output", () => {
  test("logs list is compact by default and preserves full JSON output", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "open-logs-compact-list-"));
    const longMessage = `compact output canary ${"x".repeat(220)} end`;
    const longMetadata = JSON.stringify({
      payload: "metadata ".repeat(80),
      nested: { secret_shape: "not printed in compact table output" },
    });

    try {
      const push = runCli(
        [
          "push",
          longMessage,
          "--id",
          "compact-log-1",
          "--level",
          "error",
          "--service",
          "compact-service-with-long-name",
          "--trace",
          "compact-trace-1",
        ],
        dataDir,
      );
      expect(push.status).toBe(0);

      const dbPatch = spawnSync(
        "bun",
        [
          "-e",
          `import { Database } from "bun:sqlite"; const db = new Database(${JSON.stringify(join(dataDir, "logs.db"))}); db.prepare("UPDATE logs SET metadata = ? WHERE id = ?").run(${JSON.stringify(longMetadata)}, "compact-log-1"); db.close();`,
        ],
        { cwd: repoRoot, encoding: "utf8" },
      );
      expect(dbPatch.status).toBe(0);

      const compact = runCli(["list", "--limit", "1"], dataDir);
      expect(compact.status).toBe(0);
      expect(compact.stdout).toContain("compact output canary");
      expect(compact.stdout).toContain("Use --verbose");
      expect(compact.stdout).not.toContain("end");
      expect(compact.stdout).not.toContain("metadata metadata metadata");
      expect(compact.stdout).not.toContain("secret_shape");

      const json = runCli(["list", "--limit", "1", "--json"], dataDir);
      expect(json.status).toBe(0);
      const rows = JSON.parse(json.stdout) as Array<{
        message: string;
        metadata: string | null;
      }>;
      expect(rows[0]?.message).toBe(longMessage);
      expect(rows[0]?.metadata).toBe(longMetadata);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("events list is compact by default and points to detail/json paths", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "open-logs-compact-events-"));
    const longEventId = "compact-event-id-abcdefghijklmnopqrstuvwxyz1234567890";
    const longMessage = `event compact canary ${"y".repeat(220)} end`;

    try {
      const push = runCli(
        [
          "events",
          "push",
          "--type",
          "agent",
          "--id",
          longEventId,
          "--source",
          "cli-test",
          "--severity",
          "warn",
          "--message",
          longMessage,
          "--attributes",
          JSON.stringify({ noisy: "attributes ".repeat(80) }),
        ],
        dataDir,
      );
      expect(push.status).toBe(0);

      const compact = runCli(["events", "list", "--limit", "1"], dataDir);
      expect(compact.status).toBe(0);
      expect(compact.stdout).toContain(longEventId);
      expect(compact.stdout).toContain("event compact canary");
      expect(compact.stdout).toContain("events get <event_id>");
      expect(compact.stdout).not.toContain("end");
      expect(compact.stdout).not.toContain("attributes attributes");

      const json = runCli(
        ["events", "list", "--limit", "1", "--json", "--include-raw"],
        dataDir,
      );
      expect(json.status).toBe(0);
      const rows = JSON.parse(json.stdout) as Array<{
        message: string | null;
        raw?: { message?: string | null };
      }>;
      expect(rows[0]?.message).toBe(longMessage);
      expect(rows[0]?.raw?.message).toBe(longMessage);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("health is summarized by default and full with --json", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "open-logs-compact-health-"));
    try {
      const compact = runCli(["health"], dataDir);
      expect(compact.status).toBe(0);
      expect(compact.stdout).toContain("Health: ok");
      expect(compact.stdout).toContain("Use --verbose");
      expect(() => JSON.parse(compact.stdout)).toThrow();

      const json = runCli(["health", "--json"], dataDir);
      expect(json.status).toBe(0);
      expect(JSON.parse(json.stdout)).toMatchObject({ status: "ok" });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
