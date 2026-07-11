import type { WideEvent } from "./wide-event.js"

// Every binding and secret the Worker sees. This is the single place that names the
// platform surface — bindings match wrangler.toml, secrets match `wrangler secret put`.
export type Env = {
  // Storage
  DB: D1Database
  CACHE: KVNamespace
  RAW_STORAGE: R2Bucket
  // Queues
  WEBHOOK_QUEUE: Queue
  DOMAIN_EVENTS_QUEUE: Queue
  // Workflows
  ORDER_WORKFLOW: Workflow
  // Deploy correlation (present when [version_metadata] is bound; optional otherwise)
  CF_VERSION_METADATA?: { id: string; tag?: string }
  // Secrets — the example external source (wrangler secret put)
  EXAMPLE_API_TOKEN: string
  EXAMPLE_WEBHOOK_TOKEN: string
  // Optional observability (absent ⟹ the debug log tool answers "not configured")
  AXIOM_TOKEN?: string
  AXIOM_URL?: string
  AXIOM_DATASET?: string
  // Vars
  ENVIRONMENT: string
}

// Hono context type: bindings + per-request variables enriched by middleware/handlers.
export type AppEnv = {
  Bindings: Env
  Variables: {
    requestId: string
    wideEvent: WideEvent
  }
}
