import { PermanentError } from "@rafoworks/shared"
import type { IncomingWebhook, WebhookAdapterPort } from "@rafoworks/shared"

// Webhook-side adapter for the same fictional source. Verifies the shared-secret
// token, hashes the payload for dedup, and extracts the canonical event type + order
// id. Real vendors: swap token auth for HMAC and map their event names here.

export class ExampleWebhookAdapter implements WebhookAdapterPort {
  readonly source = "example"

  constructor(private readonly token: string) {}

  async authenticate(req: IncomingWebhook): Promise<void> {
    const provided = req.headers["x-webhook-token"] ?? req.query["token"]
    if (!provided || provided !== this.token) {
      throw new PermanentError("example webhook: invalid token", "webhook_auth_failed")
    }
  }

  async computeHash(payload: unknown): Promise<string> {
    const data = new TextEncoder().encode(JSON.stringify(payload))
    const digest = await crypto.subtle.digest("SHA-256", data)
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
  }

  extractEventType(payload: unknown): string {
    const p = payload as { event?: unknown }
    return typeof p.event === "string" ? p.event : "unknown"
  }

  extractSourceOrderId(payload: unknown): string | null {
    const p = payload as { order_id?: unknown }
    return typeof p.order_id === "string" ? p.order_id : null
  }
}
