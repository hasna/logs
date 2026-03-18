import { describe, expect, it } from "bun:test"
import { parseTime } from "./parse-time.ts"

describe("parseTime", () => {
  it("returns undefined for undefined input", () => expect(parseTime(undefined)).toBeUndefined())
  it("returns ISO string unchanged", () => {
    const iso = "2026-01-01T00:00:00.000Z"
    expect(parseTime(iso)).toBe(iso)
  })
  it("parses 30m", () => {
    const result = parseTime("30m")!
    const diff = Date.now() - new Date(result).getTime()
    expect(diff).toBeGreaterThan(29 * 60 * 1000)
    expect(diff).toBeLessThan(31 * 60 * 1000)
  })
  it("parses 1h", () => {
    const result = parseTime("1h")!
    const diff = Date.now() - new Date(result).getTime()
    expect(diff).toBeGreaterThan(59 * 60 * 1000)
    expect(diff).toBeLessThan(61 * 60 * 1000)
  })
  it("parses 7d", () => {
    const result = parseTime("7d")!
    const diff = Date.now() - new Date(result).getTime()
    expect(diff).toBeGreaterThan(6.9 * 86400 * 1000)
    expect(diff).toBeLessThan(7.1 * 86400 * 1000)
  })
  it("parses 1w", () => {
    const result = parseTime("1w")!
    const diff = Date.now() - new Date(result).getTime()
    expect(diff).toBeGreaterThan(6.9 * 86400 * 1000)
  })
  it("returns unknown strings unchanged", () => {
    expect(parseTime("yesterday")).toBe("yesterday")
    expect(parseTime("now")).toBe("now")
  })
})
