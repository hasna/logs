import type { SQLQueryBindings } from "bun:sqlite";

type SqlBindingValue =
  | string
  | bigint
  | NodeJS.TypedArray
  | number
  | boolean
  | null;

export function sqlBindings(values: Record<string, unknown>): SQLQueryBindings {
  return values as Record<string, SqlBindingValue>;
}
