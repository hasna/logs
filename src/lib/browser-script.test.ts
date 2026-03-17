import { describe, expect, it } from "bun:test"
import { getBrowserScript } from "./browser-script.ts"

describe("getBrowserScript", () => {
  it("returns a non-empty string", () => {
    const script = getBrowserScript("http://localhost:3460")
    expect(typeof script).toBe("string")
    expect(script.length).toBeGreaterThan(100)
  })

  it("embeds the server URL", () => {
    const script = getBrowserScript("http://localhost:3460")
    expect(script).toContain("http://localhost:3460")
  })

  it("hooks console.error", () => {
    const script = getBrowserScript("http://localhost:3460")
    expect(script).toContain("console.error")
  })

  it("hooks window.onerror / unhandledrejection", () => {
    const script = getBrowserScript("http://localhost:3460")
    expect(script).toContain("unhandledrejection")
  })

  it("pushes to /api/logs", () => {
    const script = getBrowserScript("http://localhost:3460")
    expect(script).toContain("/api/logs")
  })

  it("uses data-project attribute", () => {
    const script = getBrowserScript("http://localhost:3460")
    expect(script).toContain("data-project")
  })
})
