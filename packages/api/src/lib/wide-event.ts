import type { Context } from "hono"
import type { AppEnv } from "./types.js"
import { log } from "./logger.js"

// One wide event per request/invocation — a single JSON object the middleware opens
// and handlers enrich as they resolve business context. Emitted once at the end.
// This is the backbone of "canonical log lines" observability.

export interface WideEvent {
  // always present
  event: string
  request_id: string
  type: "http" | "queue" | "cron" | "workflow" | "mcp_tool"
  outcome: "success" | "error" | "skipped"
  duration_ms?: number
  service: string
  version: string
  environment: string

  // http
  method?: string
  path?: string
  route?: string
  status_code?: number

  // business context (enriched by handlers)
  source_system?: string
  event_type?: string
  order_id?: string
  source_order_id?: string
  customer_name?: string

  // queue / workflow / cron
  workflow_name?: string
  queue_name?: string
  cron_trigger?: string
  cron_action?: string
  items_processed?: number
  items_failed?: number

  // mcp_tool
  tool_name?: string
  actor?: string

  // error
  error_slug?: string
  error_message?: string
}

export function createWideEvent(base: Partial<WideEvent>): WideEvent {
  return {
    event: "wide_event",
    request_id: base.request_id ?? crypto.randomUUID(),
    type: base.type ?? "http",
    outcome: "success",
    service: "rafoworks-api",
    version: base.version ?? "dev",
    environment: base.environment ?? "production",
    ...base,
  }
}

export function emitWideEvent(we: WideEvent): void {
  log.info(we as unknown as { event: string; [key: string]: unknown })
}

/**
 * Enrich the request's wide event with business context as handlers resolve it.
 * Safe no-op when no wide event is set on the context.
 */
export function enrichWideEvent(c: Context<AppEnv>, partial: Partial<WideEvent>): void {
  const we = c.get("wideEvent")
  Object.assign(we, partial)
}
