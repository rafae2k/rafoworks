import { z } from "zod"
import { PermanentError } from "@rafoworks/shared"
import type { OrderSourcePort, SourceOrder } from "@rafoworks/shared"
import { resilientFetch } from "../lib/resilient-fetch.js"

// Adapters are classes with constructor injection. This one implements OrderSourcePort
// against a fictional REST API. Swap the base URL, auth, and schema for a real vendor;
// the rest of the platform depends only on the port, so nothing else changes.

// Validate the vendor's response shape at the boundary — a contract break surfaces
// loudly here (ZodError) instead of corrupting the domain downstream.
const OrderResponse = z.object({
  id: z.string(),
  status: z.string(),
  customer_name: z.string().nullable().optional(),
  total_cents: z.number().int().nonnegative(),
})

export class ExampleSourceAdapter implements OrderSourcePort {
  readonly source = "example"

  constructor(
    private readonly token: string,
    private readonly baseUrl = "https://api.example.com",
  ) {}

  async fetchOrder(sourceOrderId: string): Promise<SourceOrder | null> {
    const res = await resilientFetch(`${this.baseUrl}/orders/${encodeURIComponent(sourceOrderId)}`, {
      headers: { authorization: `Bearer ${this.token}` },
      slug: "example",
    })
    if (res.status === 404) return null // domain meaning of a 4xx: the caller decides
    if (!res.ok) throw new PermanentError(`example: unexpected ${res.status}`, "example_bad_response")
    const parsed = OrderResponse.parse(await res.json())
    return {
      sourceOrderId: parsed.id,
      rawStatus: parsed.status,
      customerName: parsed.customer_name ?? null,
      totalCents: parsed.total_cents,
    }
  }
}
