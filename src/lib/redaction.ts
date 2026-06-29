import type { LogEntry } from "../types/index.ts";

export const REDACTED = "[REDACTED]";

export interface RedactionReport {
  applied: boolean;
  fields: string[];
  replacements: number;
}

export interface RedactionResult<T> {
  value: T;
  report: RedactionReport;
}

const SENSITIVE_KEY =
  /(?:authorization|cookie|set-cookie|credentials?\b|api[_-]?key|token|secret|password|passwd|pwd|private[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?secret|client[_-]?(?:secret|credentials?))/i;
const SENSITIVE_FLAG =
  /^(?:authorization|auth|credentials?|api[-_]?key|token|secret|password|passwd|pwd|private[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?secret|client[-_]?(?:secret|credentials?))$/i;
const SENSITIVE_FLAG_NAME =
  /(?:authorization|credentials?\b|api[-_]?key|token|secret|password|passwd|pwd|private[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?secret|client[-_]?(?:secret|credentials?))/i;
const SENSITIVE_PAIR_NAME_KEYS = new Set(["name", "key", "header"]);
const SENSITIVE_PAIR_VALUE_KEYS = new Set(["value", "values"]);
const LOG_ENTRY_REDACTABLE_TOP_LEVEL_FIELDS = [
  "id",
  "source_event_id",
  "service",
  "machine_id",
  "repo_id",
  "app_id",
  "process_id",
  "run_id",
  "trace_id",
  "span_id",
  "parent_span_id",
  "session_id",
  "release_id",
  "environment",
  "agent",
] as const;

const STRING_PATTERNS: Array<{
  label: string;
  pattern: RegExp;
  replacement: string | ((match: string, ...args: string[]) => string);
}> = [
  {
    label: "openlogs_canary",
    pattern: /\b(?:OPENLOGS|LOGS)[_-]?SECRET[_-]?CANARY[_-]?[A-Za-z0-9._-]*/gi,
    replacement: REDACTED,
  },
  {
    label: "bearer_token",
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
    replacement: `Bearer ${REDACTED}`,
  },
  {
    label: "basic_auth",
    pattern:
      /\b([A-Za-z0-9_-]*Authorization\b\s*(?::|=|\\?["']\s*:\s*\\?["']?)\s*\\?["']?Basic\s+)[A-Za-z0-9+/=._~-]+/gi,
    replacement: (_match, prefix: string) => `${prefix}${REDACTED}`,
  },
  {
    label: "url_userinfo",
    pattern: /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^@\s/?#]+@)(?=[^\s/?#]+)/g,
    replacement: (_match, scheme: string) => `${scheme}${REDACTED}@`,
  },
  {
    label: "github_token",
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g,
    replacement: REDACTED,
  },
  {
    label: "github_pat",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replacement: REDACTED,
  },
  {
    label: "openai_key",
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    replacement: REDACTED,
  },
  {
    label: "aws_access_key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: REDACTED,
  },
  {
    label: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replacement: REDACTED,
  },
  {
    label: "email",
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    replacement: REDACTED,
  },
  {
    label: "secret_assignment",
    pattern:
      /(?<![?&])\b(credentials?|api[_-]?key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token|client[_-]?(?:secret|credentials?))\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
    replacement: (match: string, key: string, value: string) =>
      isKnownNonSecretCredentialAssignment(key, value)
        ? match
        : `${key}=${REDACTED}`,
  },
  {
    label: "secret_flag_argument",
    pattern:
      /(--[A-Za-z0-9._-]*(?:authorization|credentials?(?!ed)|api[-_]?key|token|secret|password|passwd|pwd|private[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?secret|client[-_]?(?:secret|credentials?(?!ed)))[A-Za-z0-9._-]*\s+)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
    replacement: (_match, prefix: string) => `${prefix}${REDACTED}`,
  },
  {
    label: "auth_flag_argument",
    pattern: /(--auth\s+)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
    replacement: (_match, prefix: string) => `${prefix}${REDACTED}`,
  },
  {
    label: "secret_query_param",
    pattern:
      /([?&](?:credentials?|api[_-]?key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token|client[_-]?credentials?|auth|code)=)[^&#\s]+/gi,
    replacement: (_match, prefix: string) => `${prefix}${REDACTED}`,
  },
];

export function redactLogEntry(entry: LogEntry): RedactionResult<LogEntry> {
  const reports: RedactionReport[] = [];
  const next: LogEntry = { ...entry };

  for (const field of LOG_ENTRY_REDACTABLE_TOP_LEVEL_FIELDS) {
    const value = entry[field];
    if (typeof value !== "string") continue;
    const result = redactString(value, field);
    next[field] = result.value;
    reports.push(result.report);
  }
  if (typeof entry.message === "string") {
    const result = redactString(entry.message, "message");
    next.message = result.value;
    reports.push(result.report);
  }
  if (typeof entry.url === "string") {
    const result = redactString(entry.url, "url");
    next.url = result.value;
    reports.push(result.report);
  }
  if (typeof entry.stack_trace === "string") {
    const result = redactString(entry.stack_trace, "stack_trace");
    next.stack_trace = result.value;
    reports.push(result.report);
  }
  if (entry.metadata) {
    const result = redactValue(entry.metadata, "metadata");
    next.metadata = result.value as Record<string, unknown>;
    reports.push(result.report);
  }

  const report = mergeRedactionReports(...reports);
  if (report.applied) {
    next.metadata = {
      ...(next.metadata ?? {}),
      redaction: redactionMetadata(report),
    };
  }

  return { value: next, report };
}

export function redactString(
  input: string,
  path = "$",
): RedactionResult<string> {
  let output = input;
  const fields: string[] = [];
  let replacements = 0;

  for (const { label, pattern, replacement } of STRING_PATTERNS) {
    let matched = false;
    output = output.replace(pattern, (...args: string[]) => {
      const original = args[0] ?? "";
      const next =
        typeof replacement === "function"
          ? replacement(original, ...args.slice(1))
          : replacement;
      if (next !== original) {
        matched = true;
        replacements += 1;
      }
      return next;
    });
    if (matched) fields.push(`${path}:${label}`);
  }

  const cookieResult = redactCookieHeaderText(output);
  if (cookieResult.replacements > 0) {
    output = cookieResult.value;
    fields.push(`${path}:cookie_header`);
    replacements += cookieResult.replacements;
  }

  return {
    value: output,
    report: { applied: replacements > 0, fields, replacements },
  };
}

export function redactValue<T>(
  input: T,
  path = "$",
  depth = 0,
): RedactionResult<T> {
  if (input === null || input === undefined) {
    return { value: input, report: emptyReport() };
  }

  if (typeof input === "string") {
    return redactString(input, path) as RedactionResult<T>;
  }

  if (typeof input !== "object" || depth >= 12) {
    return { value: input, report: emptyReport() };
  }

  if (Array.isArray(input)) {
    const values: unknown[] = [];
    const reports: RedactionReport[] = [];
    let previousWasSensitiveFlag = false;
    input.forEach((item, index) => {
      const itemPath = `${path}[${index}]`;
      if (previousWasSensitiveFlag && typeof item === "string") {
        values.push(REDACTED);
        reports.push({ applied: true, fields: [itemPath], replacements: 1 });
        previousWasSensitiveFlag = false;
        return;
      }

      const result = redactValue(item, `${path}[${index}]`, depth + 1);
      values.push(result.value);
      reports.push(result.report);
      previousWasSensitiveFlag =
        typeof result.value === "string" && isSensitiveFlag(result.value);
    });
    return { value: values as T, report: mergeRedactionReports(...reports) };
  }

  const values: Record<string, unknown> = {};
  const reports: RedactionReport[] = [];
  const record = input as Record<string, unknown>;
  const pairName = sensitivePairName(record);
  for (const [key, value] of Object.entries(record)) {
    const childPath = `${path}.${key}`;
    if (shouldRedactSensitivePairValue(pairName, key, value)) {
      values[key] = REDACTED;
      reports.push({ applied: true, fields: [childPath], replacements: 1 });
      continue;
    }

    if (shouldRedactSensitiveKeyValue(key, value)) {
      values[key] = REDACTED;
      reports.push({ applied: true, fields: [childPath], replacements: 1 });
      continue;
    }

    const result = redactValue(value, childPath, depth + 1);
    values[key] = result.value;
    reports.push(result.report);
  }

  return { value: values as T, report: mergeRedactionReports(...reports) };
}

export function mergeRedactionReports(
  ...reports: RedactionReport[]
): RedactionReport {
  const fields = [...new Set(reports.flatMap((report) => report.fields))];
  const replacements = reports.reduce(
    (sum, report) => sum + report.replacements,
    0,
  );
  return {
    applied: replacements > 0,
    fields,
    replacements,
  };
}

export function redactionMetadata(
  report: RedactionReport,
): Record<string, unknown> {
  return {
    applied: report.applied,
    fields: report.fields,
    replacements: report.replacements,
  };
}

function emptyReport(): RedactionReport {
  return { applied: false, fields: [], replacements: 0 };
}

interface ReplacementRange {
  start: number;
  end: number;
}

interface QuoteToken {
  quote: string;
  escaped: boolean;
  length: number;
}

interface ParsedQuotedString {
  contentStart: number;
  contentEnd: number;
  end: number;
}

function redactCookieHeaderText(input: string): {
  value: string;
  replacements: number;
} {
  const ranges: ReplacementRange[] = [];
  const keyPattern = /set-cookie|cookie/gi;
  let match = keyPattern.exec(input);

  while (match) {
    const keyStart = match.index;
    const keyEnd = keyStart + match[0].length;

    if (hasCookieKeyBoundary(input, keyStart, keyEnd)) {
      const quotedKey = parseQuotedKeyContext(input, keyStart, keyEnd);
      if (quotedKey) {
        const afterKey = skipHorizontalWhitespace(input, quotedKey.afterKey);
        if (input[afterKey] === ":") {
          collectCookieMapValueRanges(input, afterKey + 1, ranges);
          match = keyPattern.exec(input);
          continue;
        }
        if (input[afterKey] === ",") {
          const value = parseQuotedString(
            input,
            skipHorizontalWhitespace(input, afterKey + 1),
          );
          if (value) ranges.push(quotedStringRange(value));
          match = keyPattern.exec(input);
          continue;
        }
      }

      collectPlainCookieHeaderRange(input, keyEnd, ranges);
    }
    match = keyPattern.exec(input);
  }

  return applyReplacementRanges(input, ranges);
}

function hasCookieKeyBoundary(
  input: string,
  start: number,
  end: number,
): boolean {
  return (
    !isCookieKeyCharacter(input[start - 1]) && !isCookieKeyCharacter(input[end])
  );
}

function isCookieKeyCharacter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_-]/.test(value);
}

function parseQuotedKeyContext(
  input: string,
  start: number,
  end: number,
): { afterKey: number } | null {
  const before = readQuoteBefore(input, start);
  const after = readQuoteAt(input, end);
  if (!before || !after) return null;
  if (before.quote !== after.quote || before.escaped !== after.escaped) {
    return null;
  }
  return { afterKey: end + after.length };
}

function collectCookieMapValueRanges(
  input: string,
  start: number,
  ranges: ReplacementRange[],
): void {
  const valueStart = skipHorizontalWhitespace(input, start);
  if (input[valueStart] === "[") {
    collectQuotedArrayValueRanges(input, valueStart, ranges);
    return;
  }
  const value = parseQuotedString(input, valueStart);
  if (value) ranges.push(quotedStringRange(value));
}

function collectQuotedArrayValueRanges(
  input: string,
  start: number,
  ranges: ReplacementRange[],
): void {
  let index = start + 1;
  while (index < input.length) {
    index = skipHorizontalWhitespace(input, index);
    if (input[index] === "]" || isLineBreak(input[index])) return;

    const value = parseQuotedString(input, index);
    if (value) {
      ranges.push(quotedStringRange(value));
      index = value.end;
      continue;
    }

    index += 1;
  }
}

function collectPlainCookieHeaderRange(
  input: string,
  start: number,
  ranges: ReplacementRange[],
): void {
  let index = skipHorizontalWhitespace(input, start);
  if (input[index] !== ":" && input[index] !== "=") return;
  index = skipHorizontalWhitespace(input, index + 1);
  const end = findLineEnd(input, index);
  if (end > index) ranges.push({ start: index, end });
}

function parseQuotedString(
  input: string,
  start: number,
): ParsedQuotedString | null {
  const open = readQuoteAt(input, start);
  if (!open) return null;

  const contentStart = start + open.length;
  const closeStart = findClosingQuote(input, contentStart, open);
  if (closeStart === null) return null;
  return {
    contentStart,
    contentEnd: closeStart,
    end: closeStart + open.length,
  };
}

function quotedStringRange(value: ParsedQuotedString): ReplacementRange {
  return { start: value.contentStart, end: value.contentEnd };
}

function findClosingQuote(
  input: string,
  start: number,
  token: QuoteToken,
): number | null {
  let index = start;
  while (index < input.length) {
    if (isLineBreak(input[index])) return null;

    if (token.escaped) {
      if (input[index] === "\\" && input[index + 1] === token.quote) {
        const slashCount = countContiguousBackslashesEndingAt(input, index);
        if (slashCount === 1) return index;
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    if (input[index] === "\\") {
      index += 2;
      continue;
    }
    if (input[index] === token.quote) return index;
    index += 1;
  }
  return null;
}

function readQuoteBefore(input: string, index: number): QuoteToken | null {
  const escapedQuote = input.slice(index - 2, index);
  if (escapedQuote === '\\"' || escapedQuote === "\\'") {
    const quote = escapedQuote[1];
    if (!quote) return null;
    return { quote, escaped: true, length: 2 };
  }
  const quote = input[index - 1];
  return quote === '"' || quote === "'"
    ? { quote, escaped: false, length: 1 }
    : null;
}

function readQuoteAt(input: string, index: number): QuoteToken | null {
  const escapedQuote = input.slice(index, index + 2);
  if (escapedQuote === '\\"' || escapedQuote === "\\'") {
    const quote = escapedQuote[1];
    if (!quote) return null;
    return { quote, escaped: true, length: 2 };
  }
  const quote = input[index];
  return quote === '"' || quote === "'"
    ? { quote, escaped: false, length: 1 }
    : null;
}

function skipHorizontalWhitespace(input: string, start: number): number {
  let index = start;
  while (input[index] === " " || input[index] === "\t") index += 1;
  return index;
}

function findLineEnd(input: string, start: number): number {
  let index = start;
  while (index < input.length && !isLineBreak(input[index])) index += 1;
  return index;
}

function isLineBreak(value: string | undefined): boolean {
  return value === "\n" || value === "\r";
}

function countContiguousBackslashesEndingAt(
  input: string,
  index: number,
): number {
  let count = 0;
  let cursor = index;
  while (cursor >= 0 && input[cursor] === "\\") {
    count += 1;
    cursor -= 1;
  }
  return count;
}

function applyReplacementRanges(
  input: string,
  ranges: ReplacementRange[],
): { value: string; replacements: number } {
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);
  const deduped: ReplacementRange[] = [];
  let lastEnd = -1;
  for (const range of sorted) {
    if (range.start < lastEnd) continue;
    deduped.push(range);
    lastEnd = range.end;
  }

  let value = input;
  let replacements = 0;
  for (let index = deduped.length - 1; index >= 0; index -= 1) {
    const range = deduped[index];
    if (!range) continue;
    if (value.slice(range.start, range.end) === REDACTED) continue;
    value = `${value.slice(0, range.start)}${REDACTED}${value.slice(range.end)}`;
    replacements += 1;
  }

  return { value, replacements };
}

function isSensitiveFlag(value: string): boolean {
  const normalized = value.trim().replace(/^-+/, "");
  if (!normalized || normalized.includes("=")) return false;
  return (
    SENSITIVE_FLAG.test(normalized) ||
    SENSITIVE_FLAG_NAME.test(normalized) ||
    SENSITIVE_KEY.test(normalized.replace(/-/g, "_"))
  );
}

function shouldRedactSensitiveKeyValue(key: string, value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (!SENSITIVE_KEY.test(key)) return false;
  return !isKnownNonSecretCredentialMode(key, value);
}

function shouldRedactSensitivePairValue(
  pairName: string | null,
  key: string,
  value: unknown,
): boolean {
  if (!pairName || value === null || value === undefined) return false;
  if (!SENSITIVE_PAIR_VALUE_KEYS.has(key.toLowerCase())) return false;
  return !isKnownNonSecretCredentialMode(pairName, value);
}

function sensitivePairName(record: Record<string, unknown>): string | null {
  for (const [key, value] of Object.entries(record)) {
    if (!SENSITIVE_PAIR_NAME_KEYS.has(key.toLowerCase())) continue;
    if (typeof value !== "string") continue;
    if (isSensitiveNameValuePairName(value)) return value;
  }
  return null;
}

function isSensitiveNameValuePairName(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return false;
  return (
    isSensitiveFlag(normalized) ||
    SENSITIVE_KEY.test(normalized.replace(/-/g, "_"))
  );
}

function isKnownNonSecretCredentialMode(key: string, value: unknown): boolean {
  return (
    key.toLowerCase() === "credentials" &&
    typeof value === "string" &&
    isKnownFetchCredentialMode(value)
  );
}

function isKnownNonSecretCredentialAssignment(
  key: string,
  value: string,
): boolean {
  return (
    key.toLowerCase() === "credentials" && isKnownFetchCredentialMode(value)
  );
}

function isKnownFetchCredentialMode(value: string): boolean {
  const trimmed = value.trim();
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed;
  return /^(?:include|omit|same-origin)$/i.test(unquoted);
}
