import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const explicitFiles = ["package.json", "bun.lock", "README.md"];

const scannedRoots = ["docs", "src"];

const excludedFiles = new Set([
  "src/no-cloud-boundary.test.ts",
  "src/cli/storage.test.ts",
  "src/mcp/index.test.ts",
  "src/storage.ts",
]);

function literal(...parts: string[]): RegExp {
  return new RegExp(parts.map(escapeRegex).join(""), "i");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const retiredMarkers: Array<{ label: string; pattern: RegExp }> = [
  { label: "retired package", pattern: literal("@hasna/", "cloud") },
  { label: "retired repo", pattern: literal("open-", "cloud") },
  { label: "retired mcp binary", pattern: literal("cloud", "-mcp") },
  { label: "retired tool registrar", pattern: /register\s*CloudTools/i },
  { label: "retired command registrar", pattern: /register\s*CloudCommands/i },
  { label: "retired dotdir", pattern: literal(".hasna/", "cloud") },
  { label: "retired env namespace", pattern: /HASNA_?CLOUD_/i },
  { label: "retired RDS password env", pattern: /HASNA_RDS_?PASSWORD/i },
  { label: "retired cloud flag", pattern: /--\s*cloud\b/i },
  { label: "retired cloud status tool", pattern: /cloud\s*[_-]\s*status/i },
  { label: "retired cloud push tool", pattern: /cloud\s*[_-]\s*push/i },
  { label: "retired cloud pull tool", pattern: /cloud\s*[_-]\s*pull/i },
  { label: "retired cloud sync tool", pattern: /cloud\s*[_-]\s*sync/i },
  { label: "retired cloud sync phrase", pattern: /cloud\s+sync/i },
  { label: "retired SQLite adapter", pattern: /Sqlite\s*Adapter/i },
  { label: "retired Postgres adapter", pattern: /Pg\s*Adapter/i },
  { label: "disabled TLS", pattern: /reject\s*Unauthorized/i },
];

const allowedCompatibilityMarkers = new Set([
  "src/lib/remote-storage.ts: retired Postgres adapter",
]);

function collectFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(repoRoot, dir))) {
    const relative = join(dir, entry);
    if (excludedFiles.has(relative)) continue;
    const absolute = join(repoRoot, relative);
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      files.push(...collectFiles(relative));
      continue;
    }
    if (/\.(md|ts|tsx|js|json|lock)$/.test(relative)) files.push(relative);
  }
  return files;
}

function scannedFiles(): string[] {
  return [
    ...explicitFiles,
    ...scannedRoots.flatMap((root) => collectFiles(root)),
  ].sort();
}

describe("logs no-cloud boundary", () => {
  test("production package, docs, CLI, MCP, and storage source use app-owned storage", () => {
    const offenders: string[] = [];
    for (const file of scannedFiles()) {
      const text = readFileSync(join(repoRoot, file), "utf8");
      for (const marker of retiredMarkers) {
        const key = `${file}: ${marker.label}`;
        if (allowedCompatibilityMarkers.has(key)) continue;
        if (marker.pattern.test(text)) offenders.push(key);
      }
    }

    expect(offenders).toEqual([]);
  });
});
