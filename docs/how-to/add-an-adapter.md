---
type: runbook
status: current
updated: 2026-07-11
area: platform
---

# How to add an adapter

This runbook walks you through adding a new order source end to end — a fictional vendor called **Acme** — by mirroring the example adapters exactly. The whole point of the hexagonal split (see [architecture.md](../explanation/architecture.md)) is that this is a bounded, mechanical job: you implement two small classes against two port interfaces, wire them once in the composition root, and the rest of the platform — services, workflows, dashboard — never learns that Acme exists. The domain depends on the port; only the adapter depends on the vendor.

Two ports cover an order source: [`OrderSourcePort`](../../packages/shared/src/ports/order-source.ts) (pull one order by id) and [`WebhookAdapterPort`](../../packages/shared/src/ports/webhook.ts) (authenticate + extract from an inbound push). You will implement one adapter for each, modeled on [`example-source.ts`](../../packages/api/src/adapters/example-source.ts) and [`example-webhook.ts`](../../packages/api/src/adapters/example-webhook.ts). Keep those two files open in a split — this guide is a diff against them, nothing more.

## Step 1 — Reuse the port (don't redefine it)

Almost always you reuse the existing ports. They are deliberately vendor-neutral: `OrderSourcePort` says "fetch one order by its id, return `null` if not found," and `SourceOrder` is the raw shape an adapter returns — vendor status string included, not yet normalized.

```ts
// packages/shared/src/ports/order-source.ts — already exists, reuse as-is
export interface OrderSourcePort {
  readonly source: string;
  fetchOrder(sourceOrderId: string): Promise<SourceOrder | null>;
}

export interface SourceOrder {
  sourceOrderId: string;
  rawStatus: string; // the source's own status; normalize with rules/order-status.ts
  customerName: string | null;
  totalCents: number;
}
```

Only add a field to `SourceOrder` if **every** source can supply it and the domain genuinely needs it — a new field is a contract change that ripples to every adapter and the mapper. If Acme carries something exotic that no one else does, keep it out of the port; the raw payload is archived in R2 for replay if you ever need it. Define a _new_ port only when you are integrating a different kind of capability (a carrier, a CRM, a notifier) — not another order source. For Acme, reuse both ports and move on.

## Step 2 — Implement `AcmeSourceAdapter`

Copy the shape of `ExampleSourceAdapter` verbatim and change three things: the base URL, the auth header, and the Zod schema that validates the vendor's response. Adapters are classes with constructor injection; the domain never `new`s them.

```ts
// packages/api/src/adapters/acme-source.ts
import { z } from "zod";
import { PermanentError } from "@rafoworks/shared";
import type { OrderSourcePort, SourceOrder } from "@rafoworks/shared";
import { resilientFetch } from "../lib/resilient-fetch.js";

// Validate the vendor's response at the boundary. A contract break surfaces LOUD here
// (ZodError) instead of corrupting the domain downstream. Match Acme's real field names.
const AcmeOrder = z.object({
  order_ref: z.string(),
  state: z.string(),
  buyer: z.object({ name: z.string().nullable() }).nullable().optional(),
  amount: z.object({ cents: z.number().int().nonnegative() }),
});

export class AcmeSourceAdapter implements OrderSourcePort {
  readonly source = "acme";

  constructor(
    private readonly token: string,
    private readonly baseUrl = "https://api.acme.com/v2",
  ) {}

  async fetchOrder(sourceOrderId: string): Promise<SourceOrder | null> {
    const res = await resilientFetch(
      `${this.baseUrl}/orders/${encodeURIComponent(sourceOrderId)}`,
      {
        headers: { authorization: `Bearer ${this.token}` },
        slug: "acme",
      },
    );
    if (res.status === 404) return null; // 4xx meaning is domain-specific: 404 ⟹ "return null"
    if (!res.ok) throw new PermanentError(`acme: unexpected ${res.status}`, "acme_bad_response");
    const p = AcmeOrder.parse(await res.json());
    return {
      sourceOrderId: p.order_ref,
      rawStatus: p.state,
      customerName: p.buyer?.name ?? null,
      totalCents: p.amount.cents,
    };
  }
}
```

