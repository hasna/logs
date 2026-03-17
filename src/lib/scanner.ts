import type { Database } from "bun:sqlite"
import { ingestBatch } from "./ingest.ts"
import { getPageAuth } from "./page-auth.ts"
import { saveSnapshot } from "./perf.ts"
import { getPage, touchPage } from "./projects.ts"
import type { LogEntry } from "../types/index.ts"

export interface ScanResult {
  logsCollected: number
  errorsFound: number
  perfScore: number | null
}

export async function scanPage(db: Database, projectId: string, pageId: string, urlOverride?: string): Promise<ScanResult> {
  const page = getPage(db, pageId)
  const url = urlOverride || page?.url
  if (!url) throw new Error(`No URL for page ${pageId}`)

  const { chromium } = await import("playwright")
  const browser = await chromium.launch({ headless: true })

  // Apply page auth if configured
  const auth = getPageAuth(db, pageId)
  const contextOptions: Parameters<typeof browser.newContext>[0] = {
    userAgent: "Mozilla/5.0 (@hasna/logs scanner) AppleWebKit/537.36",
  }
  if (auth?.type === "cookie") {
    try { contextOptions.storageState = JSON.parse(auth.credentials) } catch { /* invalid */ }
  } else if (auth?.type === "basic") {
    const [username, password] = auth.credentials.split(":")
    contextOptions.httpCredentials = { username: username ?? "", password: password ?? "" }
  }

  const context = await browser.newContext(contextOptions)

  if (auth?.type === "bearer") {
    await context.route("**/*", (route) => {
      route.continue({ headers: { ...route.request().headers(), Authorization: `Bearer ${auth.credentials}` } })
    })
  }

  const browserPage = await context.newPage()

  const collected: LogEntry[] = []
  let errorsFound = 0

  // Capture console output
  browserPage.on("console", (msg) => {
    const level = msg.type() === "error" ? "error" : msg.type() === "warning" ? "warn" : msg.type() === "info" ? "info" : "debug"
    if (level === "error") errorsFound++
    collected.push({
      project_id: projectId,
      page_id: pageId,
      level: level as LogEntry["level"],
      source: "scanner",
      message: msg.text(),
      url,
    })
  })

  // Capture page errors (uncaught JS exceptions)
  browserPage.on("pageerror", (err) => {
    errorsFound++
    collected.push({
      project_id: projectId,
      page_id: pageId,
      level: "error",
      source: "scanner",
      message: err.message,
      stack_trace: err.stack,
      url,
    })
  })

  // Capture network failures
  browserPage.on("requestfailed", (req) => {
    collected.push({
      project_id: projectId,
      page_id: pageId,
      level: "warn",
      source: "scanner",
      message: `Network request failed: ${req.url()} — ${req.failure()?.errorText ?? "unknown"}`,
      url,
    })
  })

  let perfScore: number | null = null

  try {
    await browserPage.goto(url, { waitUntil: "networkidle", timeout: 30_000 })

    // Try basic perf metrics via CDP
    try {
      const metrics = await browserPage.evaluate(() => {
        const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined
        const paint = performance.getEntriesByName("first-contentful-paint")[0]
        return {
          ttfb: nav ? nav.responseStart - nav.requestStart : null,
          fcp: paint?.startTime ?? null,
          domLoad: nav ? nav.domContentLoadedEventEnd - nav.startTime : null,
        }
      })
      // Store what we can without full Lighthouse
      if (metrics.fcp !== null || metrics.ttfb !== null) {
        saveSnapshot(db, {
          project_id: projectId,
          page_id: pageId,
          url,
          fcp: metrics.fcp,
          ttfb: metrics.ttfb,
          lcp: null,
          cls: null,
          tti: metrics.domLoad,
          score: null,
          raw_audit: JSON.stringify(metrics),
        })
      }
    } catch {
      // perf metrics optional
    }
  } finally {
    await browser.close()
  }

  if (collected.length > 0) {
    ingestBatch(db, collected)
    if (page) touchPage(db, pageId)
  }

  return { logsCollected: collected.length, errorsFound, perfScore }
}
