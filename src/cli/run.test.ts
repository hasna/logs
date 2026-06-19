import { Database } from "bun:sqlite";
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

describe("logs run CLI", () => {
  test("captures a real command into the local store", () => {
    const home = mkdtempSync(join(tmpdir(), "open-logs-run-cli-"));
    try {
      const dbPath = join(home, "logs.db");
      const result = runCli(
        [
          "run",
          "--json",
          "--cwd",
          repoRoot,
          "--",
          process.execPath,
          "-e",
          "console.log('cli-run-out')",
        ],
        {
          HOME: home,
          HASNA_LOGS_DATA_DIR: home,
          HASNA_LOGS_DB_PATH: dbPath,
          LOGS_DATA_DIR: "",
          LOGS_DB_PATH: "",
        },
      );

      expect(result.status).toBe(0);
      expect(result.stderr.trim()).toBe("");
      const summary = JSON.parse(result.stdout) as {
        run_id: string;
        process_id: string;
        exit_code: number;
        stdout_lines: number;
      };
      expect(summary.exit_code).toBe(0);
      expect(summary.stdout_lines).toBe(1);

      const db = new Database(dbPath);
      try {
        const log = db
          .prepare("SELECT message, source FROM logs WHERE message = ?")
          .get("cli-run-out") as { message: string; source: string } | null;
        const run = db
          .prepare("SELECT status, exit_code FROM runs WHERE id = ?")
          .get(summary.run_id) as { status: string; exit_code: number } | null;
        const indexed = db
          .prepare(
            "SELECT COUNT(*) AS count FROM event_records WHERE run_id = ?",
          )
          .get(summary.run_id) as { count: number };
        expect(log).toEqual({ message: "cli-run-out", source: "cli" });
        expect(run).toEqual({ status: "completed", exit_code: 0 });
        expect(indexed.count).toBeGreaterThanOrEqual(3);
      } finally {
        db.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
