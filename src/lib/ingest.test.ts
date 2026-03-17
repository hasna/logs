import { describe, expect, it } from "bun:test"
import { createTestDb } from "../db/index.ts"
import { ingestBatch, ingestLog } from "./ingest.ts"

describe("ingest", () => {
  it("inserts a single log entry", () => {
    const db = createTestDb()
    const row = ingestLog(db, { level: "error", message: "test error", service: "api" })
    expect(row.id).toBeTruthy()
    expect(row.level).toBe("error")
    expect(row.message).toBe("test error")
    expect(row.service).toBe("api")
    expect(row.source).toBe("sdk")
    expect(row.timestamp).toBeTruthy()
  })

  it("inserts with all optional fields", () => {
    const db = createTestDb()
    const row = ingestLog(db, {
      level: "info",
      message: "hello",
      source: "scanner",
      trace_id: "trace-123",
      session_id: "sess-456",
      agent: "brutus",
      url: "https://example.com",
      stack_trace: "Error at line 1",
      metadata: { foo: "bar" },
    })
    expect(row.trace_id).toBe("trace-123")
    expect(row.agent).toBe("brutus")
    expect(row.metadata).toBe(JSON.stringify({ foo: "bar" }))
  })

  it("inserts a batch", () => {
    const db = createTestDb()
    const rows = ingestBatch(db, [
      { level: "warn", message: "warn 1" },
      { level: "error", message: "err 1" },
      { level: "info", message: "info 1" },
    ])
    expect(rows).toHaveLength(3)
    expect(rows[0]!.level).toBe("warn")
    expect(rows[2]!.level).toBe("info")
  })

  it("batch is transactional", () => {
    const db = createTestDb()
    const before = (db.prepare("SELECT COUNT(*) as c FROM logs").get() as { c: number }).c
    ingestBatch(db, [
      { level: "debug", message: "a" },
      { level: "fatal", message: "b" },
    ])
    const after = (db.prepare("SELECT COUNT(*) as c FROM logs").get() as { c: number }).c
    expect(after - before).toBe(2)
  })
})