Three rules make this adapter correct, and all three come from the example:

1. **Go through `resilientFetch`, never bare `fetch`.** [`resilient-fetch.ts`](../../packages/api/src/lib/resilient-fetch.ts) classifies only _transport_ failures — network error, timeout, and 5xx become `TransientError` (worth retrying). It returns the `Response` for everything else, 2xx _and_ 4xx, because a 4xx's meaning is domain-specific. The `slug` you pass ("acme") prefixes the error slug so a network blip reads `acme_network` and an upstream 500 reads `acme_5xx` in the logs.
2. **404 maps to `null`; other 4xx map to `PermanentError`.** The port's contract is "return `null` if not found." A 422 or 401, by contrast, is unrecoverable by retry — throw `PermanentError` with a stable slug so the queue/workflow boundary dead-letters instead of retry-storming. That transient-vs-permanent split is the whole [error taxonomy](../../packages/shared/src/errors.ts).
3. **Parse at the boundary.** `AcmeOrder.parse(...)` throws a `ZodError` the moment Acme's payload drifts from what you mapped. That is the point: a broken contract fails here, once, with a clear stack — not three hops downstream as a silently-wrong `totalCents`.

## Step 3 — Implement `AcmeWebhookAdapter`

The webhook adapter is where a real vendor differs most from the example. `ExampleWebhookAdapter` authenticates with a shared-secret token compared with `===`. Most production vendors instead sign the raw body with HMAC-SHA256 and put the hex digest in a header. That is the realistic case, so implement it — the other four methods (`computeHash`, `extractEventType`, `extractSourceOrderId`, `extractOrder`) stay almost identical to the example.

```ts
// packages/api/src/adapters/acme-webhook.ts
import { PermanentError } from "@rafoworks/shared";
import type { IncomingWebhook, SourceOrder, WebhookAdapterPort } from "@rafoworks/shared";

// Acme signs the RAW request body with HMAC-SHA256 and sends the hex digest in a header.
async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time compare so we don't leak the signature byte-by-byte via timing.
function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Vendor event names → canonical event types the platform routes on. The event-router
// keys off the "order." prefix, so this map is what makes Acme's events routable.
const EVENT_MAP: Record<string, string> = {
  "sale.completed": "order.paid",
  "sale.refunded": "order.refunded",
  "sale.shipped": "order.shipped",
};

export class AcmeWebhookAdapter implements WebhookAdapterPort {
  readonly source = "acme";

  constructor(private readonly secret: string) {}

  async authenticate(req: IncomingWebhook): Promise<void> {
    const provided = req.headers["x-acme-signature"];
    // HMAC verifies the EXACT bytes Acme signed, so we need rawBody, not the parsed JSON
    // (re-serializing would change whitespace/key order and break the digest).
    if (!provided || !req.rawBody) {
      throw new PermanentError("acme webhook: missing signature", "webhook_auth_failed");
    }
    const expected = await hmacHex(this.secret, req.rawBody);
    if (!safeEqualHex(provided, expected)) {
      throw new PermanentError("acme webhook: bad signature", "webhook_auth_failed");
    }
  }

  async computeHash(payload: unknown): Promise<string> {
    const data = new TextEncoder().encode(JSON.stringify(payload));
    const digest = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  extractEventType(payload: unknown): string {
    const p = payload as { type?: unknown };
    return typeof p.type === "string" ? (EVENT_MAP[p.type] ?? "unknown") : "unknown";
  }

  extractSourceOrderId(payload: unknown): string | null {
    const p = payload as { order?: { ref?: unknown } };
    return typeof p.order?.ref === "string" ? p.order.ref : null;
  }

  extractOrder(payload: unknown): SourceOrder | null {
    const p = payload as {
      order?: { ref?: unknown; state?: unknown; buyer_name?: unknown; cents?: unknown };
    };
    // Fat webhook = it carries at least the id and status. Otherwise it's thin and the
    // workflow will call AcmeSourceAdapter.fetchOrder() to hydrate it.
    if (typeof p.order?.ref !== "string" || typeof p.order?.state !== "string") return null;
    return {
      sourceOrderId: p.order.ref,
      rawStatus: p.order.state,
      customerName: typeof p.order.buyer_name === "string" ? p.order.buyer_name : null,
      totalCents: typeof p.order.cents === "number" ? p.order.cents : 0,
    };
  }
}
```

