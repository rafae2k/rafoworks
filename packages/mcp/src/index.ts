// Worker rafoworks-mcp — a remote MCP server that gives an agent (e.g. claude.ai) a
// read-only window into the platform. Tools call the api's ToolsEntrypoint via a
// service binding (RPC), so the MCP never touches the DB directly and can only read.
//
// This skeleton serves /mcp unauthenticated for clarity. For production, wrap this
// handler with `@cloudflare/workers-oauth-provider` so the worker becomes the MCP's
// OAuth server (see wrangler.toml note + docs/reference/mcp.md).
import { createMcpHandler } from "agents/mcp"
import { buildServer } from "./server.js"
import type { Env } from "./env.js"

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return createMcpHandler(buildServer(env), { route: "/mcp" })(request, env, ctx)
  },
}
