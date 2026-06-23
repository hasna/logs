import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(repoRoot, "dist");

function run(command: string[], cwd = repoRoot): void {
  const result = Bun.spawnSync(command, {
    cwd,
    stderr: "inherit",
    stdout: "inherit",
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (${result.exitCode}): ${command.join(" ")}`,
    );
  }
}

function rewriteRelativeTsImports(directory: string): void {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stats = statSync(path);

    if (stats.isDirectory()) {
      rewriteRelativeTsImports(path);
      continue;
    }

    if (!path.endsWith(".d.ts")) {
      continue;
    }

    const source = readFileSync(path, "utf8");
    const rewritten = source.replace(
      /(["'])(\.\.?\/[^"']+)\1/g,
      (match, quote: string, specifier: string) => {
        if (!specifier.endsWith(".ts") || specifier.endsWith(".d.ts")) {
          return match;
        }

        return `${quote}${specifier.slice(0, -3)}.js${quote}`;
      },
    );

    if (rewritten !== source) {
      writeFileSync(path, rewritten);
    }
  }
}

run(["bun", "run", "build"], join(repoRoot, "sdk"));

mkdirSync(distDir, { recursive: true });
copyFileSync(
  join(repoRoot, "sdk", "dist", "index.d.ts"),
  join(distDir, "index.d.ts"),
);
copyFileSync(
  join(repoRoot, "sdk", "dist", "types.d.ts"),
  join(distDir, "types.d.ts"),
);

run([
  join(repoRoot, "node_modules", ".bin", "tsc"),
  "-p",
  "tsconfig.types.json",
]);

if (!existsSync(join(distDir, "index.d.ts"))) {
  throw new Error("Missing dist/index.d.ts after declaration build");
}

if (!existsSync(join(distDir, "storage.d.ts"))) {
  throw new Error("Missing dist/storage.d.ts after declaration build");
}

rewriteRelativeTsImports(distDir);
