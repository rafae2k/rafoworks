import { describe, expect, it } from "vitest"
import { ExampleWebhookAdapter } from "./example-webhook.js"
import type { IncomingWebhook } from "@rafoworks/shared"

const adapter = new ExampleWebhookAdapter("secret-token")

function req(overrides: Partial<IncomingWebhook>): IncomingWebhook {
  return { headers: {}, query: {}, body: {}, ...overrides }
}

describe("ExampleWebhookAdapter", () => {
  it("accepts a matching token (header or query)", async () => {
    await expect(adapter.authenticate(req({ headers: { "x-webhook-token": "secret-token" } }))).resolves.toBeUndefined()
    await expect(adapter.authenticate(req({ query: { token: "secret-token" } }))).resolves.toBeUndefined()
  })

  it("rejects a missing or wrong token", async () => {
    await expect(adapter.authenticate(req({}))).rejects.toThrow(/invalid token/)
    await expect(adapter.authenticate(req({ headers: { "x-webhook-token": "nope" } }))).rejects.toThrow()
  })

  it("hashes deterministically (same payload ⟹ same hash)", async () => {
    const a = await adapter.computeHash({ event: "order.paid", order_id: "o-1" })
    const b = await adapter.computeHash({ event: "order.paid", order_id: "o-1" })
    expect(a).toBe(b)
    expect(a).toHaveLength(64)
  })

  it("extracts event type and source order id, with safe fallbacks", () => {
    expect(adapter.extractEventType({ event: "order.paid" })).toBe("order.paid")
    expect(adapter.extractEventType({})).toBe("unknown")
    expect(adapter.extractSourceOrderId({ order_id: "o-1" })).toBe("o-1")
    expect(adapter.extractSourceOrderId({})).toBeNull()
  })
})
