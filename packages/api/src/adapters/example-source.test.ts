import { afterEach, describe, expect, it, vi } from "vitest"
import { ExampleSourceAdapter } from "./example-source.js"

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  )
}

describe("ExampleSourceAdapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("fetches and maps an order into the port shape", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { id: "o-1", status: "APPROVED", customer_name: "Ada", total_cents: 4990 }))
    const order = await new ExampleSourceAdapter("tok").fetchOrder("o-1")
    expect(order).toEqual({ sourceOrderId: "o-1", rawStatus: "APPROVED", customerName: "Ada", totalCents: 4990 })
  })

  it("returns null when the source has no such order (404)", async () => {
    vi.stubGlobal("fetch", mockFetch(404, { error: "not found" }))
    expect(await new ExampleSourceAdapter("tok").fetchOrder("missing")).toBeNull()
  })

  it("throws on a malformed response (contract break surfaces loud)", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { id: "o-1" /* missing status/total */ }))
    await expect(new ExampleSourceAdapter("tok").fetchOrder("o-1")).rejects.toThrow()
  })
})
