import type { Context } from "hono";

export type JsonObject = Record<string, unknown>;
export type ValidationStatus = 400 | 413 | 415 | 422;

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: ValidationStatus; message: string };

export async function readJsonObject(
  c: Context,
  opts: {
    allowedKeys?: readonly string[];
    maxPayloadBytes?: number;
  } = {},
): Promise<ValidationResult<JsonObject>> {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return {
      ok: false,
      status: 415,
      message: "Content-Type must be application/json",
    };
  }

  const maxPayloadBytes =
    opts.maxPayloadBytes ??
    readPositiveInt("HASNA_LOGS_MAX_PAYLOAD_BYTES", 1_048_576);
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxPayloadBytes) {
    return {
      ok: false,
      status: 413,
      message: `Payload exceeds ${maxPayloadBytes} bytes`,
    };
  }

  let raw = "";
  try {
    raw = await c.req.text();
  } catch {
    return { ok: false, status: 400, message: "Unable to read request body" };
  }

  if (Buffer.byteLength(raw, "utf8") > maxPayloadBytes) {
    return {
      ok: false,
      status: 413,
      message: `Payload exceeds ${maxPayloadBytes} bytes`,
    };
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, message: "Invalid JSON body" };
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 422, message: "body must be an object" };
  }

  const objectBody = body as JsonObject;
  if (opts.allowedKeys) {
    const allowed = new Set(opts.allowedKeys);
    for (const key of Object.keys(objectBody)) {
      if (!allowed.has(key)) {
        return {
          ok: false,
          status: 422,
          message: `body.${key} is not a supported field`,
        };
      }
    }
  }

  return { ok: true, value: objectBody };
}

export function requiredString(
  body: JsonObject,
  key: string,
): ValidationResult<string> {
  const value = body[key];
  if (typeof value !== "string" || value.length === 0) {
    return {
      ok: false,
      status: 422,
      message: `body.${key} must be a non-empty string`,
    };
  }
  return { ok: true, value };
}

export function optionalString(
  body: JsonObject,
  key: string,
): ValidationResult<string | undefined> {
  const value = body[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") {
    return { ok: false, status: 422, message: `body.${key} must be a string` };
  }
  return { ok: true, value };
}

export function optionalStringArray(
  body: JsonObject,
  key: string,
  opts: { maxItems?: number } = {},
): ValidationResult<string[] | undefined> {
  const value = body[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(value)) {
    return {
      ok: false,
      status: 422,
      message: `body.${key} must be an array of strings`,
    };
  }
  if (opts.maxItems !== undefined && value.length > opts.maxItems) {
    return {
      ok: false,
      status: 422,
      message: `body.${key} must have at most ${opts.maxItems} item(s)`,
    };
  }
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      return {
        ok: false,
        status: 422,
        message: `body.${key} must be an array of non-empty strings`,
      };
    }
    strings.push(item);
  }
  return { ok: true, value: strings };
}

export function optionalNumber(
  body: JsonObject,
  key: string,
  opts: { integer?: boolean; min?: number; max?: number } = {},
): ValidationResult<number | undefined> {
  const value = body[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, status: 422, message: `body.${key} must be a number` };
  }
  if (opts.integer && !Number.isInteger(value)) {
    return {
      ok: false,
      status: 422,
      message: `body.${key} must be an integer`,
    };
  }
  if (opts.min !== undefined && value < opts.min) {
    return {
      ok: false,
      status: 422,
      message: `body.${key} must be >= ${opts.min}`,
    };
  }
  if (opts.max !== undefined && value > opts.max) {
    return {
      ok: false,
      status: 422,
      message: `body.${key} must be <= ${opts.max}`,
    };
  }
  return { ok: true, value };
}

export function optionalEnum<T extends string>(
  body: JsonObject,
  key: string,
  values: readonly T[],
): ValidationResult<T | undefined> {
  const value = body[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string" || !values.includes(value as T)) {
    return {
      ok: false,
      status: 422,
      message: `body.${key} must be one of ${values.join(", ")}`,
    };
  }
  return { ok: true, value: value as T };
}

export function requiredEnum<T extends string>(
  body: JsonObject,
  key: string,
  values: readonly T[],
): ValidationResult<T> {
  const value = body[key];
  if (typeof value !== "string" || !values.includes(value as T)) {
    return {
      ok: false,
      status: 422,
      message: `body.${key} must be one of ${values.join(", ")}`,
    };
  }
  return { ok: true, value: value as T };
}

export function optionalObject(
  body: JsonObject,
  key: string,
): ValidationResult<JsonObject | undefined> {
  const value = body[key];
  if (value === undefined) return { ok: true, value: undefined };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, status: 422, message: `body.${key} must be an object` };
  }
  return { ok: true, value: value as JsonObject };
}

export function readPositiveInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
