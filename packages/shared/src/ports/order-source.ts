// Port: an external platform that orders come from. An adapter (packages/api/src/
// adapters/example-source.ts) implements this against a concrete API. The domain and
// services depend on THIS interface, never on the adapter — that's the hexagonal rule.

export interface OrderSourcePort {
  /** Source identifier (e.g. "example"). */
  readonly source: string

  /** Fetch one order by its id in the source platform. Returns null if not found. */
  fetchOrder(sourceOrderId: string): Promise<SourceOrder | null>
}

/** The raw shape an adapter returns — vendor status string included, not yet normalized. */
export interface SourceOrder {
  sourceOrderId: string
  /** The source's own status string (e.g. "APPROVED", "shipped"). Normalize before use. */
  rawStatus: string
  customerName: string | null
  totalCents: number
}
