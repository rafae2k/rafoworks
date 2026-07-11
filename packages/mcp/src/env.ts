// Bindings for the rafoworks-mcp worker.

/**
 * The read-only RPC surface exposed by the api's ToolsEntrypoint (service binding).
 * Mirrors packages/api/src/tools-entrypoint.ts. Loosely typed at the RPC boundary.
 */
export interface ToolsRpc {
  getOrder(id: string): Promise<unknown>
  listRecentOrders(limit?: number): Promise<unknown>
}

export interface Env {
  // Service binding (RPC) → ToolsEntrypoint of rafoworks-api
  API: ToolsRpc
  ENVIRONMENT?: string
}
