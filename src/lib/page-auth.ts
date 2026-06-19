import type { Database } from "bun:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getEventStoreDataDir } from "./event-store.ts";
import { sqlBindings } from "./sqlite-bindings.ts";

const LOCAL_PAGE_AUTH_SECRET_FILE = "page-auth.key";

export interface PageAuth {
  id: string;
  page_id: string;
  type: "cookie" | "bearer" | "basic";
  credentials: string;
  created_at: string;
}

function encrypt(db: Database, text: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", pageAuthSecretKey(db), iv);
  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);
  return [
    "v2",
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    encrypted.toString("hex"),
  ].join(":");
}

function decrypt(db: Database, text: string): string {
  const parts = text.split(":");
  if (parts[0] === "v2") {
    const [, ivHex, tagHex, encHex] = parts;
    if (!ivHex || !tagHex || !encHex)
      throw new Error("Invalid page auth secret format");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      pageAuthSecretKey(db),
      Buffer.from(ivHex, "hex"),
    );
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([
      decipher.update(Buffer.from(encHex, "hex")),
      decipher.final(),
    ]).toString("utf8");
  }

  const [ivHex, encHex] = parts;
  if (!ivHex || !encHex) return text;
  const decipher = createDecipheriv(
    "aes-256-cbc",
    legacyPageAuthSecretKey(db),
    Buffer.from(ivHex, "hex"),
  );
  return Buffer.concat([
    decipher.update(Buffer.from(encHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

export function setPageAuth(
  db: Database,
  pageId: string,
  type: PageAuth["type"],
  credentials: string,
): PageAuth {
  const encrypted = encrypt(db, credentials);
  return db
    .prepare(`
    INSERT INTO page_auth (page_id, type, credentials)
    VALUES ($page_id, $type, $credentials)
    ON CONFLICT(page_id) DO UPDATE SET type = excluded.type, credentials = excluded.credentials
    RETURNING *
  `)
    .get(
      sqlBindings({
        $page_id: pageId,
        $type: type,
        $credentials: encrypted,
      }),
    ) as PageAuth;
}

export function getPageAuth(
  db: Database,
  pageId: string,
): { type: PageAuth["type"]; credentials: string } | null {
  const row = db
    .prepare("SELECT * FROM page_auth WHERE page_id = $id")
    .get(sqlBindings({ $id: pageId })) as PageAuth | null;
  if (!row) return null;
  return { type: row.type, credentials: decrypt(db, row.credentials) };
}

export function deletePageAuth(db: Database, pageId: string): void {
  db.prepare("DELETE FROM page_auth WHERE page_id = $id").run(
    sqlBindings({ $id: pageId }),
  );
}

function pageAuthSecretKey(db: Database): Buffer {
  const secret = pageAuthSecret(db);
  if (/^[a-f0-9]{64}$/i.test(secret)) return Buffer.from(secret, "hex");
  return createHash("sha256").update(secret).digest();
}

function legacyPageAuthSecretKey(db: Database): Buffer {
  return Buffer.from(pageAuthSecret(db).padEnd(32).slice(0, 32));
}

function pageAuthSecret(db: Database): string {
  const secret =
    process.env.HASNA_LOGS_SECRET_KEY?.trim() ||
    process.env.LOGS_SECRET_KEY?.trim();
  if (!secret) return readOrCreateLocalPageAuthSecret(db);
  if (secret.length < 32) {
    throw new Error(
      "Page auth secret must be at least 32 characters. Generate one with: openssl rand -hex 32",
    );
  }
  return secret;
}

function readOrCreateLocalPageAuthSecret(db: Database): string {
  const dataDir = getEventStoreDataDir(db);
  const secretPath = join(dataDir, LOCAL_PAGE_AUTH_SECRET_FILE);
  mkdirSync(dataDir, { recursive: true });

  if (existsSync(secretPath)) return readLocalPageAuthSecret(secretPath);

  const secret = randomBytes(32).toString("hex");
  try {
    writeFileSync(secretPath, `${secret}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  chmodSync(secretPath, 0o600);
  return readLocalPageAuthSecret(secretPath);
}

function readLocalPageAuthSecret(secretPath: string): string {
  const secret = readFileSync(secretPath, "utf8").trim();
  if (secret.length < 32) {
    throw new Error(
      `Page auth secret file ${secretPath} must contain at least 32 characters.`,
    );
  }
  return secret;
}
