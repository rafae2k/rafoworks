import { sql } from "drizzle-orm"
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

// The schema is intentionally tiny — four tables that demonstrate the platform's
// load-bearing patterns. Add your domain tables alongside `orders`.

/**
 * webhook_log — the fact-log / dedup ledger for every inbound webhook. The ingress
 * writes a row on receipt; workflows flip its status. This is what makes the
 * pipeline idempotent (same payload_hash ⟹ skip) and reconcilable (a row stuck in
 * 'queued' is a lost event the cron re-drives).
 */
export const webhookLog = sqliteTable(
  "webhook_log",
  {
    id: text("id").primaryKey(), // uuid
    source: text("source").notNull(),
    eventType: text("event_type").notNull(),
    // The source order id the event refers to — stored so the reconcile cron can
    // re-dispatch a stuck event without re-reading the raw payload from R2.
    sourceOrderId: text("source_order_id"),
    payloadHash: text("payload_hash").notNull(),
    // queued | processed | skipped | failed | dead_letter
    status: text("status").notNull().default("queued"),
    errorSlug: text("error_slug"),
    errorMessage: text("error_message"),
    rawKey: text("raw_key"), // R2 object key of the archived raw payload
    receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    processedAt: text("processed_at"),
  },
  (t) => [
    uniqueIndex("webhook_log_hash_uq").on(t.payloadHash),
    index("webhook_log_status_idx").on(t.status, t.receivedAt),
  ],
)

/**
 * execution_log — an audit row per cron/action run, correlatable by request_id.
 * The reconcile cron writes here so "what did the sweep do at 03:00?" is queryable.
 */
export const executionLog = sqliteTable("execution_log", {
  id: text("id").primaryKey(),
  requestId: text("request_id").notNull(),
  action: text("action").notNull(),
  outcome: text("outcome").notNull(), // success | error
  detail: text("detail"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
})

/**
 * system_config — volatile config (mappings, feature flags, rules) lives in the DB,
 * never hardcoded. Value is JSON. This is the "config in DB" convention.
 */
export const systemConfig = sqliteTable("system_config", {
  key: text("key").primaryKey(),
  value: text("value").notNull(), // JSON string
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
})

/**
 * orders — the one example domain entity. Unique on (source, source_order_id) so
 * upserts from re-delivered webhooks are idempotent.
 */
export const orders = sqliteTable(
  "orders",
  {
    id: text("id").primaryKey(),
    sourceOrderId: text("source_order_id").notNull(),
    source: text("source").notNull(),
    status: text("status").notNull(),
    customerName: text("customer_name"),
    totalCents: integer("total_cents").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [uniqueIndex("orders_source_uq").on(t.source, t.sourceOrderId)],
)
