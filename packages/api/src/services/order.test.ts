import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import { createDb } from "../db/index.js"
import { getOrderById, upsertOrderFromSource } from "./order.js"

// Seam test: the order use case runs against a real D1 (vitest-pool-workers), so it
// exercises the actual upsert/conflict contract — the heart of materialization.
describe("upsertOrderFromSource (seam: real D1)", () => {
  it("materializes an order, then updates it idempotently on re-delivery", async () => {
    const db = createDb(env.DB)

    await upsertOrderFromSource(db, "example", {
      sourceOrderId: "o-up-1",
      rawStatus: "paid",
      customerName: "Ada",
      totalCents: 4990,
    })
    expect((await getOrderById(db, "example:o-up-1"))?.status).toBe("paid")

    // Re-deliver with a new status → same row updates (normalized), no duplicate.
    await upsertOrderFromSource(db, "example", {
      sourceOrderId: "o-up-1",
      rawStatus: "shipped",
      customerName: "Ada",
      totalCents: 4990,
    })
    expect((await getOrderById(db, "example:o-up-1"))?.status).toBe("fulfilled")
  })

  it("refuses an unknown status instead of coercing it", async () => {
    const db = createDb(env.DB)
    await expect(
      upsertOrderFromSource(db, "example", {
        sourceOrderId: "o-up-2",
        rawStatus: "frobnicated",
        customerName: null,
        totalCents: 0,
      }),
    ).rejects.toThrow(/unknown status/)
  })
})
