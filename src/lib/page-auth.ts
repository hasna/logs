import type { Database } from "bun:sqlite"
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

const SECRET_KEY = Buffer.from((process.env.LOGS_SECRET_KEY ?? "open-logs-default-key-32bytesXXX").padEnd(32).slice(0, 32))

export interface PageAuth {
  id: string
  page_id: string
  type: "cookie" | "bearer" | "basic"
  credentials: string
  created_at: string
}

function encrypt(text: string): string {
  const iv = randomBytes(16)
  const cipher = createCipheriv("aes-256-cbc", SECRET_KEY, iv)
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()])
  return iv.toString("hex") + ":" + encrypted.toString("hex")
}

function decrypt(text: string): string {
  const [ivHex, encHex] = text.split(":")
  if (!ivHex || !encHex) return text
  const iv = Buffer.from(ivHex, "hex")
  const enc = Buffer.from(encHex, "hex")
  const decipher = createDecipheriv("aes-256-cbc", SECRET_KEY, iv)
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8")
}

export function setPageAuth(db: Database, pageId: string, type: PageAuth["type"], credentials: string): PageAuth {
  const encrypted = encrypt(credentials)
  return db.prepare(`
    INSERT INTO page_auth (page_id, type, credentials)
    VALUES ($page_id, $type, $credentials)
    ON CONFLICT(page_id) DO UPDATE SET type = excluded.type, credentials = excluded.credentials
    RETURNING *
  `).get({ $page_id: pageId, $type: type, $credentials: encrypted }) as PageAuth
}

export function getPageAuth(db: Database, pageId: string): { type: PageAuth["type"]; credentials: string } | null {
  const row = db.prepare("SELECT * FROM page_auth WHERE page_id = $id").get({ $id: pageId }) as PageAuth | null
  if (!row) return null
  return { type: row.type, credentials: decrypt(row.credentials) }
}

export function deletePageAuth(db: Database, pageId: string): void {
  db.run("DELETE FROM page_auth WHERE page_id = $id", { $id: pageId })
}
