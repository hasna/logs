import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { PG_MIGRATIONS } from "../db/pg-migrations.ts";
import { buildPgPoolConfig } from "./remote-storage.ts";
import { sourceMapSourceRowId } from "./source-map-projections.ts";
import {
  STORAGE_TABLES,
  getStorageDatabaseUrl,
  getStorageMode,
  resolveTables,
} from "./storage-sync.ts";

const envKeys = [
  "HASNA_LOGS_DATABASE_URL",
  "LOGS_DATABASE_URL",
  "HASNA_LOGS_STORAGE_MODE",
  "LOGS_STORAGE_MODE",
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  savedEnv.clear();
  for (const key of envKeys) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("logs storage sync config", () => {
  test("canonical storage database env wins over fallback env", () => {
    process.env.HASNA_LOGS_DATABASE_URL = "postgres://new.example/logs";
    process.env.LOGS_DATABASE_URL = "postgres://fallback.example/logs";

    expect(getStorageDatabaseUrl()).toBe("postgres://new.example/logs");
    expect(getStorageMode()).toBe("hybrid");
  });

  test("fallback storage database env is accepted", () => {
    process.env.LOGS_DATABASE_URL = "postgres://fallback.example/logs";

    expect(getStorageDatabaseUrl()).toBe("postgres://fallback.example/logs");
    expect(getStorageMode()).toBe("hybrid");
  });

  test("canonical storage mode wins over fallback mode", () => {
    process.env.HASNA_LOGS_STORAGE_MODE = "remote";
    process.env.LOGS_STORAGE_MODE = "hybrid";

    expect(getStorageMode()).toBe("remote");
  });

  test("resolves storage tables", () => {
    expect(resolveTables()).toEqual([...STORAGE_TABLES]);
    expect(resolveTables(["feedback"])).toEqual(["feedback"]);
    expect(resolveTables()).toContain("event_segments");
    expect(resolveTables()).toContain("event_records");
    expect(resolveTables()).toContain("machines");
    expect(resolveTables()).not.toContain("page_auth");
    expect(resolveTables()).not.toContain("browser_ingest_tokens");
    expect(() => resolveTables(["page_auth"])).toThrow(
      "Unknown logs sync table",
    );
    expect(() => resolveTables(["browser_ingest_tokens"])).toThrow(
      "Unknown logs sync table",
    );
    expect(() => resolveTables(["missing"])).toThrow("Unknown logs sync table");
  });

  test("PostgreSQL migrations include event metadata and do not restrict log sources", () => {
    const sql = PG_MIGRATIONS.join("\n");

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS event_segments");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS event_records");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS machines");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS browser_ingest_tokens");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS source_map_sources");
    expect(sql).toContain("id TEXT PRIMARY KEY");
    expect(sql).toContain("UNIQUE(source_map_id, ordinal)");
    expect(sql).toContain(
      "ALTER TABLE source_map_sources ADD COLUMN IF NOT EXISTS id TEXT",
    );
    expect(sql).toContain(
      "SET id = 'srcmap_source_' || md5(source_map_id || ':' || ordinal::text)",
    );
    expect(sql).toContain("id IS NULL OR id LIKE 'srcmap_source_legacy_%'");
    expect(sql).toContain("idx_source_map_sources_id");
    expect(sql).toContain(
      "ALTER TABLE logs DROP CONSTRAINT IF EXISTS logs_source_check",
    );
    expect(sql).not.toContain("source TEXT NOT NULL DEFAULT 'sdk' CHECK");
  });

  test("source map source row ids are deterministic for sync", () => {
    const expected = `srcmap_source_${createHash("md5")
      .update("sm-legacy")
      .update(":")
      .update("0")
      .digest("hex")}`;

    expect(sourceMapSourceRowId("sm-legacy", 0)).toBe(expected);
  });

  test("PostgreSQL pool config keeps local URLs local but requires TLS for remote URLs", () => {
    expect(
      buildPgPoolConfig("postgres://user:pass@localhost:5432/logs"),
    ).toEqual({
      connectionString: "postgres://user:pass@localhost:5432/logs",
    });
    expect(
      buildPgPoolConfig(
        "postgres://user:pass@localhost:5432/logs?sslmode=disable",
      ),
    ).toEqual({
      connectionString: "postgres://user:pass@localhost:5432/logs",
    });
    expect(buildPgPoolConfig("postgres://user:pass@db.example/logs")).toEqual({
      connectionString: "postgres://user:pass@db.example/logs",
      ssl: true,
    });
    expect(
      buildPgPoolConfig("postgres://user:pass@db.example/logs?sslmode=require"),
    ).toEqual({
      connectionString: "postgres://user:pass@db.example/logs",
      ssl: true,
    });
  });

  test("PostgreSQL pool config rejects unsafe remote TLS settings", () => {
    expect(() =>
      buildPgPoolConfig("postgres://user:pass@db.example/logs?sslmode=disable"),
    ).toThrow("Unsafe PostgreSQL sslmode");
    expect(() =>
      buildPgPoolConfig("postgres://user:pass@db.example/logs?ssl=false"),
    ).toThrow("Unsafe PostgreSQL ssl setting");
    expect(
      JSON.stringify(
        buildPgPoolConfig("postgres://user:pass@db.example/logs?ssl=true"),
      ),
    ).not.toContain("reject" + "Unauthorized");
  });
});
