import { desc, eq, sql } from "drizzle-orm"
import { normalizeSourceStatus, PermanentError } from "@rafoworks/shared"
import type { SourceOrder } from "@rafoworks/shared"
import type { Database } from "../db/index.js"
import { orders } from "../db/schema.js"

/**
 * Use case: materialize (or update) an order from a source. Idempotent upsert keyed
 * on (source, sourceOrderId), so a re-delivered event just re-writes the same row.
 * Refuses an unknown status instead of coercing it — never silent-skip an invariant.
 */
export async function upsertOrderFromSource(db: Database, source: string, src: SourceOrder): Promise<void> {
  const status = normalizeSourceStatus(src.rawStatus)
  if (!status) {
    throw new PermanentError(`unknown status "${src.rawStatus}" from ${source}`, "unknown_source_status")
  }

  await db
    .insert(orders)
    .values({
      id: `${source}:${src.sourceOrderId}`,
      source,
      sourceOrderId: src.sourceOrderId,
      status,
      customerName: src.customerName,
      totalCents: src.totalCents,
    })
    .onConflictDoUpdate({
      target: [orders.source, orders.sourceOrderId],
      set: { status, customerName: src.customerName, totalCents: src.totalCents, updatedAt: sql`CURRENT_TIMESTAMP` },
    })
}

/** Read one order by its internal id (`${source}:${sourceOrderId}`). */
export async function getOrderById(db: Database, id: string) {
  const rows = await db.select().from(orders).where(eq(orders.id, id)).limit(1)
  return rows[0] ?? null
}

/** Read the most recent orders (bounded — see D1 platform limits). */
export function listRecentOrders(db: Database, limit = 20) {
  return db.select().from(orders).orderBy(desc(orders.createdAt)).limit(Math.min(limit, 100))
}
