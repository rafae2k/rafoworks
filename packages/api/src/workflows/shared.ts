import type { WorkflowStep } from "cloudflare:workers"
import { eq, sql } from "drizzle-orm"
import { createDb } from "../db/index.js"
import { webhookLog } from "../db/schema.js"
import { log } from "../lib/logger.js"

export type WebhookOutcome = "processed" | "skipped" | "failed"

// Higher = worse. Multiple workflows may fire for one event; none should downgrade a
// status a previous one set. "failed" always wins; "processed" never overwrites
// "skipped"/"failed".
const OUTCOME_PRIORITY: Record<string, number> = { queued: 0, skipped: 1, processed: 2, failed: 3 }

async function markWebhookDone(
  step: WorkflowStep,
  db: D1Database,
  eventId: string,
  outcome: WebhookOutcome,
  reason?: string,
  errorSlug?: string,
): Promise<void> {
  await step.do(`mark-${outcome}`, async () => {
    const drizzle = createDb(db)
    const current = await drizzle
      .select({ status: webhookLog.status })
      .from(webhookLog)
      .where(eq(webhookLog.id, eventId))
      .limit(1)
      .then((rows) => rows[0]?.status ?? "queued")

    if ((OUTCOME_PRIORITY[outcome] ?? 0) < (OUTCOME_PRIORITY[current] ?? 0)) return

    const res = await drizzle
      .update(webhookLog)
      .set({
        status: outcome,
        errorMessage: outcome === "processed" ? null : (reason ?? null),
        errorSlug: outcome === "failed" ? (errorSlug ?? null) : null,
        processedAt: sql`CURRENT_TIMESTAMP`,
      })
      .where(eq(webhookLog.id, eventId))

    // If the row is gone (e.g. archived + reprocessed), the UPDATE hits 0 rows. That
    // was a silent no-op before — now it signals, so the outcome never vanishes.
    const changes = (res as { meta?: { changes?: number } }).meta?.changes ?? 0
    if (changes === 0) {
      log.warn({ event: "webhook.mark_missing_row", webhook_id: eventId, intended_status: outcome })
    }
  })
}

export function markWebhookProcessed(step: WorkflowStep, db: D1Database, eventId: string) {
  return markWebhookDone(step, db, eventId, "processed")
}

export function markWebhookSkipped(step: WorkflowStep, db: D1Database, eventId: string, reason: string) {
  return markWebhookDone(step, db, eventId, "skipped", reason)
}

export function markWebhookFailed(step: WorkflowStep, db: D1Database, eventId: string, reason: string, errorSlug?: string) {
  return markWebhookDone(step, db, eventId, "failed", reason, errorSlug)
}
