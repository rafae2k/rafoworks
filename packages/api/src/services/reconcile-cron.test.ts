import { describe, expect, it } from "vitest"
import { env } from "cloudflare:workers"
import { createDb } from "../db/index.js"
import { webhookLog } from "../db/schema.js"
import { ReconcileCron } from "./reconcile-cron.js"
import type { WebhookQueueMessage } from "./webhook-ingress.js"

function fakeQueue() {
  const sent: WebhookQueueMessage[] = []
  const queue = { send: async (m: WebhookQueueMessage) => void sent.push(m) } as unknown as Queue<WebhookQueueMessage>
  return { queue, sent }
}

describe("ReconcileCron (seam: real D1)", () => {
  it("re-dispatches events stuck in 'queued' past the window, and leaves fresh ones", async () => {
    const db = createDb(env.DB)
    // One old stuck event (received 30 min ago) and one fresh (just now).
    await db.insert(webhookLog).values([
      {
        id: "stuck-1",
        source: "example",
        eventType: "order.paid",
        sourceOrderId: "o-stuck",
        payloadHash: "h-stuck",
        status: "queued",
        receivedAt: sqlMinutesAgo(30),
      },
      {
        id: "fresh-1",
        source: "example",
        eventType: "order.paid",
        sourceOrderId: "o-fresh",
        payloadHash: "h-fresh",
        status: "queued",
        receivedAt: sqlMinutesAgo(1),
      },
    ])

    const { queue, sent } = fakeQueue()
    const result = await new ReconcileCron(db, queue).run("req-test")

    expect(result.found).toBe(1)
    expect(sent).toHaveLength(1)
    expect(sent[0].eventId).toBe("stuck-1")
    expect(sent[0].sourceOrderId).toBe("o-stuck")
  })
})

// Build an ISO-ish datetime string N minutes in the past, matching SQLite's
// CURRENT_TIMESTAMP format ("YYYY-MM-DD HH:MM:SS", UTC).
function sqlMinutesAgo(minutes: number): string {
  const d = new Date(Date.now() - minutes * 60_000)
  return d.toISOString().replace("T", " ").slice(0, 19)
}
