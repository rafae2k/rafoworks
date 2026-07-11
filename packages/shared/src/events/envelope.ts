// The domain event envelope — the transport that flows webhook → queue → workflow.
// Everything the consumer needs to route and dedup an event, independent of source.

export interface DomainEnvelope<T = unknown> {
  /** Canonical event type, e.g. "order.paid". */
  eventType: string
  /** Which adapter produced it. */
  source: string
  /** Stable id for idempotency — same logical event ⟹ same dedupId. */
  dedupId: string
  /** ISO timestamp when the event occurred (from the source, not receipt). */
  occurredAt: string
  payload: T
}
