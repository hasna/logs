import type { Database } from "bun:sqlite";
import { getDb } from "../db/index.ts";
import { PG_MIGRATIONS } from "../db/pg-migrations.ts";
import { PgAdapterAsync } from "./remote-storage.ts";

export const STORAGE_TABLES = [
  "projects",
  "pages",
  "logs",
  "event_segments",
  "event_records",
  "machines",
  "repositories",
  "apps",
  "processes",
  "runs",
  "event_sources",
  "traces",
  "spans",
  "sessions",
  "releases",
  "artifacts",
  "source_maps",
  "source_map_sources",
  "test_reports",
  "test_cases",
  "projection_offsets",
  "sync_cursors",
  "scan_jobs",
  "scan_runs",
  "performance_snapshots",
  "alert_rules",
  "issues",
  "feedback",
] as const;

export const LOGS_STORAGE_TABLES = STORAGE_TABLES;

type StorageTable = (typeof STORAGE_TABLES)[number];
type Row = Record<string, unknown>;
export type StorageMode = "local" | "hybrid" | "remote";

export interface StorageEnv {
  name: string;
}

export const LOGS_STORAGE_ENV = "HASNA_LOGS_DATABASE_URL";
export const LOGS_STORAGE_FALLBACK_ENV = "LOGS_DATABASE_URL";
export const LOGS_STORAGE_MODE_ENV = "HASNA_LOGS_STORAGE_MODE";
export const LOGS_STORAGE_MODE_FALLBACK_ENV = "LOGS_STORAGE_MODE";
export const STORAGE_DATABASE_ENV = [
  LOGS_STORAGE_ENV,
  LOGS_STORAGE_FALLBACK_ENV,
] as const;
export const STORAGE_MODE_ENV = [
  LOGS_STORAGE_MODE_ENV,
  LOGS_STORAGE_MODE_FALLBACK_ENV,
] as const;

export interface StorageStatus {
  configured: boolean;
  mode: StorageMode;
  env: typeof STORAGE_DATABASE_ENV;
  activeEnv: string | null;
  service: "logs";
  tables: typeof STORAGE_TABLES;
}

function readEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function normalizeStorageMode(
  value: string | undefined,
): StorageMode | undefined {
  const normalized = value?.trim().toLowerCase();
  if (
    normalized === "local" ||
    normalized === "hybrid" ||
    normalized === "remote"
  )
    return normalized;
  return undefined;
}

export function getStorageDatabaseEnvName():
  | (typeof STORAGE_DATABASE_ENV)[number]
  | null {
  for (const name of STORAGE_DATABASE_ENV) {
    if (readEnv(name)) return name;
  }
  return null;
}

export function getStorageDatabaseEnv(): StorageEnv | null {
  const name = getStorageDatabaseEnvName();
  return name ? { name } : null;
}

export function getStorageDatabaseUrl(): string | null {
  const env = getStorageDatabaseEnv();
  return env ? (readEnv(env.name) ?? null) : null;
}

export function getStorageMode(): StorageMode {
  const mode = normalizeStorageMode(
    readEnv(LOGS_STORAGE_MODE_ENV) ?? readEnv(LOGS_STORAGE_MODE_FALLBACK_ENV),
  );
  if (mode) return mode;
  return getStorageDatabaseUrl() ? "hybrid" : "local";
}

export async function getStoragePg(): Promise<PgAdapterAsync> {
  const url = getStorageDatabaseUrl();
  if (!url) throw new Error("Missing HASNA_LOGS_DATABASE_URL");
  return new PgAdapterAsync(url);
}

export async function runStorageMigrations(
  remote: PgAdapterAsync,
): Promise<void> {
  for (const sql of PG_MIGRATIONS) await remote.run(sql);
}

export async function storagePush(opts?: { tables?: string[] }): Promise<{
  rows: number;
}> {
  const remote = await getStoragePg();
  try {
    await runStorageMigrations(remote);
    const db = getDb();
    let rows = 0;
    for (const table of resolveTables(opts?.tables))
      rows += await pushTable(db, remote, table);
    return { rows };
  } finally {
    await remote.close();
  }
}

export async function storagePull(opts?: { tables?: string[] }): Promise<{
  rows: number;
}> {
  const remote = await getStoragePg();
  try {
    await runStorageMigrations(remote);
    const db = getDb();
    let rows = 0;
    for (const table of resolveTables(opts?.tables))
      rows += await pullTable(remote, db, table);
    return { rows };
  } finally {
    await remote.close();
  }
}

export async function storageSync(opts?: { tables?: string[] }): Promise<{
  push: number;
  pull: number;
}> {
  const push = await storagePush(opts);
  const pull = await storagePull(opts);
  return { push: push.rows, pull: pull.rows };
}

export function getStorageStatus(): StorageStatus {
  const activeEnv = getStorageDatabaseEnv();
  return {
    configured: Boolean(activeEnv),
    mode: getStorageMode(),
    env: STORAGE_DATABASE_ENV,
    activeEnv: activeEnv?.name ?? null,
    service: "logs",
    tables: STORAGE_TABLES,
  };
}

