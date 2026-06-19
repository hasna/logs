import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";
import { type EventCatalogEntry, dashboardAuthHeaders } from "../api";

const LEVEL_COLOR: Record<string, string> = {
  debug: "#64748b",
  info: "#22d3ee",
  warn: "#fbbf24",
  error: "#f87171",
  fatal: "#c084fc",
};

interface TailProps {
  apiToken: string;
}

interface SseMessage {
  event: string;
  id: string | null;
  data: string;
}

export function Tail({ apiToken }: TailProps) {
  const [events, setEvents] = useState<EventCatalogEntry[]>([]);
  const [overflow, setOverflow] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const [lastEventId, setLastEventId] = useState<string | null>(null);
  const [connection, setConnection] = useState<
    "connecting" | "live" | "paused" | "reconnecting" | "blocked"
  >("connecting");
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastEventIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (paused) {
      setConnection("paused");
      return;
    }

    let stopped = false;
    const controller = new AbortController();

    const connect = async () => {
      while (!stopped) {
        const params = new URLSearchParams({ event_name: "event" });
        if (lastEventIdRef.current)
          params.set("last_event_id", lastEventIdRef.current);
        try {
          setConnection(lastEventIdRef.current ? "reconnecting" : "connecting");
          const response = await fetch(
            `/api/events/stream?${params.toString()}`,
            {
              headers: dashboardAuthHeaders(apiToken),
              signal: controller.signal,
            },
          );
          if (!response.ok) {
            setConnection("blocked");
            setOverflow(`stream ${response.status}`);
            return;
          }

          setConnection("live");
          for await (const message of readSseMessages(response.body)) {
            if (message.event === "overflow") {
              handleOverflowMessage(
                message,
                lastEventIdRef,
                setLastEventId,
                setOverflow,
              );
              continue;
            }
            handleEventMessage(
              message,
              lastEventIdRef,
              setLastEventId,
              setEvents,
            );
          }
        } catch (error) {
          if (stopped || controller.signal.aborted) return;
          setConnection("reconnecting");
          setOverflow(error instanceof Error ? error.message : "stream_error");
        }
        if (!stopped) await sleep(1000);
      }
    };

    void connect();
    return () => {
      stopped = true;
      controller.abort();
    };
  }, [paused, apiToken]);

  const filtered = filter
    ? events.filter((event) => eventMatchesFilter(event, filter))
    : events;
  const eventCount = events.length;

  useEffect(() => {
    if (!paused && eventCount > 0)
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [eventCount, paused]);

  return (
    <div>
      <div
        style={{
          display: "flex",
          gap: 12,
          marginBottom: 12,
          alignItems: "center",
        }}
      >
        <h2 style={{ margin: 0, color: "#38bdf8" }}>Live Events</h2>
        <input
          placeholder="Filter..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{
            background: "#1e293b",
            border: "1px solid #334155",
            color: "#e2e8f0",
            padding: "4px 8px",
            borderRadius: 4,
            fontFamily: "monospace",
          }}
        />
        <button
          type="button"
          onClick={() => setPaused((p) => !p)}
          style={{
            background: paused ? "#22d3ee" : "#334155",
            color: paused ? "#0f172a" : "#e2e8f0",
            border: "none",
            padding: "4px 12px",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          {paused ? "Resume" : "Pause"}
        </button>
        <button
          type="button"
          onClick={() => {
            setEvents([]);
            setOverflow(null);
          }}
          style={{
            background: "#334155",
            color: "#e2e8f0",
            border: "none",
            padding: "4px 12px",
            borderRadius: 4,
            cursor: "pointer",
          }}
        >
          Clear
        </button>
        <span
          style={{
            color: connection === "live" ? "#22d3ee" : "#fbbf24",
            fontSize: 12,
          }}
        >
          {connection}
        </span>
        <span style={{ color: "#64748b", fontSize: 12 }}>
          {filtered.length} events
        </span>
        {lastEventId && (
          <span
            title={lastEventId}
            style={{
              color: "#64748b",
              fontSize: 12,
              maxWidth: 220,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            cursor {lastEventId}
          </span>
        )}
        {overflow && (
          <span style={{ color: "#fbbf24", fontSize: 12 }}>{overflow}</span>
        )}
      </div>
      <div
        style={{
          background: "#020617",
          borderRadius: 8,
          padding: 12,
          height: "calc(100vh - 160px)",
          overflowY: "auto",
          fontSize: 13,
        }}
      >
        {filtered.map((event) => (
          <div
            key={event.event_id}
            style={{
              display: "grid",
              gridTemplateColumns: "164px 86px 70px 112px minmax(0, 1fr)",
              gap: 12,
              marginBottom: 2,
              lineHeight: 1.5,
            }}
          >
            <span style={{ color: "#475569" }}>
              {event.event_time.slice(0, 19).replace("T", " ")}
            </span>
            <span style={{ color: "#7dd3fc", fontWeight: 700 }}>
              {event.event_type}
            </span>
            <span
              style={{
                color: LEVEL_COLOR[event.severity ?? ""] ?? "#e2e8f0",
                fontWeight: 700,
              }}
            >
              {event.severity?.toUpperCase() ?? "-"}
            </span>
            <span style={{ color: "#93c5fd" }}>{event.source}</span>
            <span style={{ color: "#e2e8f0", wordBreak: "break-all" }}>
              {event.message ?? event.event_id}
            </span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function eventMatchesFilter(event: EventCatalogEntry, filter: string): boolean {
  const needle = filter.toLowerCase();
  return [
    event.event_id,
    event.event_type,
    event.source,
    event.severity,
    event.message,
    event.trace_id,
    event.run_id,
    event.process_id,
    event.metadata ? JSON.stringify(event.metadata) : null,
  ].some((value) => value?.toLowerCase().includes(needle));
}

function handleEventMessage(
  message: SseMessage,
  lastEventIdRef: MutableRefObject<string | null>,
  setLastEventId: (eventId: string) => void,
  setEvents: Dispatch<SetStateAction<EventCatalogEntry[]>>,
): void {
  try {
    const event = JSON.parse(message.data) as EventCatalogEntry;
    const cursor = message.id || event.event_id;
    lastEventIdRef.current = cursor;
    setLastEventId(cursor);
    setEvents((prev) => [
      ...prev.filter((item) => item.event_id !== event.event_id).slice(-499),
      event,
    ]);
  } catch {}
}

function handleOverflowMessage(
  message: SseMessage,
  lastEventIdRef: MutableRefObject<string | null>,
  setLastEventId: (eventId: string) => void,
  setOverflow: (overflow: string) => void,
): void {
  try {
    const data = JSON.parse(message.data) as {
      reason?: string;
      last_event_id?: string | null;
    };
    if (data.last_event_id) {
      lastEventIdRef.current = data.last_event_id;
      setLastEventId(data.last_event_id);
    }
    setOverflow(
      `${data.reason ?? "stream_overflow"}${data.last_event_id ? ` after ${data.last_event_id}` : ""}`,
    );
  } catch {
    setOverflow("stream_overflow");
  }
}

async function* readSseMessages(
  body: ReadableStream<Uint8Array> | null,
): AsyncGenerator<SseMessage> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let frameEnd = findSseFrameEnd(buffer);
      while (frameEnd >= 0) {
        const frame = buffer.slice(0, frameEnd);
        buffer = buffer.slice(
          frameEnd + frameSeparatorLength(buffer, frameEnd),
        );
        const message = parseSseFrame(frame);
        if (message) yield message;
        frameEnd = findSseFrameEnd(buffer);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseSseFrame(frame: string): SseMessage | null {
  const data: string[] = [];
  let event = "message";
  let id: string | null = null;
  for (const line of frame.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon >= 0 ? line.slice(0, colon) : line;
    const rawValue = colon >= 0 ? line.slice(colon + 1) : "";
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "event") event = value;
    if (field === "id") id = value;
    if (field === "data") data.push(value);
  }
  return data.length > 0 ? { event, id, data: data.join("\n") } : null;
}

function findSseFrameEnd(buffer: string): number {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf < 0) return crlf;
  if (crlf < 0) return lf;
  return Math.min(lf, crlf);
}

function frameSeparatorLength(buffer: string, index: number): number {
  return buffer.startsWith("\r\n\r\n", index) ? 4 : 2;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
