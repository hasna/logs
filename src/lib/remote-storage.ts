import pg from "pg";
import type { Pool, PoolConfig } from "pg";

function translatePlaceholders(sql: string): string {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function normalizeParams(params: unknown[]): unknown[] {
  const flat =
    params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
  return flat.map((value) => (value === undefined ? null : value));
}

const UNSAFE_SSL_MODES = new Set(["disable", "allow", "prefer", "no-verify"]);
const ENABLED_SSL_VALUES = new Set([
  "1",
  "true",
  "require",
  "verify-ca",
  "verify-full",
]);
const DISABLED_SSL_VALUES = new Set(["0", "false", "no", "disable"]);

function isLocalHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost")
  );
}

export function buildPgPoolConfig(connectionString: string): PoolConfig {
  const url = new URL(connectionString);
  const mode = url.searchParams.get("sslmode")?.trim().toLowerCase();
  const ssl = url.searchParams.get("ssl")?.trim().toLowerCase();
  const isLocal = isLocalHost(url.hostname);

  if (!isLocal && mode && UNSAFE_SSL_MODES.has(mode)) {
    throw new Error(`Unsafe PostgreSQL sslmode for logs storage: ${mode}`);
  }
  if (!isLocal && ssl && DISABLED_SSL_VALUES.has(ssl)) {
    throw new Error(`Unsafe PostgreSQL ssl setting for logs storage: ${ssl}`);
  }

  const shouldUseTls =
    Boolean(mode && ENABLED_SSL_VALUES.has(mode)) ||
    Boolean(ssl && ENABLED_SSL_VALUES.has(ssl)) ||
    !isLocal;

  url.searchParams.delete("sslmode");
  url.searchParams.delete("ssl");

  return shouldUseTls
    ? { connectionString: url.toString(), ssl: true }
    : { connectionString: url.toString() };
}

export class LogsPostgresStorage {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool(buildPgPoolConfig(connectionString));
  }

  async run(sql: string, ...params: unknown[]): Promise<{ changes: number }> {
    const result = await this.pool.query(
      translatePlaceholders(sql),
      normalizeParams(params),
    );
    return { changes: result.rowCount ?? 0 };
  }

  async get(sql: string, ...params: unknown[]): Promise<unknown> {
    const result = await this.pool.query(
      translatePlaceholders(sql),
      normalizeParams(params),
    );
    return result.rows[0] ?? null;
  }

  async all(sql: string, ...params: unknown[]): Promise<unknown[]> {
    const result = await this.pool.query(
      translatePlaceholders(sql),
      normalizeParams(params),
    );
    return result.rows;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export { LogsPostgresStorage as PgAdapterAsync };
