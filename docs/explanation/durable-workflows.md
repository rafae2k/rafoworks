---
type: architecture
status: current
updated: 2026-07-11
reviewed: 2026-07-11
area: platform
---

# Durable workflows

A Cloudflare Workflow is the platform's durable-execution primitive: a multi-step process that **survives a crash and resumes from the last completed step**, not from the top. When a webhook needs more than one side effect to land — fetch the order, write it to D1, announce it on the business arm — the sequence lives in a Workflow so a failure halfway through never replays the half that already succeeded. This doc walks the one Workflow the boilerplate ships, [`OrderSyncWorkflow`](../../packages/api/src/workflows/order-sync.ts), and the shared machinery around it, and explains why each piece is shaped the way it is.

## Durable execution versus a plain queue handler

Start with the contrast, because it's the whole reason Workflows exist. A queue consumer has **no memory of partial progress**. If its handler throws, the runtime re-delivers the _entire_ message and runs the handler again from the first line. Look at the queue consumer in [`index.ts`](../../packages/api/src/index.ts) — a failure re-runs the whole body:

```ts
} catch (err) {
  // Exponential backoff IN CODE — the queue becomes the outage buffer. Combined
  // with max_retries: 10 in wrangler.toml, this survives hours of a downstream
  // being down instead of burning retries in minutes and dead-lettering.
  const delay = Math.min(60 * 2 ** msg.attempts, 3600)
  log.error({ event: "queue.retry", queue: batch.queue, attempt: msg.attempts, error: ... })
  msg.retry({ delaySeconds: delay })
}
```

That's fine when the handler does exactly _one_ idempotent thing. And that is deliberately all our queue handler does: it calls `dispatch`, which creates the Workflow, and acks. The heavy, multi-step work is pushed _into_ the Workflow. Why? Because if you tried to do three side effects inline in a queue handler and the third failed, the retry would redo the first two — a second fetch, a second write, a second event emitted — every time. You'd be forced to make the whole handler atomically idempotent, which for a sequence of external calls is nearly impossible.

A Workflow breaks that sequence into **checkpointed steps**. Each `step.do(...)` runs, persists its result, and moves on. If the Worker is evicted, the instance OOMs, or a downstream 500s and the step exhausts its retries, the engine **rehydrates the instance and re-enters at the first step that hasn't completed** — every earlier step returns its recorded result without executing again. The class docstring states the contract directly:

```ts
/**
 * Durable, idempotent order sync. Each `step.do` is a checkpointed, retriable unit:
 * if the workflow crashes after "upsert-order" it resumes there, not from scratch,
 * and a step that already ran returns its recorded result. That's why the steps must
 * be idempotent — fetch is a read, upsert is keyed. This is the durable-execution
 * primitive the whole platform leans on instead of ad-hoc retry loops.
 */
export class OrderSyncWorkflow extends WorkflowEntrypoint<Env, OrderSyncPayload> {
```

Read that last sentence twice: **because a completed step is never re-run, but an incomplete one may be retried, every step must be safe to run zero-or-more times.** That is the single invariant this whole file is organized around.

## Anatomy of a run: `step.do`

The `run` method receives the event payload and a `WorkflowStep`. It does three units of work, each wrapped in `step.do`. Walk them in order.

**Step 1 — `fetch-order` (only for thin webhooks).** A fat webhook arrives with the order attached; a thin one carries only an id, so the Workflow fetches the full order from the source adapter:

```ts
order = await step.do("fetch-order", async () => {
  const adapter = new ExampleSourceAdapter(this.env.EXAMPLE_API_TOKEN);
  return adapter.fetchOrder(sourceOrderId);
});
```

Why is re-running this safe? It's a **pure read** against the source system. Fetching the same order id twice returns the same order and changes nothing upstream. If the Workflow crashes after the fetch but before the upsert, the resumed run returns the _recorded_ order from the checkpoint and never even re-hits the adapter — but even if it did, no harm. Reads are the easiest steps to make idempotent because they already are.

**Step 2 — `upsert-order`.** Materialize the order into D1:

```ts
await step.do("upsert-order", async () => {
  await upsertOrderFromSource(createDb(this.env.DB), source, order);
});
```

The idempotency lives one layer down, in [`upsertOrderFromSource`](../../packages/api/src/services/order.ts). It's an **upsert keyed on `(source, sourceOrderId)`**, not a blind insert:

