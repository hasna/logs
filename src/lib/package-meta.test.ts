import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { readPackageVersion } from "./package-meta.ts"

const tempRoots: string[] = []

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "logs-package-meta-"))
  tempRoots.push(root)

  mkdirSync(join(root, "src/lib"), { recursive: true })
  mkdirSync(join(root, "dist"), { recursive: true })
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "9.9.9" }), "utf8")

  return root
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (!root) continue
    rmSync(root, { recursive: true, force: true })
  }
})

test("readPackageVersion resolves package.json from source module paths", () => {
  const root = createFixture()

  const version = readPackageVersion(pathToFileURL(join(root, "src/lib/fake.js")))

  expect(version).toBe("9.9.9")
})

test("readPackageVersion resolves package.json from bundled dist chunk paths", () => {
  const root = createFixture()

  const version = readPackageVersion(pathToFileURL(join(root, "dist/index-abc123.js")))

  expect(version).toBe("9.9.9")
})
