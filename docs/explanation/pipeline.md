---
type: architecture
status: current
updated: 2026-07-11
reviewed: 2026-07-11
area: platform
---

# The event-driven pipeline

An inbound webhook is a fragile thing: the sender will retry-storm you if you stall, it may deliver the same event twice, and the work it implies (fetch an order, write to D1, notify downstream) can fail for reasons that have nothing to do with the request in front of you. This platform's answer is to split that one HTTP request into a chain of durable hops — ingress, queue, dispatch, workflow, domain event — where each hop does one narrow job, hands off a fact, and is safe to re-run. This page traces a single webhook through every hop, quoting the real code at each seam.

The one sentence to hold onto: **every inbound event becomes a durable, idempotent, reconcilable fact before any real work happens.** The `webhook_log` row is that fact. Everything after ingress is just moving that fact forward, and every stage is built so that running it twice is a no-op.

## The whole path at a glance

```text
                    HTTP 200 (always, unless auth fails → 401)
                         ▲
  webhook ──▶ POST /webhooks/example ──▶ WebhookIngressService.ingest()
  (source)        (routes/webhooks.ts)        (services/webhook-ingress.ts)
                                                   │
                          authenticate → extract type/id/order → computeHash
                                                   │
                                    dedup fast-path (unique index on payload_hash)
                                                   │
                            archive raw → R2   insert webhook_log(status=queued)
                                                   │
                                                   ▼
                                     [ webhook-events queue ]  ◀── reconcile cron (hourly net)
                                                   │
                                          queue() consumer (index.ts)
                                          batch · ack/retry · DLQ branch
                                                   │
                                             dispatch(env, msg)
                                     getWorkflowsForEvent → [] ⟹ mark 'skipped'
                                                   │
                              route.binding.create({ id: `${route.name}:${eventId}` })
                                                   │   (deterministic instance id)
                                                   ▼
                                   OrderSyncWorkflow.run()  (workflows/order-sync.ts)
                                   step.do fetch? → step.do upsert → D1 orders
                                                   │
                                          step.do emit-domain-event
                                                   ▼
                                     [ domain-events queue ]  (the business arm)
                                                   │
                                 analytics · CRM sync · notifications (blind to the webhook)
```

Two queues, not one. The **webhook-events** queue carries raw transport ("something arrived from source X"); the **domain-events** queue carries meaning ("an order was synced"). Keeping them apart is deliberate — they have different retention and retry needs, and business consumers must never have to know what a vendor's webhook looks like.

## Stage 1 — Ingress: answer fast, capture durably

The route does exactly three things — parse, authenticate, ingest — and then gets out of the way. It never processes the event inline and never forwards it anywhere; that is the queue's job. See [`routes/webhooks.ts`](../../packages/api/src/routes/webhooks.ts):

