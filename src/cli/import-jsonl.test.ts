import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const splitUtf8Emoji = "😀";

function jsonLineWithEmojiAtByteOffset(byteOffset: number): string {
  let padding = "";
  while (true) {
    const line = JSON.stringify({
      level: "info",
      message: `${padding}${splitUtf8Emoji}`,
    });
    const emojiOffset = Buffer.from(line).indexOf(Buffer.from(splitUtf8Emoji));
    if (emojiOffset === byteOffset) return line;
    if (emojiOffset > byteOffset) {
      throw new Error(
        `emoji offset ${emojiOffset} passed target ${byteOffset}`,
      );
    }
    padding += "a".repeat(byteOffset - emojiOffset);
  }
}

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

function runCliAsync(args: string[], dataDir: string) {
  const child = spawn("bun", ["src/cli/index.ts", ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HASNA_LOGS_DATA_DIR: dataDir,
      HASNA_LOGS_DB_PATH: join(dataDir, "logs.db"),
      HASNA_LOGS_FSYNC: "0",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  return {
    child,
    result: new Promise<{
      status: number | null;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      child.on("exit", (status) => resolve({ status, stdout, stderr }));
    }),
  };
}

describe("logs import-jsonl", () => {
  test("imports structured JSONL logs and preserves stable retry IDs", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "open-logs-import-jsonl-cli-"));
    try {
      const file = join(dataDir, "app.jsonl");
      writeFileSync(
        file,
        [
          JSON.stringify({
            level: 30,
            time: 1781596800000,
            msg: "started",
            name: "api",
          }),
          JSON.stringify({
            level: 50,
            time: 1781596801000,
            msg: "failed",
            name: "api",
            traceId: "trace-cli-import",
          }),
        ].join("\n"),
      );

      const first = runCli(
        [
          "import-jsonl",
          file,
          "--format",
          "pino",
          "--environment",
          "test",
          "--json",
        ],
        dataDir,
      );
      expect(first.status).toBe(0);
      const firstBody = JSON.parse(first.stdout) as {
        inserted: number;
        ids: string[];
      };
      expect(firstBody.inserted).toBe(2);
      expect(firstBody.ids).toHaveLength(2);

      const retry = runCli(
        [
          "import-jsonl",
          file,
          "--format",
          "pino",
          "--environment",
          "test",
          "--json",
        ],
        dataDir,
      );
      expect(retry.status).toBe(0);
      const retryBody = JSON.parse(retry.stdout) as {
        inserted: number;
        ids: string[];
      };
      expect(retryBody.ids).toEqual(firstBody.ids);

      const db = new Database(join(dataDir, "logs.db"));
      try {
        expect(db.prepare("SELECT COUNT(*) AS count FROM logs").get()).toEqual({
          count: 2,
        });
        expect(
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM event_records WHERE source = 'pino'",
            )
            .get(),
        ).toEqual({ count: 2 });
        expect(
          db
            .prepare("SELECT environment FROM event_records WHERE trace_id = ?")
            .get("trace-cli-import"),
        ).toEqual({ environment: "test" });
      } finally {
        db.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("follows appended structured JSONL logs until idle timeout", async () => {
    const dataDir = mkdtempSync(
      join(tmpdir(), "open-logs-import-jsonl-follow-"),
    );
    try {
      const file = join(dataDir, "live.jsonl");
      writeFileSync(file, "");

      const { result } = runCliAsync(
        [
          "import-jsonl",
          file,
          "--follow",
          "--format",
          "pino",
          "--environment",
          "test",
          "--poll",
          "25",
          "--idle-timeout",
          "350",
          "--json",
        ],
        dataDir,
      );

      await new Promise((resolve) => setTimeout(resolve, 75));
      appendFileSync(
        file,
        `${JSON.stringify({
          level: 30,
          time: 1781596802000,
          msg: "followed",
          name: "api",
          traceId: "trace-follow-import",
        })}\n`,
      );

      const followed = await result;
      expect(followed.status).toBe(0);
      const body = JSON.parse(followed.stdout) as {
        inserted: number;
        ids: string[];
        lines_read: number;
      };
      expect(body.inserted).toBe(1);
      expect(body.ids).toHaveLength(1);
      expect(body.lines_read).toBe(1);

      const db = new Database(join(dataDir, "logs.db"));
      try {
        expect(db.prepare("SELECT message, source FROM logs").get()).toEqual({
          message: "followed",
          source: "pino",
        });
        expect(
          db
            .prepare("SELECT environment FROM event_records WHERE trace_id = ?")
            .get("trace-follow-import"),
        ).toEqual({ environment: "test" });
      } finally {
        db.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("follow mode enforces max-lines before draining the current file", () => {
    const dataDir = mkdtempSync(
      join(tmpdir(), "open-logs-import-jsonl-follow-max-"),
    );
    try {
      const file = join(dataDir, "burst.jsonl");
      writeFileSync(
        file,
        [
          JSON.stringify({ level: 30, msg: "first", time: 1781596803000 }),
          JSON.stringify({ level: 30, msg: "second", time: 1781596804000 }),
          JSON.stringify({ level: 30, msg: "third", time: 1781596805000 }),
        ].join("\n"),
      );

      const result = runCli(
        [
          "import-jsonl",
          file,
          "--follow",
          "--format",
          "pino",
          "--max-lines",
          "1",
          "--poll",
          "5",
          "--json",
        ],
        dataDir,
      );
      expect(result.status).toBe(0);
      const body = JSON.parse(result.stdout) as {
        inserted: number;
        ids: string[];
        lines_read: number;
      };
      expect(body.inserted).toBe(1);
      expect(body.ids).toHaveLength(1);
      expect(body.lines_read).toBe(1);

      const db = new Database(join(dataDir, "logs.db"));
      try {
        const row = db.prepare("SELECT message, metadata FROM logs").get() as {
          message: string;
          metadata: string;
        };
        expect(row.message).toBe("first");
        const metadata = JSON.parse(row.metadata) as {
          structured_log?: { position?: { byte_offset?: number } };
        };
        expect(metadata.structured_log?.position?.byte_offset).toBe(0);
        expect(db.prepare("SELECT COUNT(*) AS count FROM logs").get()).toEqual({
          count: 1,
        });
      } finally {
        db.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("follow mode preserves UTF-8 split across read buffers", () => {
    const dataDir = mkdtempSync(
      join(tmpdir(), "open-logs-import-jsonl-follow-utf8-"),
    );
    try {
      const file = join(dataDir, "utf8.jsonl");
      writeFileSync(file, `${jsonLineWithEmojiAtByteOffset(64 * 1024 - 1)}\n`);

      const result = runCli(
        [
          "import-jsonl",
          file,
          "--follow",
          "--format",
          "json",
          "--max-lines",
          "1",
          "--poll",
          "5",
          "--json",
        ],
        dataDir,
      );
      expect(result.status).toBe(0);
      const body = JSON.parse(result.stdout) as { inserted: number };
      expect(body.inserted).toBe(1);

      const db = new Database(join(dataDir, "logs.db"));
      try {
        const row = db.prepare("SELECT message FROM logs").get() as {
          message: string;
        };
        expect(row.message.endsWith(splitUtf8Emoji)).toBe(true);
        expect(row.message).not.toContain("\uFFFD");
      } finally {
        db.close();
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test("rejects invalid format values", () => {
    const dataDir = mkdtempSync(
      join(tmpdir(), "open-logs-import-jsonl-invalid-"),
    );
    try {
      const file = join(dataDir, "app.jsonl");
      writeFileSync(file, JSON.stringify({ level: "info", message: "ok" }));

      const result = runCli(["import-jsonl", file, "--format", "bad"], dataDir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "format must be auto, pino, winston, or json",
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
