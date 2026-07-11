import type { SourceOrder } from "./order-source.js"

// Port: platform-specific webhook handling. Each source that sends us webhooks has
// an adapter implementing this — auth, dedup hashing, event-type extraction.

export interface WebhookAdapterPort {
  /** Source identifier (e.g. "example"). */
  readonly source: string

  /** Verify the webhook is authentic. Throws on failure. */
  authenticate(request: IncomingWebhook): Promise<void>

  /** Compute a deterministic hash of the payload, for deduplication. */
  computeHash(payload: unknown): Promise<string>

  /** Extract the canonical event type (e.g. "order.paid") from the payload. */
  extractEventType(payload: unknown): string

  /** Extract the source order id the event refers to. */
  extractSourceOrderId(payload: unknown): string | null

  /**
   * Extract the order itself IF the webhook carries it ("fat" webhook). Returns
   * null for a "thin" webhook that only names the order — then the workflow fetches
   * the full order from the source adapter. Supporting both is realistic: some
   * vendors send everything, some send just an id.
   */
  extractOrder(payload: unknown): SourceOrder | null
}

export interface IncomingWebhook {
  readonly headers: Record<string, string>
  readonly body: unknown
  readonly query: Record<string, string>
  /** Raw request body text — needed for HMAC verification. */
  readonly rawBody?: string
}
