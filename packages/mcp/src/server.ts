// The MCP server: read-only tools that call the api's ToolsEntrypoint via the service
// binding (RPC). Tool descriptions follow MCP best practice — what it does + when to
// use it + what it returns + readOnlyHint — so an agent picks the right one.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"
import type { Env } from "./env.js"

const INSTRUCTIONS =
  "Read-only investigation tools for the rafoworks platform. Use them to look up " +
  "orders and their status. You cannot change anything — only query."

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

function result(data: unknown): ToolResult {
  if (data === null || data === undefined) {
    return { content: [{ type: "text", text: "Nothing found for that query. Check the id and try again." }] }
  }
  return { content: [{ type: "text", text: JSON.stringify(data) }] }
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const

export function buildServer(env: Env): McpServer {
  const server = new McpServer({ name: "rafoworks", version: "0.1.0" }, { instructions: INSTRUCTIONS })

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description:
        "Look up one order by its internal id (`<source>:<sourceOrderId>`, e.g. 'example:o-1'). Returns its status, customer, total, and timestamps. Use when you have an exact order id.",
      inputSchema: { id: z.string().describe("Internal order id, e.g. 'example:o-1'") },
      annotations: READ_ONLY,
    },
    async ({ id }) => result(await env.API.getOrder(id)),
  )

  server.registerTool(
    "list_recent_orders",
    {
      title: "List recent orders",
      description:
        "List the most recent orders (newest first). Use to see what's flowing through the platform when you don't have a specific id.",
      inputSchema: { limit: z.number().int().min(1).max(100).optional().describe("How many to return (default 20)") },
      annotations: READ_ONLY,
    },
    async ({ limit }) => result(await env.API.listRecentOrders(limit ?? 20)),
  )

  return server
}
