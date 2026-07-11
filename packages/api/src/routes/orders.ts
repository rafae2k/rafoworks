import { Hono } from "hono"
import type { AppEnv } from "../lib/types.js"
import { createDb } from "../db/index.js"
import { getOrderById, listRecentOrders } from "../services/order.js"

// Read routes for the example domain entity. Also proves the read path the MCP
// ToolsEntrypoint reuses (same service functions, different transport).
export const orderRoutes = new Hono<AppEnv>()
  .get("/", async (c) => {
    return c.json(await listRecentOrders(createDb(c.env.DB), 20))
  })
  .get("/:id", async (c) => {
    const order = await getOrderById(createDb(c.env.DB), c.req.param("id"))
    return order ? c.json(order) : c.json({ error: "not found" }, 404)
  })
