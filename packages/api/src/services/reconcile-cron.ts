import { and, eq, sql } from "drizzle-orm"
import type { Database } from "../db/index.js"
import { executionLog, webhookLog } from "../db/schema.js"
import { log } from "../lib/logger.js"
import type { WebhookQueueMessage } from "./webhook-ingress.js"

// Reconciliation safety net. Finds events stuck in 'queued' — the workflow that
// should have processed them never did (an outage, a dropped message) — and re-drives
// them. This is the NET, not the primary path: it must tend to ZERO. A residue that
// doesn't fall means a bug upstream; don't let the cron mask it (prevent > detect >
// reconcile). NEVER use a cron to paper over a race you created yourself.
const STUCK_MINUTES = 15
// Keep D1 query/batch volume bounded — see the platform limits in CLAUDE.md.
const BATCH = 50

export class ReconcileCron {
  constructor(
    private readonly db: Database,
    private readonly queue: Queue<WebhookQueueMessage>,
  ) {}

  async run(requestId: string): Promise<{ found: number; redispatched: number }> {
    const stuck = await this.db
      .select({
        id: webhookLog.id,
        source: webhookLog.source,
        eventType: webhookLog.eventType,
        sourceOrderId: webhookLog.sourceOrderId,
      })
      .from(webhookLog)
      .where(
        and(
          eq(webhookLog.status, "queued"),
          sql`${webhookLog.receivedAt} < datetime('now', ${`-${STUCK_MINUTES} minutes`})`,
        ),
      )
      .limit(BATCH)

    for (const row of stuck) {
      // Re-dispatch by sourceOrderId — the workflow re-fetches from the source, so it
      // doesn't need the original payload.
      await this.queue.send({
        eventId: row.id,
        source: row.source,
        eventType: row.eventType,
        sourceOrderId: row.sourceOrderId,
        payload: null,
      })
    }

    await this.db.insert(executionLog).values({
      id: crypto.randomUUID(),
      requestId,
      action: "reconcile",
      outcome: "success",
      detail: JSON.stringify({ found: stuck.length, redispatched: stuck.length }),
    })

    if (stuck.length > 0) {
      log.warn({ event: "reconcile.redispatched", items_processed: stuck.length })
    }
    return { found: stuck.length, redispatched: stuck.length }
  }
}
