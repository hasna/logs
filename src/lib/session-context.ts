import type { Database } from "bun:sqlite"
import type { LogRow } from "../types/index.ts"

export interface SessionContext {
  session_id: string
  logs: LogRow[]
  session?: Record<string, unknown>
  error?: string
}

export async function getSessionContext(db: Database, sessionId: string): Promise<SessionContext> {
  const logs = db.prepare("SELECT * FROM logs WHERE session_id = $s ORDER BY timestamp ASC")
    .all({ $s: sessionId }) as LogRow[]

  const sessionsUrl = process.env.SESSIONS_URL
  if (!sessionsUrl) {
    return { session_id: sessionId, logs }
  }

  try {
    const res = await fetch(`${sessionsUrl.replace(/\/$/, "")}/api/sessions/${sessionId}`)
    if (!res.ok) return { session_id: sessionId, logs }
    const session = await res.json() as Record<string, unknown>
    return { session_id: sessionId, logs, session }
  } catch (err) {
    return { session_id: sessionId, logs, error: String(err) }
  }
}
