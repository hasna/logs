import { test, expect } from "bun:test"
import { fileURLToPath } from "url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

test("logs MCP lists tools over stdio", async () => {
  const entry = fileURLToPath(new URL("./index.ts", import.meta.url))
  const transport = new StdioClientTransport({
    command: "bun",
    args: ["run", entry],
  })
  const client = new Client({ name: "logs-mcp-test", version: "0.0.0" }, { capabilities: {} })

  try {
    await client.connect(transport)
    const result = await client.listTools()
    const toolNames = result.tools.map((tool) => tool.name)

    expect(toolNames.length).toBeGreaterThan(0)
    expect(toolNames).toContain("get_health")
    expect(toolNames).toContain("log_search")
  } finally {
    await client.close().catch(() => {})
  }
})
