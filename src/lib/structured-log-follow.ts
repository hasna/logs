import type { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type { LogRow } from "../types/index.ts";
import { ingestLog } from "./ingest.ts";
import {
  type StructuredLogOptions,
  structuredLogToEntry,
  validateStructuredLogReferences,
} from "./structured-logs.ts";

export interface FollowStructuredJsonLinesOptions extends StructuredLogOptions {
  from_end?: boolean;
  poll_ms?: number;
  idle_timeout_ms?: number;
  max_lines?: number;
  source_name?: string;
  on_row?: (row: LogRow) => void;
  signal?: AbortSignal;
}

export interface FollowStructuredJsonLinesResult {
  inserted: number;
  ids: string[];
  lines_read: number;
  bytes_read: number;
  truncated: number;
  started_at: string;
  ended_at: string;
}

const READ_BUFFER_BYTES = 64 * 1024;

export async function followStructuredJsonLines(
  db: Database,
  file: string,
  options: FollowStructuredJsonLinesOptions = {},
): Promise<FollowStructuredJsonLinesResult> {
  if (!existsSync(file)) throw new Error(`JSONL file does not exist: ${file}`);

  const startedAt = new Date().toISOString();
  const pollMs = positiveNumber(options.poll_ms, 250);
  const idleTimeoutMs = nonNegativeNumber(options.idle_timeout_ms);
  const maxLines = nonNegativeNumber(options.max_lines);
  const sourceName = options.source_name ?? file;
  let fd = openSync(file, "r");
  let offset = options.from_end ? statSync(file).size : 0;
  let pending = "";
  let pendingStartOffset = offset;
  let decoder = new TextDecoder();
  let lineNumber = 0;
  let bytesRead = 0;
  let truncated = 0;
  let lastActivity = Date.now();
  const ids: string[] = [];
  const reachedMaxLines = () =>
    maxLines !== undefined && ids.length >= maxLines;
  const ingestPendingCompleteLines = (): boolean => {
    while (true) {
      if (reachedMaxLines()) return false;
      const newline = pending.indexOf("\n");
      if (newline < 0) return true;
      const rawLine = pending.slice(0, newline).replace(/\r$/, "");
      const rawLineWithNewline = pending.slice(0, newline + 1);
      const lineStartOffset = pendingStartOffset;
      pending = pending.slice(newline + 1);
      pendingStartOffset += Buffer.byteLength(rawLineWithNewline, "utf8");
      lineNumber += 1;
      if (rawLine.trim().length === 0) continue;
      const row = ingestStructuredLine(db, rawLine, options, {
        index: ids.length,
        line: lineNumber,
        source: sourceName,
        byte_offset: lineStartOffset,
      });
      ids.push(row.id);
      options.on_row?.(row);
    }
  };

  try {
    while (!options.signal?.aborted) {
      if (reachedMaxLines()) break;

      const stat = statSync(file);
      if (stat.size < offset) {
        closeSync(fd);
        fd = openSync(file, "r");
        offset = 0;
        pending = "";
        pendingStartOffset = 0;
        decoder = new TextDecoder();
        truncated += 1;
        lastActivity = Date.now();
      }

      if (stat.size > offset) {
        const readResult = readAvailable(fd, offset, stat.size, (bytes) => {
          const text = decoder.decode(bytes, { stream: true });
          if (!text) return !reachedMaxLines();
          pending += text;
          return ingestPendingCompleteLines();
        });
        offset = readResult.next_offset;
        bytesRead += readResult.bytes_read;
        lastActivity = Date.now();
      }

      if (reachedMaxLines()) break;
      if (
        idleTimeoutMs !== undefined &&
        Date.now() - lastActivity >= idleTimeoutMs
      ) {
        break;
      }
      await sleep(pollMs);
    }

    if (!reachedMaxLines()) {
      const remainder = decoder.decode();
      if (remainder) pending += remainder;
    }

    if (!reachedMaxLines() && pending.trim().length > 0) {
      lineNumber += 1;
      const row = ingestStructuredLine(db, pending, options, {
        index: ids.length,
        line: lineNumber,
        source: sourceName,
        byte_offset: pendingStartOffset,
      });
      ids.push(row.id);
      options.on_row?.(row);
    }

    return {
      inserted: ids.length,
      ids,
      lines_read: lineNumber,
      bytes_read: bytesRead,
      truncated,
      started_at: startedAt,
      ended_at: new Date().toISOString(),
    };
  } finally {
    closeSync(fd);
  }
}

function ingestStructuredLine(
  db: Database,
  line: string,
  options: FollowStructuredJsonLinesOptions,
  position: {
    index: number;
    line: number;
    source: string;
    byte_offset: number;
  },
): LogRow {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw new Error(
      `line ${position.line}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const entry = structuredLogToEntry(parsed, options, position);
  validateStructuredLogReferences(db, [entry]);
  return ingestLog(db, entry);
}

function readAvailable(
  fd: number,
  startOffset: number,
  endOffset: number,
  onChunk: (bytes: Uint8Array, chunkStartOffset: number) => boolean | undefined,
): { next_offset: number; bytes_read: number } {
  const buffer = Buffer.alloc(
    Math.min(READ_BUFFER_BYTES, endOffset - startOffset),
  );
  let offset = startOffset;
  let bytesRead = 0;
  while (offset < endOffset) {
    const toRead = Math.min(buffer.byteLength, endOffset - offset);
    const read = readSync(fd, buffer, 0, toRead, offset);
    if (read <= 0) break;
    const shouldContinue = onChunk(buffer.subarray(0, read), offset);
    offset += read;
    bytesRead += read;
    if (shouldContinue === false) break;
  }
  return { next_offset: offset, bytes_read: bytesRead };
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function nonNegativeNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