Four things to get right here:

1. **Keep the slug `webhook_auth_failed`.** The route maps _exactly_ that slug to a 401 (`err.slug === "webhook_auth_failed"`); any other slug returns 200 so the vendor doesn't retry-storm us. Change the slug and a genuine auth failure will silently look like a success.
2. **HMAC needs `rawBody`, not `req.body`.** `computeHash` over the parsed object is fine for dedup (it just has to be deterministic per delivery), but signature verification must run over the exact bytes Acme signed. `IncomingWebhook.rawBody` exists for precisely this — the route in Step 5 must populate it.
3. **`extractEventType` maps vendor names to canonical types.** The example returns `payload.event` verbatim; Acme names its events `sale.completed`, so translate. Unknown names fall back to `"unknown"` (never throw) — the dispatcher marks such an event `skipped` with reason `no_route` rather than crashing.
4. **`extractOrder` decides fat vs thin.** Return the full `SourceOrder` when the webhook carries id + status ("fat" — no follow-up fetch needed), or `null` when it only names the order ("thin"). Supporting both is realistic and costs nothing: the ingress service passes whatever you return down the queue.

## Step 4 — Wire it into the composition root

[`container.ts`](../../packages/api/src/lib/container.ts) is the one place concrete adapters meet the environment. Handlers pull adapters off the container; they never construct one. Add the two Acme adapters alongside the example ones.

```ts
// packages/api/src/lib/container.ts
import { AcmeSourceAdapter } from "../adapters/acme-source.js";
import { AcmeWebhookAdapter } from "../adapters/acme-webhook.js";
// ...existing imports...

export function createContainer(env: Env) {
  const db = createDb(env.DB);
  return {
    db,
    sourceAdapter: new ExampleSourceAdapter(env.EXAMPLE_API_TOKEN),
    webhookAdapter: new ExampleWebhookAdapter(env.EXAMPLE_WEBHOOK_TOKEN),
    acmeSource: new AcmeSourceAdapter(env.ACME_API_TOKEN),
    acmeWebhook: new AcmeWebhookAdapter(env.ACME_WEBHOOK_SECRET),
    webhookIngress: new WebhookIngressService({
      db,
      queue: env.WEBHOOK_QUEUE,
      raw: env.RAW_STORAGE,
    }),
  };
}
```

Once you have more than a couple of sources, prefer a lookup keyed by `adapter.source` over a flat field per vendor — but two is fine as fields. Now declare the two secrets. They are **secrets**, so they never go into `wrangler.toml` as plaintext (bindings live there; secrets do not). Add them to the `Env` type and to `.dev.vars` for local dev, and set them with `wrangler secret put` in production.

```ts
// packages/api/src/lib/types.ts — extend Env
export type Env = {
  // ...existing bindings and secrets...
  EXAMPLE_API_TOKEN: string;
  EXAMPLE_WEBHOOK_TOKEN: string;
  // Secrets — Acme (wrangler secret put ACME_API_TOKEN / ACME_WEBHOOK_SECRET)
  ACME_API_TOKEN: string;
  ACME_WEBHOOK_SECRET: string;
};
```

```bash
# .dev.vars.example — add so the next person knows the shape (values are placeholders)
ACME_API_TOKEN="dev-acme-token"
ACME_WEBHOOK_SECRET="dev-acme-secret"

# production: set the real secrets (never commit them)
cd packages/api
wrangler secret put ACME_API_TOKEN
wrangler secret put ACME_WEBHOOK_SECRET
```

You only touch [`wrangler.toml`](../../packages/api/wrangler.toml) in this step if Acme needs a **new binding** — a queue, an R2 bucket, or (Step 5) a dedicated workflow. Reusing the existing `WEBHOOK_QUEUE` and `RAW_STORAGE`, as Acme does, means no `wrangler.toml` change here at all.