```ts
await db
  .insert(orders)
  .values({ id: `${source}:${src.sourceOrderId}`, source, sourceOrderId: src.sourceOrderId, status, ... })
  .onConflictDoUpdate({
    target: [orders.source, orders.sourceOrderId],
    set: { status, customerName: src.customerName, totalCents: src.totalCents, updatedAt: sql`CURRENT_TIMESTAMP` },
  })
```

Run it once and the row is inserted; run it again and `onConflictDoUpdate` rewrites the same row to the same values. No duplicate order, no drift. The unique index `orders_source_uq` in the [schema](../../packages/api/src/db/schema.ts) is what makes the conflict target real. Note also what this function _doesn't_ do: it refuses an unknown status by throwing a `PermanentError` rather than coercing it — never silent-skip an invariant. A permanent error is a signal for the step to stop retrying and fail loudly, not a value to swallow.

**Step 3 — `emit-domain-event`.** Announce that the order synced, onto the _domain-events_ queue — the business arm that analytics, CRM sync, and notifications subscribe to, blind to the webhook that triggered it:

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

This is the one step that _can_ double-fire in theory — if the emit succeeds but the checkpoint write races a crash, a resumed run could send the envelope again. That's exactly why the envelope carries `dedupId: eventId`. The idempotency key travels _with_ the event, so the downstream consumer can recognize a re-delivery and no-op. Idempotency at the boundary you emit across, not just the boundary you receive on. The seam this crosses is meaning versus transport: the webhook arm is "a message arrived"; the domain arm is "an order happened." Consumers react to the second and never learn about the first.

## Marking the webhook done: no-downgrade, no silent no-op

After the steps, the Workflow flips the `webhook_log` row from `queued` to a terminal outcome via the helpers in [`shared.ts`](../../packages/api/src/workflows/shared.ts). This is where a subtle race is defused. **More than one Workflow may fire for a single event** (today only `order-sync` runs, but the router is built to fan an event out to several). If two Workflows race to mark the same row, a naive last-writer-wins would let a late `processed` clobber an earlier `failed`, and the failure would vanish. So marking is a **priority-ordered, no-downgrade write**:

```ts
// Higher = worse. Multiple workflows may fire for one event; none should downgrade a
// status a previous one set. "failed" always wins; "processed" never overwrites
// "skipped"/"failed".
const OUTCOME_PRIORITY: Record<string, number> = { queued: 0, skipped: 1, processed: 2, failed: 3 };
```

Before writing, `markWebhookDone` reads the current status and bails if its intended outcome is _less severe_ than what's already recorded:

```ts
if ((OUTCOME_PRIORITY[outcome] ?? 0) < (OUTCOME_PRIORITY[current] ?? 0)) return;
```

So `failed` always sticks, `processed` never overwrites a `skipped` or `failed`, and the worst outcome any Workflow observed is the one that survives. The mark itself is wrapped in `step.do(\`mark-${outcome}\`)`, so it too is a durable, retriable step — consistent with everything else in the pipeline.

The second guardrail here is the **missing-row warning**. If the `UPDATE` touches zero rows — the event was archived and reprocessed, say — a silent no-op would let the outcome disappear. So it signals instead:

```ts
// If the row is gone (e.g. archived + reprocessed), the UPDATE hits 0 rows. That
// was a silent no-op before — now it signals, so the outcome never vanishes.
const changes = (res as { meta?: { changes?: number } }).meta?.changes ?? 0;
if (changes === 0) {
  log.warn({ event: "webhook.mark_missing_row", webhook_id: eventId, intended_status: outcome });
}
```

This is the "never silent-skip an invariant" rule from [architecture.md](./architecture.md) applied at the smallest scale: a write that quietly did nothing is drift waiting to accrue, so it becomes a queryable warning line instead.

## Deterministic instance ids

Here is the piece that ties the durable engine back to the async pipeline and makes the _whole thing_ idempotent. When `dispatch` in [`index.ts`](../../packages/api/src/index.ts) creates a Workflow instance, it does **not** let the engine mint a random id — it builds a stable one from the route name and the event id:

```ts
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
```

The instance id _is_ the idempotency key. Creating with a stable id means **the same event dispatched twice refers to the same instance, never a second run.** That matters because two independent paths dispatch the exact same event:

1. The **queue consumer**, on the happy path, when the webhook first arrives.
2. The **reconcile cron** in [`reconcile-cron.ts`](../../packages/api/src/services/reconcile-cron.ts), which sweeps for events stuck in `queued` past a threshold and re-drives them by re-sending onto the queue.

