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
  /(?:authorization|cookie|set-cookie|api[_-]?key|token|secret|password|passwd|pwd|private[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?secret|client[_-]?secret)/i;
const SENSITIVE_FLAG =
  /^(?:authorization|auth|api[-_]?key|token|secret|password|passwd|pwd|private[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?secret|client[-_]?secret)$/i;
const SENSITIVE_FLAG_NAME =
  /(?:authorization|api[-_]?key|token|secret|password|passwd|pwd|private[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?secret|client[-_]?secret)/i;

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
      /\b(api[_-]?key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
    replacement: (_match, key: string) => `${key}=${REDACTED}`,
  },
  {
    label: "secret_flag_argument",
    pattern:
      /(--[A-Za-z0-9._-]*(?:authorization|api[-_]?key|token|secret|password|passwd|pwd|private[-_]?key|access[-_]?token|refresh[-_]?token|session[-_]?secret|client[-_]?secret)[A-Za-z0-9._-]*\s+)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
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
      /([?&](?:api[_-]?key|token|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token|auth|code)=)[^&#\s]+/gi,
    replacement: (_match, prefix: string) => `${prefix}${REDACTED}`,
  },
];

export function redactLogEntry(entry: LogEntry): RedactionResult<LogEntry> {
  const reports: RedactionReport[] = [];
  const next: LogEntry = { ...entry };

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
      matched = true;
      replacements += 1;
      if (typeof replacement === "function")
        return replacement(args[0] ?? "", ...args.slice(1));
      return replacement;
    });
    if (matched) fields.push(`${path}:${label}`);
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
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (SENSITIVE_KEY.test(key) && value !== null && value !== undefined) {
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

function isSensitiveFlag(value: string): boolean {
  const normalized = value.trim().replace(/^-+/, "");
  if (!normalized || normalized.includes("=")) return false;
  return (
    SENSITIVE_FLAG.test(normalized) ||
    SENSITIVE_FLAG_NAME.test(normalized) ||
    SENSITIVE_KEY.test(normalized.replace(/-/g, "_"))
  );
}
