import { WorkerEntrypoint } from "cloudflare:workers"
import { createDb } from "./db/index.js"
import { getOrderById, listRecentOrders } from "./services/order.js"
import type { Env } from "./lib/types.js"

/**
 * Read-only RPC surface for trusted internal callers. The MCP worker binds to this
 * via a NAMED service binding, so only a worker that declares the binding can reach
 * it — and it exposes reads only. This is how you give an agent (claude.ai) a
 * safe window into your platform without opening a public API or write path.
 */
export class ToolsEntrypoint extends WorkerEntrypoint<Env> {
  getOrder(id: string) {
    return getOrderById(createDb(this.env.DB), id)
  }

  listRecentOrders(limit = 20) {
    return listRecentOrders(createDb(this.env.DB), limit)
  }
}
