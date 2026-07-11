import { WorkflowEntrypoint } from "cloudflare:workers"
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers"
import type { DomainEnvelope, SourceOrder } from "@rafoworks/shared"
import { ExampleSourceAdapter } from "../adapters/example-source.js"
import { createDb } from "../db/index.js"
import { upsertOrderFromSource } from "../services/order.js"
import { log } from "../lib/logger.js"
import type { Env } from "../lib/types.js"
import { markWebhookProcessed, markWebhookSkipped } from "./shared.js"

export interface OrderSyncPayload {
  eventId: string
  source: string
  eventType: string
  sourceOrderId: string | null
  /** The order if the webhook was fat; null ⟹ fetch it from the source adapter. */
  order: SourceOrder | null
}

/**
 * Durable, idempotent order sync. Each `step.do` is a checkpointed, retriable unit:
 * if the workflow crashes after "upsert-order" it resumes there, not from scratch,
 * and a step that already ran returns its recorded result. That's why the steps must
 * be idempotent — fetch is a read, upsert is keyed. This is the durable-execution
 * primitive the whole platform leans on instead of ad-hoc retry loops.
 */
export class OrderSyncWorkflow extends WorkflowEntrypoint<Env, OrderSyncPayload> {
  async run(event: WorkflowEvent<OrderSyncPayload>, step: WorkflowStep): Promise<void> {
    const { eventId, source, sourceOrderId, order: fatOrder } = event.payload

    // Fat webhook: the order came with the event — no fetch needed. Thin webhook:
    // fetch the full order from the source adapter by id.
    let order = fatOrder
    if (!order) {
      if (!sourceOrderId) {
        await markWebhookSkipped(step, this.env.DB, eventId, "no order and no source order id on event")
        return
      }
      order = await step.do("fetch-order", async () => {
        const adapter = new ExampleSourceAdapter(this.env.EXAMPLE_API_TOKEN)
        return adapter.fetchOrder(sourceOrderId)
      })
    }

    if (!order) {
      await markWebhookSkipped(step, this.env.DB, eventId, "order not found in source")
      return
    }

    await step.do("upsert-order", async () => {
      await upsertOrderFromSource(createDb(this.env.DB), source, order)
    })

    // Emit a domain event onto the business arm (domain-events queue). Consumers
    // there — analytics, CRM sync, notifications — subscribe to the domain, blind to
    // the webhook that triggered it. This is the seam that decouples "what happened"
    // from "who reacts". The webhook arm is transport; this arm is meaning.
    await step.do("emit-domain-event", async () => {
      const envelope: DomainEnvelope<{ sourceOrderId: string }> = {
        eventType: "order.synced",
        source,
        dedupId: eventId,
        occurredAt: new Date().toISOString(),
        payload: { sourceOrderId: order.sourceOrderId },
      }
      await this.env.DOMAIN_EVENTS_QUEUE.send(envelope)
    })

    log.info({ event: "order.synced", source, source_order_id: order.sourceOrderId, order_status: order.rawStatus })
    await markWebhookProcessed(step, this.env.DB, eventId)
  }
}
