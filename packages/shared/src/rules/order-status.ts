import type { OrderStatus } from "../entities.js"

// Pure business rule: the order state machine. No I/O, no dependencies — the part
// that deserves the hardest unit tests (and mutation testing). Services import this
// to decide transitions; they never re-implement the rules inline.

/** Allowed forward transitions. Everything not listed is rejected. */
const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ["paid", "cancelled"],
  paid: ["fulfilled", "cancelled"],
  fulfilled: ["delivered"],
  delivered: [],
  cancelled: [],
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to)
}

/** A terminal status has no outgoing transitions — the order is done. */
export function isTerminal(status: OrderStatus): boolean {
  return TRANSITIONS[status].length === 0
}

/**
 * Normalize a source's raw status string into our vocabulary. Returns null for
 * anything unrecognized — the caller must decide what to do (never silently coerce
 * an unknown status into a known one; that's how drift starts). Made explicit here
 * so "never assume status semantics" is a code boundary, not a hope.
 */
export function normalizeSourceStatus(raw: string): OrderStatus | null {
  switch (raw.trim().toLowerCase()) {
    case "pending":
    case "created":
    case "waiting_payment":
      return "pending"
    case "paid":
    case "approved":
    case "confirmed":
      return "paid"
    case "fulfilled":
    case "shipped":
    case "in_transit":
      return "fulfilled"
    case "delivered":
    case "completed":
      return "delivered"
    case "cancelled":
    case "canceled":
    case "refunded":
      return "cancelled"
    default:
      return null
  }
}
