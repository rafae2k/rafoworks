---
type: reference
status: current
updated: 2026-07-11
reviewed: 2026-07-11
area: platform
---

# MCP server

`packages/mcp` is a remote MCP server that gives an agent (e.g. claude.ai) a **read-only** window into the platform. Its tools call the api's `ToolsEntrypoint` over a **named service binding** (RPC) — so the MCP never touches the DB directly and can only read what the entrypoint exposes.

## Shape

- `packages/api/src/tools-entrypoint.ts` — a `WorkerEntrypoint` with read-only methods (`getOrder`, `listRecentOrders`). Named entrypoint ⟹ only a worker that declares the binding can call it.
- `packages/mcp/src/server.ts` — registers MCP tools that wrap those RPC methods, with descriptions written so an agent picks the right one.
- `packages/mcp/wrangler.toml` — the service binding `API → rafoworks-api#ToolsEntrypoint`.

## Adding a tool

1. Add a read-only method to `ToolsEntrypoint`.
2. Add it to the `ToolsRpc` interface in `packages/mcp/src/env.ts`.
3. `registerTool` in `server.ts` with a clear description + `readOnlyHint`.

## Auth (before you expose it)

This skeleton serves `/mcp` **unauthenticated** for clarity. Before exposing it publicly, put OAuth in front — the Cloudflare pattern is [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) wrapping the handler in `packages/mcp/src/index.ts`, so the worker becomes the MCP's own OAuth server (claude.ai connects directly via standard discovery). Restrict login to your identity provider / hosted domain.