```ts
export const webhookRoutes = new Hono<AppEnv>().post("/example", async (c) => {
  const container = createContainer(c.env);

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const incoming = {
    headers: Object.fromEntries(c.req.raw.headers),
    query: c.req.query(),
    body,
  };

  try {
    const result = await container.webhookIngress.ingest(container.webhookAdapter, incoming);
    enrichWideEvent(c, { source_system: "example", event_type: result.eventType });
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

Look at the two return values in the `catch`. A genuine auth failure returns **401** — the sender should know it is unauthorized and stop. Any _other_ error returns **200**. That is not swallowing the error; it is a deliberate contract: once we have decided to accept a webhook we own its retry, through our own queue. If we returned 500 the source would retry-storm us on top of the retry we already scheduled, doubling the load exactly when something is already wrong. The malformed-body branch is the same instinct — a body that will not parse becomes `{}` rather than a thrown exception, because the ingress, not the HTTP layer, decides what a payload means.

Notice the route also never `new`s an adapter. It pulls `webhookIngress` and `webhookAdapter` off the container ([`lib/container.ts`](../../packages/api/src/lib/container.ts)), the one place concretes are wired to the environment. Swapping the example source for a real vendor touches that file and nothing else.

The real work lives in [`services/webhook-ingress.ts`](../../packages/api/src/services/webhook-ingress.ts). Its job is a fixed sequence: authenticate → extract → hash → dedup → archive → record → enqueue.

```ts
async ingest(adapter: WebhookAdapterPort, req: IncomingWebhook): Promise<IngressResult> {
  await adapter.authenticate(req)
  const payload = req.body
  const eventType = adapter.extractEventType(payload)
  const sourceOrderId = adapter.extractSourceOrderId(payload)
  const order = adapter.extractOrder(payload)
  const hash = await adapter.computeHash(payload)

  // Fast-path dedup. The unique index on payload_hash is the real guard against a
  // concurrent double-delivery racing past this check.
  const existing = await this.deps.db
    .select({ id: webhookLog.id })
    .from(webhookLog)
    .where(eq(webhookLog.payloadHash, hash))
    .limit(1)
  if (existing.length) {
    log.info({ event: "webhook.duplicate_skipped", source: adapter.source, event_type: eventType })
    return { status: "duplicate", eventId: existing[0].id, eventType }
  }
  ...
```

Everything vendor-specific is behind the [`WebhookAdapterPort`](../../packages/shared/src/ports/webhook.ts). The service never parses a header or a JSON field itself — it asks the adapter to `authenticate`, `computeHash`, `extractEventType`, `extractSourceOrderId`, and `extractOrder`. The example adapter authenticates with a shared-secret token; a real vendor swaps that one method for HMAC and the rest of the pipeline does not change.

### The idempotency guard

Deduplication happens twice, on purpose. The `select` above is a **fast path**: most re-deliveries are caught cheaply without touching R2 or the queue. But two copies of the same webhook can arrive concurrently, both run the `select`, both see nothing, and both proceed. The real guard is a database invariant — a unique index on `payload_hash` in [`db/schema.ts`](../../packages/api/src/db/schema.ts):

```ts
(t) => [
  uniqueIndex("webhook_log_hash_uq").on(t.payloadHash),
  index("webhook_log_status_idx").on(t.status, t.receivedAt),
],
```

If two inserts race, the second one violates the unique index and throws. That surfaces as a non-auth error in the route, which returns 200 — correct, because the first insert already captured the fact. The fast-path `select` is an optimization; the unique index is the truth. This is the difference between checking a precondition and enforcing an invariant: the check makes the common case cheap, the constraint makes the race impossible.

When the payload is new, the ingress mints an `eventId`, archives the raw body to R2 for replay, writes the `webhook_log` row as `queued`, and enqueues:

```ts
const eventId = crypto.randomUUID();

let rawKey: string | null = null;
if (this.deps.raw) {
  rawKey = `raw/${adapter.source}/${eventId}.json`;
  await this.deps.raw.put(rawKey, JSON.stringify(payload));
}

await this.deps.db.insert(webhookLog).values({
  id: eventId,
  source: adapter.source,
  eventType,
  sourceOrderId,
  payloadHash: hash,
  status: "queued",
  rawKey,
});

await this.deps.queue.send({
  eventId,
  source: adapter.source,
  eventType,
  sourceOrderId,
  order,
  payload,
});
```

The order of those two writes matters: the D1 row lands _before_ the queue send. If the process died between them, the row would sit in `queued` and the reconcile cron would re-drive it (see Stage 2). If we enqueued first and then died before the insert, the message would reference a `webhook_log` row that never existed and the status ledger would lie. Record the fact, then act on it.

### Fat vs thin webhooks

`extractOrder` is what makes the message on the queue _fat_ or _thin_. Some vendors send the whole order in the webhook; some send only an id and expect you to call their API back. The [port](../../packages/shared/src/ports/webhook.ts) supports both, and the example adapter decides based on whether the payload carries a status:

```ts
extractOrder(payload: unknown): SourceOrder | null {
  const p = payload as { order_id?: unknown; status?: unknown; customer_name?: unknown; total_cents?: unknown }
  // Fat webhook = it carries at least the id and status. Otherwise it's thin.
  if (typeof p.order_id !== "string" || typeof p.status !== "string") return null
  return {
    sourceOrderId: p.order_id,
    rawStatus: p.status,
    customerName: typeof p.customer_name === "string" ? p.customer_name : null,
    totalCents: typeof p.total_cents === "number" ? p.total_cents : 0,
  }
}
```

A fat webhook rides the queue with its `order` populated and the workflow skips the fetch. A thin webhook carries `order: null` and only the `sourceOrderId`, so the workflow calls the source adapter to pull the full order. That branch reappears verbatim in Stage 3 — the queue message shape ([`WebhookQueueMessage`](../../packages/api/src/services/webhook-ingress.ts)) is designed to carry "enough to re-drive the event idempotently," fat or thin.

## Stage 2 — The queue consumer and dispatch

The queue is the async artery. The consumer lives in the Worker's default export, [`index.ts`](../../packages/api/src/index.ts), as the `queue()` handler. It processes a batch, and for each message decides one of three things: this is a dead letter, this is a domain event, or this is a webhook to dispatch.

```ts
async queue(batch: MessageBatch, env: Env): Promise<void> {
  for (const msg of batch.messages) {
    try {
      if (batch.queue.endsWith("-dlq")) {
        await handleDeadLetter(env, batch.queue, msg)
        msg.ack()
        continue
      }
      if (batch.queue === "domain-events") {
        log.info({ event: "domain_event.received", ...(msg.body as DomainEnvelope) })
        msg.ack()
        continue
      }
      await dispatch(env, msg.body as WebhookQueueMessage)
      msg.ack()
    } catch (err) {
      // Exponential backoff IN CODE — the queue becomes the outage buffer.
      const delay = Math.min(60 * 2 ** msg.attempts, 3600)
      log.error({ event: "queue.retry", queue: batch.queue, attempt: msg.attempts,
        error: err instanceof Error ? err.message : String(err) })
      msg.retry({ delaySeconds: delay })
    }
  }
}
```

### Ack, retry, and the queue as an outage buffer

The `try/catch` wraps each message individually. On success the message is `ack`ed and gone. On failure it is `retry`ed with a delay computed in code — `Math.min(60 * 2 ** msg.attempts, 3600)` — so attempt 0 waits ~60s, attempt 1 ~120s, doubling up to a ceiling of one hour. That in-code backoff pairs with the wrangler consumer config in [`wrangler.toml`](../../packages/api/wrangler.toml):

```toml
[[queues.consumers]]
queue = "webhook-events"
max_batch_size = 5
max_concurrency = 5
max_retries = 10
retry_delay = 60
dead_letter_queue = "webhook-events-dlq"
```

Ten retries backing off toward an hour means the queue can absorb _hours_ of a downstream being unavailable, then drain when it recovers — instead of burning ten retries in a couple of minutes and dead-lettering everything the moment a dependency hiccups. `max_concurrency = 5` caps how fast the consumer spawns workflows so a traffic burst grows the backlog rather than saturating the Workflows engine. The queue is not just a buffer for throughput; it is the platform's outage tolerance.

### The DLQ branch — nothing vanishes silently

When retries are finally exhausted, Cloudflare moves the message to the dead-letter queue, which the _same_ Worker consumes (note the `-dlq` branch at the top of `queue()`). `handleDeadLetter` turns a dead message into two durable signals — a queryable error log and a `webhook_log` row flipped to `dead_letter`:

```ts
async function handleDeadLetter(env: Env, queue: string, msg: Message): Promise<void> {
  const body = msg.body as Partial<WebhookQueueMessage>;
  log.error({ event: "dlq.message", queue, webhook_id: body.eventId });
  if (body.eventId) {
    await createDb(env.DB)
      .update(webhookLog)
      .set({ status: "dead_letter", processedAt: sql`CURRENT_TIMESTAMP` })
      .where(
        and(eq(webhookLog.id, body.eventId), sql`${webhookLog.status} IN ('queued', 'failed')`),
      );
  }
}
```

The DLQ consumer's config sets `max_retries = 1` and never dead-letters again — the handler always `ack`s. There is no DLQ-of-a-DLQ. A dead event is a fact you can query (`SELECT * FROM webhook_log WHERE status = 'dead_letter'`), never a message that disappeared.

### Dispatch — routing, no-route, and the deterministic instance id

`dispatch()` is the seam between "a message came off the queue" and "a workflow runs." It asks the router which workflows an event type maps to, then creates each one:

```ts
async function dispatch(env: Env, msg: WebhookQueueMessage): Promise<void> {
  const routes = getWorkflowsForEvent(env, msg.eventType);
  if (routes.length === 0) {
    // No route ⟹ mark skipped, never leave the event 'queued' forever (that's the
    // silent-drift trap: a status nothing ever flips).
    await createDb(env.DB)
      .update(webhookLog)
      .set({ status: "skipped", errorMessage: "no_route", processedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(webhookLog.id, msg.eventId), eq(webhookLog.status, "queued")));
    log.info({ event: "dispatch.no_route", source: msg.source, event_type: msg.eventType });
    return;
  }
  for (const route of routes) {
    await route.binding.create({
      id: `${route.name}:${msg.eventId}`,
      params: {
        eventId: msg.eventId,
        source: msg.source,
        eventType: msg.eventType,
        sourceOrderId: msg.sourceOrderId,
        order: msg.order,
      },
    });
  }
}
```

The router itself, [`services/event-router.ts`](../../packages/api/src/services/event-router.ts), is the single place that knows event type → workflow. It is deliberately trivial — one prefix match today, one `if` per workflow you add:

```ts
export function getWorkflowsForEvent(env: Env, eventType: string): WorkflowRoute[] {
  if (eventType.startsWith("order.")) {
    return [{ binding: env.ORDER_WORKFLOW, name: "order-sync" }];
  }
  return [];
}
```

Two design choices here earn their keep. First, an empty route list is not ignored — the event is marked `skipped` with reason `no_route`. Leaving it `queued` would be the silent-drift trap: a status nothing ever flips, which the reconcile cron would then re-drive forever. An event we have no workflow for is _handled_ by explicitly deciding not to handle it.

Second, and this is the load-bearing detail of the whole pipeline: the workflow instance id is **deterministic** — `` `${route.name}:${msg.eventId}` ``. Cloudflare Workflows treats the instance id as an idempotency key; creating an instance with an id that already exists is a no-op, not a duplicate. That is why the _same_ `dispatch()` function is safe to call from both the queue consumer and the reconcile cron. If a message is redelivered, or the hourly cron re-drives an event that was only _apparently_ stuck, both paths compute the identical id `order-sync:<eventId>` and Workflows collapses them into one run. Reconciliation cannot create a second, divergent workflow — because it cannot create a second instance at all.

### The reconcile cron — the net, not the path

That determinism is what makes the safety net safe. The hourly cron in [`services/reconcile-cron.ts`](../../packages/api/src/services/reconcile-cron.ts) sweeps for rows stuck in `queued` past a grace window and re-sends them to the webhook queue:

```ts
.where(
  and(
    eq(webhookLog.status, "queued"),
    sql`${webhookLog.receivedAt} < datetime('now', ${`-${STUCK_MINUTES} minutes`})`,
  ),
)
.limit(BATCH)
```

It re-enqueues with `order: null` and `payload: null` — it does not need the original payload, because a thin re-drive lets the workflow re-fetch from the source. The cron is wired in `wrangler.toml` as `crons = ["0 * * * *"]`, and its guiding rule is written into the file: _prevent > detect > reconcile._ It must tend to zero. A residue that does not fall is a bug upstream, not something to paper over with a busier cron.

## Stage 3 — The workflow: durable, idempotent, one event out

[`workflows/order-sync.ts`](../../packages/api/src/workflows/order-sync.ts) is where the event finally does work. It extends `WorkflowEntrypoint`, and every unit of work is a `step.do` — a checkpointed, retriable boundary. If the workflow crashes after `upsert-order`, it resumes _at the next step_, not from the top, and a step that already completed returns its recorded result. That is the durable-execution primitive the platform leans on instead of hand-rolled retry loops — and it is why every step must be idempotent.

The fat/thin branch from Stage 1 pays off here:

```ts
let order = fatOrder;
if (!order) {
  if (!sourceOrderId) {
    we.outcome = "skipped";
    await markWebhookSkipped(
      step,
      this.env.DB,
      eventId,
      "no order and no source order id on event",
    );
    return;
  }
  order = await step.do("fetch-order", async () => {
    const adapter = new ExampleSourceAdapter(this.env.EXAMPLE_API_TOKEN);
    return adapter.fetchOrder(sourceOrderId);
  });
}
```

A fat webhook skips the fetch entirely. A thin one fetches, and — because `fetch-order` is a `step.do` — a transient API failure retries just that step, not the whole workflow, and never re-runs the upsert that may already have committed. Then the order is written through the idempotent upsert in [`services/order.ts`](../../packages/api/src/services/order.ts):

```ts
await step.do("upsert-order", async () => {
  await upsertOrderFromSource(createDb(this.env.DB), source, order);
});
```

`upsertOrderFromSource` is keyed on `(source, sourceOrderId)` via `onConflictDoUpdate`, so a re-delivered event just rewrites the same row. It also refuses an unknown status by throwing a `PermanentError` rather than coercing it — a small instance of "never silent-skip an invariant." A `PermanentError` is not worth retrying, and the workflow surfaces it instead of quietly writing a garbage status.

Finally, the workflow flips the `webhook_log` status. That happens through [`workflows/shared.ts`](../../packages/api/src/workflows/shared.ts), which is careful about one thing: multiple workflows can fire for a single event, and none of them should _downgrade_ a status a sibling already set.

```ts
const OUTCOME_PRIORITY: Record<string, number> = { queued: 0, skipped: 1, processed: 2, failed: 3 }
...
if ((OUTCOME_PRIORITY[outcome] ?? 0) < (OUTCOME_PRIORITY[current] ?? 0)) return
```

`failed` always wins; `processed` never overwrites `skipped` or `failed`. And if the `UPDATE` hits zero rows (the row was archived and reprocessed), that is logged as `webhook.mark_missing_row` rather than passing silently — a would-be no-op made loud, so an outcome never just vanishes.

## The domain-events arm

The last step in the workflow is the one that decouples "what happened" from "who cares." Instead of the workflow calling analytics, CRM, and notifications directly, it emits a single domain event onto a _second_ queue:

```ts
await step.do("emit-domain-event", async () => {
  const envelope: DomainEnvelope<{ sourceOrderId: string }> = {
    eventType: "order.synced",
    source,
    dedupId: eventId,
    occurredAt: new Date().toISOString(),
    payload: { sourceOrderId: order.sourceOrderId },
  };
  await this.env.DOMAIN_EVENTS_QUEUE.send(envelope);
});
```

The [`DomainEnvelope`](../../packages/shared/src/events/envelope.ts) is source-independent by design — `eventType`, `source`, a `dedupId` for idempotent consumers, an `occurredAt`, and a typed payload. A consumer on the other side routes and dedups purely off the envelope; it never needs to know the shape of the vendor webhook that produced it. Reusing `eventId` as the `dedupId` means a re-driven workflow emits a domain event a downstream consumer can recognize as the same logical event.

The `domain-events` queue is a full sibling of `webhook-events` in [`wrangler.toml`](../../packages/api/wrangler.toml) — its own producer binding, its own consumer, its own DLQ. Today the consumer is a placeholder in `queue()` that just logs `domain_event.received`; real consumers (analytics, CRM sync, notifications) subscribe here, "blind to the webhook that produced the event." Keeping the arms separate means a slow CRM sync can never back-pressure webhook ingestion, and the two can carry different retention and retry policies without one bleeding into the other. The webhook arm is transport; this arm is meaning.

## Trace one event end to end

Put it together by following one `eventId` — call it `E` — through the `webhook_log` status column and the one wide event emitted at each hop. Every invocation opens exactly one wide event (see `lib/wide-event.ts`), enriched as business context resolves and emitted once at the end, so a single trace reads as a chain of canonical log lines.

1. **Ingress (HTTP).** The route runs, `ingest()` inserts `webhook_log` row `E` with `status = queued`, archives the raw payload to `raw/example/E.json` in R2, and enqueues. Wide event: `type: http`, `path: /webhooks/example`, enriched with `source_system` and `event_type`, `outcome: success`, `status_code: 200`. Log line `webhook.received` carries `webhook_id: E`.
2. **Queue → dispatch.** The consumer pulls `E`, `dispatch()` calls `getWorkflowsForEvent`, gets the `order-sync` route, and creates workflow instance `order-sync:E`. The status is still `queued` — no one has flipped it yet, and that is fine as long as the workflow runs promptly. (If it does not, after 15 minutes the reconcile cron re-drives `E` — to the _same_ instance id, so nothing duplicates.)
3. **Workflow.** `OrderSyncWorkflow.run` executes its steps: `fetch-order` (thin only), `upsert-order` writes the `orders` row keyed `example:<sourceOrderId>`, `emit-domain-event` sends `order.synced` onto the domain queue, and `mark-processed` flips `webhook_log.E` to `status = processed` with `processedAt` set. Wide event: `type: workflow`, `workflow_name: order-sync`, `source_order_id`, `outcome: success`. Log line `order.synced`.
4. **Domain arm.** A separate invocation consumes `order.synced` off `domain-events`, blind to how `E` was born. Its own wide event and its own retry budget.

So the status ledger for `E` reads `queued → processed` on the happy path. The other terminal states each map to a specific failure mode: `skipped` when there is no route or no order to sync; `failed` when a step raised and the priority logic recorded it; `dead_letter` when ten retries were exhausted and `handleDeadLetter` caught it. Every one of those is a row you can query, correlated by `webhook_id` / `request_id` to the wide events at each hop — which is the whole point of turning a fleeting HTTP request into a durable, idempotent, reconcilable fact.

For how the pieces fit into the larger hexagonal design (ports, adapters, the composition root, the resilience invariants this pipeline enforces), see [`architecture.md`](./architecture.md).
