// Domain entities. Interfaces, not classes (the platform convention: entities are
// data, behavior lives in pure rules and services).

/**
 * The canonical order lifecycle. This is OUR vocabulary — every external source's
 * raw status string is normalized into one of these before it touches the domain
 * (see `normalizeSourceStatus` in rules/order-status). Never let a vendor's status
 * string leak past the adapter boundary.
 */
export type OrderStatus = "pending" | "paid" | "fulfilled" | "delivered" | "cancelled"

export interface Order {
  /** Our id (stable, internal). */
  id: string
  /** The order's id in the external source platform. */
  sourceOrderId: string
  /** Which adapter this order came from (e.g. "example"). */
  source: string
  status: OrderStatus
  customerName: string | null
  totalCents: number
  createdAt: string
  updatedAt: string
}