## Step 5 — Mount the webhook route

Add one `.post` to the chained router in [`webhooks.ts`](../../packages/api/src/routes/webhooks.ts). Because Acme uses HMAC, this route must read the raw body **before** parsing it, and pass it through as `rawBody` — the example route doesn't need to, so this is the one structural change from the template.

```ts
// packages/api/src/routes/webhooks.ts — add the /acme route to the existing chain
export const webhookRoutes = new Hono<AppEnv>()
  .post("/example", async (c) => {
    /* ...unchanged... */
  })
  .post("/acme", async (c) => {
    const container = createContainer(c.env);

    // Read the raw text FIRST (HMAC signs these exact bytes), then parse from it.
    const rawBody = await c.req.text();
    let body: unknown;
    try {
      body = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      body = {};
    }

    const incoming = {
      headers: Object.fromEntries(c.req.raw.headers),
      query: c.req.query(),
      body,
      rawBody,
    };

    try {
      const result = await container.webhookIngress.ingest(container.acmeWebhook, incoming);
      enrichWideEvent(c, { source_system: "acme", event_type: result.eventType });
      return c.json({ ok: true, status: result.status }, 200);
    } catch (err) {
      if (err instanceof PermanentError && err.slug === "webhook_auth_failed") {
        return c.json({ ok: false, error: "unauthorized" }, 401);
      }
      log.error({
        event: "webhook.ingest_failed",
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ ok: false }, 200);
    }
  });
```

The route does three things and nothing else: parse, hand to `container.webhookIngress.ingest(adapter, incoming)`, and translate the result to a status code. It never processes inline or forwards. Everything durable — dedup, R2 archive, the `webhook_log` fact, the enqueue — happens inside [`WebhookIngressService.ingest`](../../packages/api/src/services/webhook-ingress.ts), which is idempotent by construction: a unique index on `payload_hash` means a re-delivery can't create a second event. It answers 200 on success (we own the retry via our queue) and 401 only on real auth failure.

**Do you need a new workflow?** Usually no. [`event-router.ts`](../../packages/api/src/services/event-router.ts) already routes any `order.*` event to `order-sync`, and Step 3 mapped Acme's events into that namespace — so `order.paid` from Acme flows through the existing `OrderSyncWorkflow` with zero routing changes. You add a workflow only when Acme needs _different_ processing. In that case: add a `[[workflows]]` block to `wrangler.toml`, add the binding to `Env`, export the class from [`index.ts`](../../packages/api/src/index.ts) (wrangler binds it from the main module), and add a branch to the router.

```ts
// packages/api/src/services/event-router.ts — only if Acme needs its own workflow
export function getWorkflowsForEvent(env: Env, eventType: string): WorkflowRoute[] {
  if (eventType.startsWith("order.")) {
    return [{ binding: env.ORDER_WORKFLOW, name: "order-sync" }];
  }
  if (eventType.startsWith("acme.")) {
    return [{ binding: env.ACME_WORKFLOW, name: "acme-sync" }];
  }
  return [];
}
```

Returning `[]` for an unrouted event is intentional: the dispatcher marks the webhook `skipped` with reason `no_route`, so an event never sits `queued` forever (the silent-drift trap — a status nothing ever flips).

## Step 6 — Add tests

Two tests, mirroring the pair the example ships. First a **unit test** for the mapping — mock `fetch`, assert the adapter produces the exact port shape and honors the 404-to-`null` and malformed-to-throw rules. Model it on [`example-source.test.ts`](../../packages/api/src/adapters/example-source.test.ts).

