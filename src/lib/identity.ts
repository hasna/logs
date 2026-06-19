import type { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { arch, hostname, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface RuntimeIdentity {
  machine_id: string;
  repo_id: string | null;
  app_id: string | null;
  environment: string;
}

export interface IdentityDetectionOptions {
  project_id?: string | null;
  environment?: string | null;
}

export function detectRuntimeIdentity(
  db: Database,
  cwd: string,
  opts: IdentityDetectionOptions = {},
): RuntimeIdentity {
  const environment = opts.environment ?? process.env.NODE_ENV ?? "development";
  const machine = upsertMachine(db);
  const repo = detectRepo(cwd);
  if (repo) upsertRepo(db, repo);
  const app = detectApp(
    cwd,
    repo?.id ?? null,
    opts.project_id ?? null,
    environment,
  );
  if (app) upsertApp(db, app);

  return {
    machine_id: machine,
    repo_id: repo?.id ?? null,
    app_id: app?.id ?? null,
    environment,
  };
}

function upsertMachine(db: Database): string {
  const info = {
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    os_release: release(),
  };
  const id = `machine_${sha256(`${info.hostname}:${info.platform}:${info.arch}`).slice(0, 16)}`;
  db.prepare(`
    INSERT INTO machines (id, hostname, platform, arch, os_release, metadata, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(id) DO UPDATE SET
      hostname = excluded.hostname,
      platform = excluded.platform,
      arch = excluded.arch,
      os_release = excluded.os_release,
      metadata = excluded.metadata,
      last_seen_at = excluded.last_seen_at
  `).run(
    id,
    info.hostname,
    info.platform,
    info.arch,
    info.os_release,
    JSON.stringify(info),
  );
  return id;
}

function detectRepo(cwd: string): {
  id: string;
  root_path: string;
  remote_url: string | null;
  branch: string | null;
  commit_sha: string | null;
  dirty: number;
} | null {
  const root = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!root) return null;
  const remote = git(root, ["config", "--get", "remote.origin.url"]);
  const branch = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const sha = git(root, ["rev-parse", "HEAD"]);
  const dirty = git(root, ["status", "--porcelain"]) ? 1 : 0;
  return {
    id: `repo_${sha256(root).slice(0, 16)}`,
    root_path: root,
    remote_url: remote,
    branch,
    commit_sha: sha,
    dirty,
  };
}

function upsertRepo(
  db: Database,
  repo: {
    id: string;
    root_path: string;
    remote_url: string | null;
    branch: string | null;
    commit_sha: string | null;
    dirty: number;
  },
): void {
  db.prepare(`
    INSERT INTO repositories (id, root_path, remote_url, branch, commit_sha, dirty, metadata, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(id) DO UPDATE SET
      root_path = excluded.root_path,
      remote_url = excluded.remote_url,
      branch = excluded.branch,
      commit_sha = excluded.commit_sha,
      dirty = excluded.dirty,
      metadata = excluded.metadata,
      last_seen_at = excluded.last_seen_at
  `).run(
    repo.id,
    repo.root_path,
    repo.remote_url,
    repo.branch,
    repo.commit_sha,
    repo.dirty,
    JSON.stringify(repo),
  );
}

function detectApp(
  cwd: string,
  repoId: string | null,
  projectId: string | null,
  environment: string,
): {
  id: string;
  repo_id: string | null;
  project_id: string | null;
  name: string;
  runtime: string | null;
  environment: string;
  version: string | null;
  metadata: Record<string, unknown>;
} | null {
  const packageJsonPath = findNearestPackageJson(cwd);
  if (!packageJsonPath) return null;
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: string;
      version?: string;
    };
    const name =
      packageJson.name ??
      dirname(packageJsonPath).split(/[\\/]/).pop() ??
      "app";
    return {
      id: `app_${sha256(packageJsonPath).slice(0, 16)}`,
      repo_id: repoId,
      project_id: projectId,
      name,
      runtime: "cli",
      environment,
      version: packageJson.version ?? null,
      metadata: { package_json_path: packageJsonPath },
    };
  } catch {
    return null;
  }
}

function upsertApp(
  db: Database,
  app: {
    id: string;
    repo_id: string | null;
    project_id: string | null;
    name: string;
    runtime: string | null;
    environment: string;
    version: string | null;
    metadata: Record<string, unknown>;
  },
): void {
  db.prepare(`
    INSERT INTO apps (id, repo_id, project_id, name, runtime, environment, version, metadata, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(id) DO UPDATE SET
      repo_id = excluded.repo_id,
      project_id = excluded.project_id,
      name = excluded.name,
      runtime = excluded.runtime,
      environment = excluded.environment,
      version = excluded.version,
      metadata = excluded.metadata,
      last_seen_at = excluded.last_seen_at
  `).run(
    app.id,
    app.repo_id,
    app.project_id,
    app.name,
    app.runtime,
    app.environment,
    app.version,
    JSON.stringify(app.metadata),
  );
}

function findNearestPackageJson(cwd: string): string | null {
  let dir = resolve(cwd);
  while (true) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function git(cwd: string, args: string[]): string | null {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1_000,
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}
