import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface PackageJson {
  bin?: Record<string, string> | string;
  exports?: unknown;
  main?: string;
  types?: string;
  typings?: string;
}

interface PackFile {
  path: string;
}

interface PackResult {
  files: PackFile[];
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
) as PackageJson;

function normalizePackagePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isLocalPackagePath(value: string): boolean {
  return value.startsWith("./");
}

function addRequiredPath(requiredPaths: Set<string>, value: unknown): void {
  if (typeof value === "string" && isLocalPackagePath(value)) {
    requiredPaths.add(normalizePackagePath(value));
  }
}

function collectExportPaths(requiredPaths: Set<string>, value: unknown): void {
  if (typeof value === "string") {
    addRequiredPath(requiredPaths, value);
    return;
  }

  if (!value || typeof value !== "object") {
    return;
  }

  for (const [condition, target] of Object.entries(value)) {
    if (
      condition === "types" ||
      condition === "import" ||
      condition === "require" ||
      condition === "default"
    ) {
      addRequiredPath(requiredPaths, target);
    }

    collectExportPaths(requiredPaths, target);
  }
}

function collectRequiredPackagePaths(): Set<string> {
  const requiredPaths = new Set<string>();

  addRequiredPath(requiredPaths, packageJson.main);
  addRequiredPath(requiredPaths, packageJson.types);
  addRequiredPath(requiredPaths, packageJson.typings);

  if (typeof packageJson.bin === "string") {
    addRequiredPath(requiredPaths, packageJson.bin);
  } else if (packageJson.bin) {
    for (const target of Object.values(packageJson.bin)) {
      addRequiredPath(requiredPaths, target);
    }
  }

  collectExportPaths(requiredPaths, packageJson.exports);

  return requiredPaths;
}

function runPackDryRun(): PackResult {
  const result = Bun.spawnSync(["npm", "pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    stderr: "pipe",
    stdout: "pipe",
  });

  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr);
    throw new Error(`npm pack --dry-run failed:\n${stderr}`);
  }

  const stdout = new TextDecoder().decode(result.stdout);
  const jsonStart = stdout.indexOf("[");
  const jsonEnd = stdout.lastIndexOf("]");

  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
    throw new Error(`npm pack --dry-run returned no JSON array:\n${stdout}`);
  }

  const packResults = JSON.parse(
    stdout.slice(jsonStart, jsonEnd + 1),
  ) as PackResult[];
  const packResult = packResults[0];

  if (!packResult) {
    throw new Error("npm pack --dry-run returned no package result");
  }

  return packResult;
}

function extractDeclarationSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern =
    /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\(["']([^"']+)["']\)/g;

  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] ?? match[2];
    if (specifier) {
      specifiers.push(specifier);
    }
  }

  return specifiers;
}

function declarationTargetForSpecifier(
  fromPath: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }

  if (specifier.endsWith(".ts") && !specifier.endsWith(".d.ts")) {
    throw new Error(
      `${fromPath} imports ${specifier}; declaration files must reference emitted .js specifiers`,
    );
  }

  const basePath = posix.normalize(
    posix.join(posix.dirname(fromPath), specifier),
  );

  if (basePath.endsWith(".d.ts")) {
    return basePath;
  }

  if (
    basePath.endsWith(".js") ||
    basePath.endsWith(".mjs") ||
    basePath.endsWith(".cjs")
  ) {
    return `${basePath.slice(0, basePath.lastIndexOf("."))}.d.ts`;
  }

  return `${basePath}.d.ts`;
}

function validateDeclarationImports(packFiles: Set<string>): string[] {
  const errors: string[] = [];

  for (const file of packFiles) {
    if (!file.endsWith(".d.ts")) {
      continue;
    }

    const absolutePath = join(repoRoot, file);
    if (!existsSync(absolutePath)) {
      errors.push(`${file} is listed by pack but does not exist locally`);
      continue;
    }

    const source = readFileSync(absolutePath, "utf8");
    for (const specifier of extractDeclarationSpecifiers(source)) {
      try {
        const target = declarationTargetForSpecifier(file, specifier);
        if (target && !packFiles.has(target)) {
          errors.push(
            `${file} imports ${specifier}, but ${target} is not packed`,
          );
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  return errors;
}

const packResult = runPackDryRun();
const packFiles = new Set(
  packResult.files.map((file) => normalizePackagePath(file.path)),
);
const requiredPaths = collectRequiredPackagePaths();
const missingRequiredPaths = [...requiredPaths].filter(
  (path) => !packFiles.has(path),
);
const declarationErrors = validateDeclarationImports(packFiles);

if (missingRequiredPaths.length > 0 || declarationErrors.length > 0) {
  console.error("Package validation failed.");

  if (missingRequiredPaths.length > 0) {
    console.error("Missing package metadata targets:");
    for (const path of missingRequiredPaths) {
      console.error(`  - ${path}`);
    }
  }

  if (declarationErrors.length > 0) {
    console.error("Invalid declaration imports:");
    for (const error of declarationErrors) {
      console.error(`  - ${error}`);
    }
  }

  process.exit(1);
}

console.log(
  `Package validation passed: ${requiredPaths.size} metadata target(s), ${packFiles.size} packed file(s).`,
);
