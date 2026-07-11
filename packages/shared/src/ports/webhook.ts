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
}

export interface IncomingWebhook {
  readonly headers: Record<string, string>
  readonly body: unknown
  readonly query: Record<string, string>
  /** Raw request body text — needed for HMAC verification. */
  readonly rawBody?: string
}
