import { Hono } from "hono"
import { and, eq, sql } from "drizzle-orm"
import type { DomainEnvelope } from "@rafoworks/shared"
import type { AppEnv, Env } from "./lib/types.js"
import { createWideEvent, emitWideEvent } from "./lib/wide-event.js"
import { log } from "./lib/logger.js"
import { createDb } from "./db/index.js"
import { webhookLog } from "./db/schema.js"
import { getWorkflowsForEvent } from "./services/event-router.js"
import { ReconcileCron } from "./services/reconcile-cron.js"
import type { WebhookQueueMessage } from "./services/webhook-ingress.js"
import { healthRoutes } from "./routes/health.js"
import { webhookRoutes } from "./routes/webhooks.js"
import { orderRoutes } from "./routes/orders.js"

const app = new Hono<AppEnv>()

// One wide event per request — opened here, enriched by handlers, emitted once.
app.use("*", async (c, next) => {
  const start = Date.now()
  const we = createWideEvent({
    type: "http",
    method: c.req.method,
    path: c.req.path,
    version: c.env.CF_VERSION_METADATA?.id ?? "dev",
    environment: c.env.ENVIRONMENT,
  })
  c.set("wideEvent", we)
  c.set("requestId", we.request_id)
  try {
    await next()
    we.status_code = c.res.status
    we.outcome = c.res.status >= 500 ? "error" : "success"
  } catch (err) {
    we.outcome = "error"
    we.error_message = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    we.duration_ms = Date.now() - start
    emitWideEvent(we)
  }
})

app.route("/health", healthRoutes)
app.route("/webhooks", webhookRoutes)
app.route("/orders", orderRoutes)

// Dispatch: route a webhook event to its workflow(s). Used by the queue consumer and
// the reconcile cron alike, so the instance id is deterministic — the same event
// dispatched twice creates the same workflow instance (idempotent), never a duplicate.
async function dispatch(env: Env, msg: WebhookQueueMessage): Promise<void> {
  const routes = getWorkflowsForEvent(env, msg.eventType)
  if (routes.length === 0) {
    // No route ⟹ mark skipped, never leave the event 'queued' forever (that's the
    // silent-drift trap: a status nothing ever flips).
    await createDb(env.DB)
      .update(webhookLog)
      .set({ status: "skipped", errorMessage: "no_route", processedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(webhookLog.id, msg.eventId), eq(webhookLog.status, "queued")))
    log.info({ event: "dispatch.no_route", source: msg.source, event_type: msg.eventType })
    return
  }
  for (const route of routes) {
    await route.binding.create({
      id: `${route.name}:${msg.eventId}`,
      params: {
        eventId: msg.eventId,
        source: msg.source,
        eventType: msg.eventType,
        sourceOrderId: msg.sourceOrderId,
      },
    })
  }
}

async function handleDeadLetter(env: Env, queue: string, msg: Message): Promise<void> {
  const body = msg.body as Partial<WebhookQueueMessage>
  log.error({ event: "dlq.message", queue, webhook_id: body.eventId })
  if (body.eventId) {
    await createDb(env.DB)
      .update(webhookLog)
      .set({ status: "dead_letter", processedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(webhookLog.id, body.eventId), sql`${webhookLog.status} IN ('queued', 'failed')`))
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response> {
    return app.fetch(request, env, ctx)
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    for (const msg of batch.messages) {
      try {
        if (batch.queue.endsWith("-dlq")) {
          await handleDeadLetter(env, batch.queue, msg)
          msg.ack()
          continue
        }
        if (batch.queue === "domain-events") {
          // Placeholder business consumer. Real consumers (analytics, CRM, notify)
          // subscribe here, blind to the webhook that produced the event.
          log.info({ event: "domain_event.received", ...(msg.body as DomainEnvelope) })
          msg.ack()
          continue
        }
        await dispatch(env, msg.body as WebhookQueueMessage)
        msg.ack()
      } catch (err) {
        // Exponential backoff IN CODE — the queue becomes the outage buffer. Combined
        // with max_retries: 10 in wrangler.toml, this survives hours of a downstream
        // being down instead of burning retries in minutes and dead-lettering.
        const delay = Math.min(60 * 2 ** msg.attempts, 3600)
        log.error({
          event: "queue.retry",
          queue: batch.queue,
          attempt: msg.attempts,
          error: err instanceof Error ? err.message : String(err),
        })
        msg.retry({ delaySeconds: delay })
      }
    }
  },

  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const requestId = crypto.randomUUID()
    const we = createWideEvent({
      type: "cron",
      cron_trigger: event.cron,
      cron_action: "reconcile",
      version: env.CF_VERSION_METADATA?.id ?? "dev",
      environment: env.ENVIRONMENT,
    })
    try {
      const result = await new ReconcileCron(createDb(env.DB), env.WEBHOOK_QUEUE).run(requestId)
      we.items_processed = result.redispatched
    } catch (err) {
      we.outcome = "error"
      we.error_message = err instanceof Error ? err.message : String(err)
    } finally {
      emitWideEvent(we)
    }
  },
}

// Workflow classes and the RPC entrypoint must be exported from the worker's main
// module so wrangler can bind them.
export { OrderSyncWorkflow } from "./workflows/order-sync.js"
export { ToolsEntrypoint } from "./tools-entrypoint.js"