```ts
// packages/api/src/adapters/acme-source.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcmeSourceAdapter } from "./acme-source.js";

function mockFetch(status: number, body: unknown) {
  return vi
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
}

describe("AcmeSourceAdapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("maps an Acme order into the port shape", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(200, {
        order_ref: "a-1",
        state: "PAID",
        buyer: { name: "Ada" },
        amount: { cents: 4990 },
      }),
    );
    const order = await new AcmeSourceAdapter("tok").fetchOrder("a-1");
    expect(order).toEqual({
      sourceOrderId: "a-1",
      rawStatus: "PAID",
      customerName: "Ada",
      totalCents: 4990,
    });
  });

  it("returns null on 404, throws on a malformed body", async () => {
    vi.stubGlobal("fetch", mockFetch(404, {}));
    expect(await new AcmeSourceAdapter("tok").fetchOrder("missing")).toBeNull();
    vi.stubGlobal("fetch", mockFetch(200, { order_ref: "a-1" /* missing state/amount */ }));
    await expect(new AcmeSourceAdapter("tok").fetchOrder("a-1")).rejects.toThrow();
  });
});
```

Second, a **seam test** for ingestion. A unit test proves your _decision_ ("what do I do with this payload?"); the seam test proves the _contract_ against a real D1. Point it at the pattern in [`webhook-ingress.test.ts`](../../packages/api/src/services/webhook-ingress.test.ts), which runs the ingress against a real D1 via `vitest-pool-workers` and fakes only the queue (because it asserts on what got sent). Reuse it wholesale — swap `ExampleWebhookAdapter` for `AcmeWebhookAdapter`, feed an Acme-shaped fat payload, and assert the `webhook_log` row lands and the second identical delivery is deduped.

```ts
// packages/api/src/services/acme-ingress.test.ts — seam test, real D1
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { IncomingWebhook } from "@rafoworks/shared";
import { createDb } from "../db/index.js";
import { AcmeWebhookAdapter } from "../adapters/acme-webhook.js";
import { WebhookIngressService, type WebhookQueueMessage } from "./webhook-ingress.js";

function fakeQueue() {
  const sent: WebhookQueueMessage[] = [];
  const queue = {
    send: async (m: WebhookQueueMessage) => void sent.push(m),
  } as unknown as Queue<WebhookQueueMessage>;
  return { queue, sent };
}

const secret = "test-acme-secret";
const adapter = new AcmeWebhookAdapter(secret);

// The seam covers dedup + insert; sign the raw body so authenticate() passes.
async function acmeWebhook(payloadObj: object): Promise<IncomingWebhook> {
  const rawBody = JSON.stringify(payloadObj);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return { headers: { "x-acme-signature": hex }, query: {}, body: payloadObj, rawBody };
}

describe("Acme ingress (seam: real D1)", () => {
  it("records the fact and enqueues a fat webhook, then dedups a re-delivery", async () => {
    const db = createDb(env.DB);
    const { queue, sent } = fakeQueue();
    const ingress = new WebhookIngressService({ db, queue });
    const payload = {
      type: "sale.completed",
      order: { ref: "a-seam-1", state: "PAID", cents: 4990 },
    };

    const first = await ingress.ingest(adapter, await acmeWebhook(payload));
    const second = await ingress.ingest(adapter, await acmeWebhook(payload));

    expect(first.status).toBe("queued");
    expect(first.eventType).toBe("order.paid"); // vendor "sale.completed" mapped to canonical
    expect(sent[0].order?.rawStatus).toBe("PAID"); // fat ⟹ the order rides the queue
    expect(second.status).toBe("duplicate"); // unique index on payload_hash is the guard
    expect(sent).toHaveLength(1);
  });
});
```

Run the suite with `pnpm test` and typecheck with `pnpm -r typecheck` before you ship — the deploy gate runs both regardless, but catching it locally is faster.

## The one rule that keeps this cheap

Notice what never changed above: no service, no workflow, no dashboard component learned the word "Acme." The vendor name lives in exactly three files — the two adapters and the composition root — plus the route path and the secret names. `SourceOrder` crosses the boundary vendor-neutral; the workflow that processes it, the `order_status` rules that normalize `rawStatus`, and the UI that renders it all speak the domain, not the vendor. Keep it that way: no `if (source === "acme")` in a service, no Acme status string leaking into a rule, no vendor logo hard-coded in a component. The port is the only thing that is allowed to know the vendor — which is exactly why adding the next source is this short.
