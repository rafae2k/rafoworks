import { ExampleSourceAdapter } from "../adapters/example-source.js"
import { ExampleWebhookAdapter } from "../adapters/example-webhook.js"
import { createDb } from "../db/index.js"
import { WebhookIngressService } from "../services/webhook-ingress.js"
import type { Env } from "./types.js"

/**
 * Composition root: the one place concrete adapters/services are wired to the
 * environment. Handlers pull what they need off the container — they never `new` an
 * adapter themselves, so swapping an implementation touches only this file.
 */
export function createContainer(env: Env) {
  const db = createDb(env.DB)
  return {
    db,
    sourceAdapter: new ExampleSourceAdapter(env.EXAMPLE_API_TOKEN),
    webhookAdapter: new ExampleWebhookAdapter(env.EXAMPLE_WEBHOOK_TOKEN),
    webhookIngress: new WebhookIngressService({ db, queue: env.WEBHOOK_QUEUE, raw: env.RAW_STORAGE }),
  }
}