export function resolveTables(tables?: string[]): StorageTable[] {
  if (!tables || tables.length === 0) return [...STORAGE_TABLES];
  const allowed = new Set<string>(STORAGE_TABLES);
  const requested = tables.map((table) => table.trim()).filter(Boolean);
  const invalid = requested.filter((table) => !allowed.has(table));
  if (invalid.length > 0)
    throw new Error(`Unknown logs sync table(s): ${invalid.join(", ")}`);
  return requested as StorageTable[];
}

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function pushTable(
  db: Database,
  remote: PgAdapterAsync,
  table: string,
): Promise<number> {
  const rows = db.query(`SELECT * FROM ${quoteIdent(table)}`).all() as Row[];
  if (rows.length === 0) return 0;
  const firstRow = rows[0];
  if (!firstRow) return 0;
  const columns = await filterRemoteColumns(
    remote,
    table,
    Object.keys(firstRow),
  );
  await upsertPg(remote, table, columns, rows);
  return rows.length;
}

async function pullTable(
  remote: PgAdapterAsync,
  db: Database,
  table: string,
): Promise<number> {
  const rows = (await remote.all(
    `SELECT * FROM ${quoteIdent(table)}`,
  )) as Row[];
  if (rows.length === 0) return 0;
  const firstRow = rows[0];
  if (!firstRow) return 0;
  const columns = filterLocalColumns(db, table, Object.keys(firstRow));
  upsertSqlite(db, table, columns, rows);
  return rows.length;
}

async function filterRemoteColumns(
  remote: PgAdapterAsync,
  table: string,
  columns: string[],
): Promise<string[]> {
  const rows = (await remote.all(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ?
  `,
    table,
  )) as Array<{ column_name: string }>;
  if (rows.length === 0) return columns;
  const allowed = new Set(rows.map((row) => row.column_name));
  return columns.filter((column) => allowed.has(column));
}

function filterLocalColumns(
  db: Database,
  table: string,
  columns: string[],
): string[] {
  const rows = db
    .query(`PRAGMA table_info(${quoteIdent(table)})`)
    .all() as Array<{ name: string }>;
  const allowed = new Set(rows.map((row) => row.name));
  return columns.filter((column) => allowed.has(column));
}

async function upsertPg(
  remote: PgAdapterAsync,
  table: string,
  columns: string[],
  rows: Row[],
): Promise<void> {
  if (columns.length === 0) return;
  const primaryKey = primaryKeyFor(table);
  const columnList = columns.map(quoteIdent).join(", ");
  const updateColumns = columns.filter((column) => column !== primaryKey);
  const setClause =
    updateColumns.length > 0
      ? updateColumns
          .map(
            (column) =>
              `${quoteIdent(column)} = EXCLUDED.${quoteIdent(column)}`,
          )
          .join(", ")
      : `${quoteIdent(primaryKey)} = EXCLUDED.${quoteIdent(primaryKey)}`;

  for (const row of rows) {
    const placeholders = columns.map((_, index) => `$${index + 1}`).join(", ");
    const params = columns.map((column) =>
      coerceForPg(table, column, row[column]),
    );
    await remote.run(
      `INSERT INTO ${quoteIdent(table)} (${columnList}) VALUES (${placeholders})
       ON CONFLICT (${quoteIdent(primaryKey)}) DO UPDATE SET ${setClause}`,
      ...params,
    );
  }
}

function upsertSqlite(
  db: Database,
  table: string,
  columns: string[],
  rows: Row[],
): void {
  if (columns.length === 0) return;
  const primaryKey = primaryKeyFor(table);
  const columnList = columns.map(quoteIdent).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const updateColumns = columns.filter((column) => column !== primaryKey);
  const setClause =
    updateColumns.length > 0
      ? updateColumns
          .map(
            (column) =>
              `${quoteIdent(column)} = excluded.${quoteIdent(column)}`,
          )
          .join(", ")
      : `${quoteIdent(primaryKey)} = excluded.${quoteIdent(primaryKey)}`;
  const statement = db.prepare(
    `INSERT INTO ${quoteIdent(table)} (${columnList}) VALUES (${placeholders})
     ON CONFLICT (${quoteIdent(primaryKey)}) DO UPDATE SET ${setClause}`,
  );
  const insert = db.transaction((batch: Row[]) => {
    for (const row of batch)
      statement.run(...columns.map((column) => coerceForSqlite(row[column])));
  });
  insert(rows);
}

function primaryKeyFor(table: string): string {
  if (table === "event_records") return "event_id";
  if (table === "projection_offsets") return "projection_name";
  if (table === "sync_cursors") return "target_id";
  return "id";
}

function coerceForPg(table: string, column: string, value: unknown): unknown {
  if (value === undefined) return null;
  if (
    (table === "scan_jobs" || table === "alert_rules") &&
    column === "enabled"
  ) {
    return Boolean(value);
  }
  if (table === "test_reports" && column === "truncated") return Boolean(value);
  return value;
}

function coerceForSqlite(
  value: unknown,
): string | number | bigint | boolean | null | Uint8Array {
  if (value === undefined || value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  )
    return value;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
