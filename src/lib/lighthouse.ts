import type { Database } from "bun:sqlite"
import { saveSnapshot } from "./perf.ts"
import type { PerformanceSnapshot } from "../types/index.ts"

export interface LighthouseResult {
  lcp: number | null
  fcp: number | null
  cls: number | null
  tti: number | null
  ttfb: number | null
  score: number | null
  raw_audit: string
}

export async function runLighthouse(url: string): Promise<LighthouseResult | null> {
  try {
    // Dynamic import — lighthouse is an optional peer dep
    const { default: lighthouse } = await import("lighthouse" as string)
    const { chromium } = await import("playwright")

    const browser = await chromium.launch({ headless: true, args: ["--remote-debugging-port=9222"] })
    try {
      const result = await lighthouse(url, {
        port: 9222,
        output: "json",
        logLevel: "silent",
        onlyCategories: ["performance"],
      } as Parameters<typeof lighthouse>[1])

      if (!result) return null
      const audits = result.lhr.audits
      const score = result.lhr.categories["performance"]?.score

      return {
        lcp: (audits["largest-contentful-paint"]?.numericValue ?? null) as number | null,
        fcp: (audits["first-contentful-paint"]?.numericValue ?? null) as number | null,
        cls: (audits["cumulative-layout-shift"]?.numericValue ?? null) as number | null,
        tti: (audits["interactive"]?.numericValue ?? null) as number | null,
        ttfb: (audits["server-response-time"]?.numericValue ?? null) as number | null,
        score: score !== undefined ? score * 100 : null,
        raw_audit: JSON.stringify(result.lhr.audits),
      }
    } finally {
      await browser.close()
    }
  } catch {
    return null
  }
}

export async function runAndSaveLighthouse(
  db: Database,
  url: string,
  projectId: string,
  pageId?: string,
): Promise<PerformanceSnapshot | null> {
  const result = await runLighthouse(url)
  if (!result) return null
  return saveSnapshot(db, {
    project_id: projectId,
    page_id: pageId ?? null,
    url,
    ...result,
  })
}
