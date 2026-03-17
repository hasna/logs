import type { Database } from "bun:sqlite"
import type { Project } from "../types/index.ts"
import { updateProject } from "./projects.ts"

interface GithubRepo {
  description: string | null
  default_branch: string
  topics: string[]
}

interface GithubCommit {
  sha: string
}

export async function syncGithubRepo(db: Database, project: Project): Promise<Project | null> {
  if (!project.github_repo) return project
  const repo = project.github_repo.replace(/^https?:\/\/github\.com\//, "")
  const headers: Record<string, string> = { "Accept": "application/vnd.github.v3+json" }
  if (process.env.GITHUB_TOKEN) headers["Authorization"] = `Bearer ${process.env.GITHUB_TOKEN}`

  try {
    const [repoRes, commitRes] = await Promise.all([
      fetch(`https://api.github.com/repos/${repo}`, { headers }),
      fetch(`https://api.github.com/repos/${repo}/commits?per_page=1`, { headers }),
    ])
    if (!repoRes.ok) return project
    const repoData = await repoRes.json() as GithubRepo
    const commits = commitRes.ok ? await commitRes.json() as GithubCommit[] : []
    return updateProject(db, project.id, {
      github_description: repoData.description,
      github_branch: repoData.default_branch,
      github_sha: commits[0]?.sha ?? null,
      last_synced_at: new Date().toISOString(),
    })
  } catch {
    return project
  }
}
