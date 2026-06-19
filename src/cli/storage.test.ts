import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function runCli(args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync("bun", ["src/cli/index.ts", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
  });
}

describe("logs storage CLI", () => {
  test("help advertises storage sync without legacy cloud command", () => {
    const result = runCli(["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("storage");
    expect(result.stdout).not.toContain("cloud");
  });

  test("storage status reports local mode as JSON", () => {
    const home = mkdtempSync(join(tmpdir(), "open-logs-storage-cli-"));
    try {
      const result = runCli(["storage", "status", "--json"], {
        HOME: home,
        HASNA_LOGS_DATA_DIR: home,
        HASNA_LOGS_DB_PATH: join(home, "logs.db"),
        LOGS_DATA_DIR: "",
        LOGS_DB_PATH: "",
        HASNA_LOGS_DATABASE_URL: "",
        LOGS_DATABASE_URL: "",
        HASNA_LOGS_STORAGE_MODE: "",
        LOGS_STORAGE_MODE: "",
      });

      expect(result.status).toBe(0);
      const status = JSON.parse(result.stdout) as {
        configured: boolean;
        mode: string;
        activeEnv: string | null;
        service: string;
        tables: string[];
      };
      expect(status.configured).toBe(false);
      expect(status.mode).toBe("local");
      expect(status.activeEnv).toBe(null);
      expect(status.service).toBe("logs");
      expect(status.tables).toContain("logs");
      expect(status.tables).toContain("event_records");
      expect(status.tables).toContain("test_reports");
      expect(status.tables).toContain("test_cases");
      expect(status.tables).not.toContain("page_auth");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
