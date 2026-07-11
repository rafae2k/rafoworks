import { describe, expect, it } from "vitest"
import { env } from "cloudflare:workers"
import { eq } from "drizzle-orm"
import type { IncomingWebhook } from "@rafoworks/shared"
import { createDb } from "../db/index.js"
import { webhookLog } from "../db/schema.js"
import { ExampleWebhookAdapter } from "../adapters/example-webhook.js"
import { WebhookIngressService, type WebhookQueueMessage } from "./webhook-ingress.js"

// Seam test: the ingress runs against a REAL D1 (vitest-pool-workers), so this
// exercises the actual insert/dedup contract, not a mocked stand-in. Only the queue
// is faked — because here we're testing the DB seam, and we assert on what got sent.
function fakeQueue() {
  const sent: WebhookQueueMessage[] = []
  const queue = { send: async (m: WebhookQueueMessage) => void sent.push(m) } as unknown as Queue<WebhookQueueMessage>
  return { queue, sent }
}

const adapter = new ExampleWebhookAdapter("test-webhook-token")

function webhook(body: unknown): IncomingWebhook {
  return { headers: { "x-webhook-token": "test-webhook-token" }, query: {}, body }
}

describe("WebhookIngressService (seam: real D1)", () => {
  it("records a webhook_log row and enqueues on first delivery", async () => {
    const db = createDb(env.DB)
    const { queue, sent } = fakeQueue()
    const ingress = new WebhookIngressService({ db, queue })

    const res = await ingress.ingest(adapter, webhook({ event: "order.paid", order_id: "o-seam-1" }))

    expect(res.status).toBe("queued")
    expect(sent).toHaveLength(1)
    expect(sent[0].sourceOrderId).toBe("o-seam-1")
    const rows = await db.select().from(webhookLog).where(eq(webhookLog.id, res.eventId))
    expect(rows[0]?.status).toBe("queued")
  })

  it("is idempotent: the same payload is skipped and not re-enqueued", async () => {
    const db = createDb(env.DB)
    const { queue, sent } = fakeQueue()
    const ingress = new WebhookIngressService({ db, queue })
    const payload = { event: "order.paid", order_id: "o-seam-2" }

    await ingress.ingest(adapter, webhook(payload))
    const second = await ingress.ingest(adapter, webhook(payload))

    expect(second.status).toBe("duplicate")
    expect(sent).toHaveLength(1)
  })
})
