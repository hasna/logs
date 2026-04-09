import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string }

async function runEntrypoint(entryRelativePath: string, args: string[]) {
  const entry = fileURLToPath(new URL(entryRelativePath, import.meta.url))
  const proc = Bun.spawn(["bun", entry, ...args], {
    env: {
      ...process.env,
      LOGS_PORT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`Timed out running ${entryRelativePath} ${args.join(" ")}`.trim()))
    }, 2000)

    proc.exited.finally(() => clearTimeout(timer))
  })

  const exitCode = await Promise.race([proc.exited, timeout])
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()

  return { exitCode, stdout, stderr }
}

test("logs --version matches package.json", async () => {
  const result = await runEntrypoint("./index.ts", ["--version"])

  expect(result.exitCode).toBe(0)
  expect(result.stdout.trim()).toBe(packageJson.version)
  expect(result.stderr.trim()).toBe("")
})

test("logs-mcp --help prints usage and exits without starting stdio transport", async () => {
  const result = await runEntrypoint("../mcp/index.ts", ["--help"])

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain("Usage: logs-mcp [options]")
  expect(result.stdout).toContain("Start the @hasna/logs MCP server over stdio.")
  expect(result.stdout).not.toContain("Listening")
  expect(result.stderr.trim()).toBe("")
})

test("logs-serve --help prints usage and exits without starting the server", async () => {
  const result = await runEntrypoint("../server/index.ts", ["--help"])

  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain("Usage: logs-serve [options]")
  expect(result.stdout).toContain("Start the @hasna/logs REST API server.")
  expect(result.stdout).not.toContain("server running")
  expect(result.stdout).not.toContain("Scheduler started")
  expect(result.stderr.trim()).toBe("")
})
