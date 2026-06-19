export function resolveCorsOrigin(origin: string): string {
  if (!origin) return "";

  const configured = readCorsOrigins();
  if (configured.includes("*")) return origin;
  if (configured.includes(origin)) return origin;
  if (isLocalOrigin(origin)) return origin;
  return "";
}

export function readCorsOrigins(): string[] {
  const value =
    process.env.HASNA_LOGS_CORS_ORIGINS ?? process.env.LOGS_CORS_ORIGINS ?? "";
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function isLocalOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}