If the cron re-drives an event that the queue actually _did_ process (it was just slow, or the mark hadn't landed yet), the re-dispatch computes `order-sync:<eventId>` — the id that already exists — and does not spawn a duplicate Workflow. Without the deterministic id, every reconcile pass would risk double-processing the very events it's meant to rescue, and the safety net would become a source of duplicates. With it, the net is free to be aggressive: re-driving a not-actually-lost event is a harmless no-op. This is the concrete mechanism behind "prevent > detect > reconcile" — the reconcile step is safe precisely because idempotency is enforced at the id, upstream of it.

## The wide event wrapped around the run

Every invocation across the platform emits exactly one structured "wide event" — one JSON object summarizing the run — and a Workflow is no exception. The [`WideEvent`](../../packages/api/src/lib/wide-event.ts) type carries a `type` discriminator that includes `"workflow"`. `OrderSyncWorkflow` opens one at the top of `run`:

```ts
const we = createWideEvent({
  type: "workflow",
  workflow_name: "order-sync",
  version: this.env.CF_VERSION_METADATA?.id ?? "dev",
  environment: this.env.ENVIRONMENT,
  source_system: source,
  source_order_id: sourceOrderId ?? undefined,
});
```

Its `outcome` defaults to `"success"` and is overridden as the run resolves. On a legitimate no-op — no order and no id, or the order isn't found in the source — the run sets `skipped` and marks the webhook accordingly instead of pretending it worked:

```ts
if (!sourceOrderId) {
  we.outcome = "skipped";
  await markWebhookSkipped(step, this.env.DB, eventId, "no order and no source order id on event");
  return;
}
```

On a thrown error, the `catch` stamps `error` plus the message and re-throws so the step's own retry/backoff still governs; the `finally` emits the event exactly once no matter which path won:

```ts
} catch (err) {
  we.outcome = "error"
  we.error_message = err instanceof Error ? err.message : String(err)
  throw err
} finally {
  emitWideEvent(we)
}
```

The re-throw is important: setting `outcome = "error"` is for _observability_, not control flow. Swallowing the error there would rob the Workflow engine of the signal it needs to retry the step or fail the instance. You annotate, then you let it propagate.

## When to reach for a Workflow (and how to wire one)

Use a Workflow when a single event needs **several side effects that must land as a durable sequence** — where partial progress has to survive a crash, and re-running an already-done step would repeat an external effect you can't take back (a second charge, a duplicate order, a re-sent notification). `order-sync` qualifies: fetch, then write, then emit, each a distinct effect you want to happen once.

Use a **plain queue consumer** when the work is a single idempotent action with no meaningful intermediate state — all-or-nothing retry of the whole handler is acceptable. The domain-events consumer in `index.ts` is exactly this: it just logs the received envelope and acks. There's nothing to checkpoint, so wrapping it in a Workflow would be ceremony with no payoff. The dividing line is _steps_: one atomic action → queue handler; a sequence whose middle must be replay-safe → Workflow.

Wiring a Workflow takes two edits, and both are load-bearing. First, declare the binding in [`wrangler.toml`](../../packages/api/wrangler.toml):

```toml
# --- Workflows (durable execution) ---
[[workflows]]
name = "order-sync"
binding = "ORDER_WORKFLOW"
class_name = "OrderSyncWorkflow"
```

The `binding` is what `env.ORDER_WORKFLOW` resolves to at runtime — the same handle the router hands back in [`event-router.ts`](../../packages/api/src/services/event-router.ts) so `dispatch` can call `.create(...)`. The `class_name` must match the exported class exactly.

Second — the requirement that trips people up — the Workflow class **must be exported from the Worker's main module** so wrangler can find and bind it. It lives in `workflows/order-sync.ts`, but it's re-exported from the entrypoint:

```ts
// Workflow classes and the RPC entrypoint must be exported from the worker's main
// module so wrangler can bind them.
export { OrderSyncWorkflow } from "./workflows/order-sync.js";
```

Skip that re-export and deploy fails to bind the class to `ORDER_WORKFLOW`, even though the `[[workflows]]` block looks correct — the config points at a `class_name` the bundle never surfaces. To add a second Workflow: write the class, add a `[[workflows]]` block with a fresh `binding`, re-export it from `index.ts`, and teach `getWorkflowsForEvent` which event types route to it. The router returning a list is the fan-out seam — one event can drive several Workflows, and the no-downgrade `markWebhookDone` rule above is what keeps their outcomes from stepping on each other.
