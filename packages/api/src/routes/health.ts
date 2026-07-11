import { Hono } from "hono"
import type { AppEnv } from "../lib/types.js"

export const healthRoutes = new Hono<AppEnv>().get("/", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    environment: c.env.ENVIRONMENT,
  })
})
