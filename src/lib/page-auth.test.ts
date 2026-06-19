import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createTestDb } from "../db/index.ts";
import { getEventStoreDataDir } from "./event-store.ts";
import { deletePageAuth, getPageAuth, setPageAuth } from "./page-auth.ts";

const TEST_SECRET =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const ORIGINAL_SECRET = process.env.HASNA_LOGS_SECRET_KEY;
const ORIGINAL_LEGACY_SECRET = process.env.LOGS_SECRET_KEY;
const ORIGINAL_DATA_DIR = process.env.HASNA_LOGS_DATA_DIR;
const ORIGINAL_LEGACY_DATA_DIR = process.env.LOGS_DATA_DIR;

beforeEach(() => {
  process.env.HASNA_LOGS_SECRET_KEY = TEST_SECRET;
  process.env.LOGS_SECRET_KEY = undefined;
  process.env.HASNA_LOGS_DATA_DIR = undefined;
  process.env.LOGS_DATA_DIR = undefined;
});

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) {
    process.env.HASNA_LOGS_SECRET_KEY = undefined;
  } else {
    process.env.HASNA_LOGS_SECRET_KEY = ORIGINAL_SECRET;
  }
  if (ORIGINAL_LEGACY_SECRET === undefined) {
    process.env.LOGS_SECRET_KEY = undefined;
  } else {
    process.env.LOGS_SECRET_KEY = ORIGINAL_LEGACY_SECRET;
  }
  if (ORIGINAL_DATA_DIR === undefined) {
    process.env.HASNA_LOGS_DATA_DIR = undefined;
  } else {
    process.env.HASNA_LOGS_DATA_DIR = ORIGINAL_DATA_DIR;
  }
  if (ORIGINAL_LEGACY_DATA_DIR === undefined) {
    process.env.LOGS_DATA_DIR = undefined;
  } else {
    process.env.LOGS_DATA_DIR = ORIGINAL_LEGACY_DATA_DIR;
  }
});

function seedPage(db: ReturnType<typeof createTestDb>) {
  const p = db
    .prepare("INSERT INTO projects (name) VALUES ('app') RETURNING id")
    .get() as { id: string };
  const page = db
    .prepare(
      "INSERT INTO pages (project_id, url) VALUES (?, 'https://app.com') RETURNING id",
    )
    .get(p.id) as { id: string };
  return { projectId: p.id, pageId: page.id };
}

describe("page auth", () => {
  it("sets and retrieves bearer auth", () => {
    const db = createTestDb();
    const { pageId } = seedPage(db);
    setPageAuth(db, pageId, "bearer", "my-token-123");
    const auth = getPageAuth(db, pageId);
    expect(auth?.type).toBe("bearer");
    expect(auth?.credentials).toBe("my-token-123");
  });

  it("credentials are encrypted at rest", () => {
    const db = createTestDb();
    const { pageId } = seedPage(db);
    setPageAuth(db, pageId, "bearer", "secret-token");
    const raw = db
      .prepare("SELECT credentials FROM page_auth WHERE page_id = ?")
      .get(pageId) as { credentials: string };
    expect(raw.credentials).not.toBe("secret-token");
    expect(raw.credentials).toStartWith("v2:");
  });

  it("generates a local per-data-dir page-auth secret when no env secret is configured", () => {
    process.env.HASNA_LOGS_SECRET_KEY = undefined;
    process.env.LOGS_SECRET_KEY = undefined;

    const db = createTestDb();
    const { pageId } = seedPage(db);
    setPageAuth(db, pageId, "bearer", "secret-token");

    const secretPath = join(getEventStoreDataDir(db), "page-auth.key");
    expect(existsSync(secretPath)).toBe(true);
    expect(statSync(secretPath).mode & 0o777).toBe(0o600);
    expect(getPageAuth(db, pageId)?.credentials).toBe("secret-token");
  });

  it("upserts on duplicate page_id", () => {
    const db = createTestDb();
    const { pageId } = seedPage(db);
    setPageAuth(db, pageId, "bearer", "token-v1");
    setPageAuth(db, pageId, "bearer", "token-v2");
    const auth = getPageAuth(db, pageId);
    expect(auth?.credentials).toBe("token-v2");
    const { c } = db
      .prepare("SELECT COUNT(*) as c FROM page_auth WHERE page_id = ?")
      .get(pageId) as { c: number };
    expect(c).toBe(1);
  });

  it("returns null for unknown page", () => {
    const db = createTestDb();
    expect(getPageAuth(db, "nope")).toBeNull();
  });

  it("deletes auth", () => {
    const db = createTestDb();
    const { pageId } = seedPage(db);
    setPageAuth(db, pageId, "basic", "user:pass");
    deletePageAuth(db, pageId);
    expect(getPageAuth(db, pageId)).toBeNull();
  });
});
