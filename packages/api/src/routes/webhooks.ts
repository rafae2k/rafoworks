import { Hono } from "hono"
import { PermanentError } from "@rafoworks/shared"
import type { AppEnv } from "../lib/types.js"
import { createContainer } from "../lib/container.js"
import { enrichWideEvent } from "../lib/wide-event.js"
import { log } from "../lib/logger.js"

// Webhook route: parse → authenticate → ingest. Nothing else. It never processes
// inline or forwards — the ingress durably captures the event and the queue takes
// over. It answers 200 on success so the source doesn't retry-storm us (we own the
// retry, via our queue), and 401 only when auth genuinely fails.
export const webhookRoutes = new Hono<AppEnv>().post("/example", async (c) => {
  const container = createContainer(c.env)

  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    body = {}
  }

  const incoming = {
    headers: Object.fromEntries(c.req.raw.headers),
    query: c.req.query(),
    body,
  }

  try {
    const result = await container.webhookIngress.ingest(container.webhookAdapter, incoming)
    enrichWideEvent(c, { source_system: "example", event_type: result.eventType })
    return c.json({ ok: true, status: result.status }, 200)
  } catch (err) {
    if (err instanceof PermanentError && err.slug === "webhook_auth_failed") {
      return c.json({ ok: false, error: "unauthorized" }, 401)
    }
    log.error({ event: "webhook.ingest_failed", error: err instanceof Error ? err.message : String(err) })
    return c.json({ ok: false }, 200)
  }
})
