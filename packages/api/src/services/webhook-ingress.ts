import { eq } from "drizzle-orm"
import type { IncomingWebhook, WebhookAdapterPort } from "@rafoworks/shared"
import type { Database } from "../db/index.js"
import { webhookLog } from "../db/schema.js"
import { log } from "../lib/logger.js"

/** What flows on the webhook queue — enough to re-drive the event idempotently. */
export interface WebhookQueueMessage {
  eventId: string
  source: string
  eventType: string
  sourceOrderId: string | null
  payload: unknown
}

export interface IngressDeps {
  db: Database
  queue: Queue<WebhookQueueMessage>
  /** Optional raw-payload archive for replay. */
  raw?: R2Bucket
}

export interface IngressResult {
  status: "queued" | "duplicate"
  eventId: string
  eventType: string
}

/**
 * The ingress seam: authenticate → dedup → archive raw → record fact → enqueue.
 * Webhook routes call this and nothing else — they never forward or process inline.
 * Idempotent by construction: the unique index on payload_hash means a re-delivery
 * can't create a second event.
 */
export class WebhookIngressService {
  constructor(private readonly deps: IngressDeps) {}

  async ingest(adapter: WebhookAdapterPort, req: IncomingWebhook): Promise<IngressResult> {
    await adapter.authenticate(req)
    const payload = req.body
    const eventType = adapter.extractEventType(payload)
    const sourceOrderId = adapter.extractSourceOrderId(payload)
    const hash = await adapter.computeHash(payload)

    // Fast-path dedup. The unique index on payload_hash is the real guard against a
    // concurrent double-delivery racing past this check.
    const existing = await this.deps.db
      .select({ id: webhookLog.id })
      .from(webhookLog)
      .where(eq(webhookLog.payloadHash, hash))
      .limit(1)
    if (existing.length) {
      log.info({ event: "webhook.duplicate_skipped", source: adapter.source, event_type: eventType })
      return { status: "duplicate", eventId: existing[0].id, eventType }
    }

    const eventId = crypto.randomUUID()

    let rawKey: string | null = null
    if (this.deps.raw) {
      rawKey = `raw/${adapter.source}/${eventId}.json`
      await this.deps.raw.put(rawKey, JSON.stringify(payload))
    }

    await this.deps.db.insert(webhookLog).values({
      id: eventId,
      source: adapter.source,
      eventType,
      sourceOrderId,
      payloadHash: hash,
      status: "queued",
      rawKey,
    })

    await this.deps.queue.send({ eventId, source: adapter.source, eventType, sourceOrderId, payload })
    log.info({ event: "webhook.received", source: adapter.source, event_type: eventType, webhook_id: eventId })
    return { status: "queued", eventId, eventType }
  }
}
