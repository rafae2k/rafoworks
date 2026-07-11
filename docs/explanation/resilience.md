---
type: architecture
status: current
updated: 2026-07-11
reviewed: 2026-07-11
area: platform
---

# Resilience invariants — with the code

An event-driven pipeline is a promise about time you cannot keep. Webhooks arrive out of order, twice, or an hour late; a queue drops a message; a downstream API times out mid-write. [`architecture.md`](./architecture.md) lists six invariants that hold the system together under that reality. This doc takes each one down to the line of code in this repo that enforces it — because the whole point of these invariants is that they defend against failures the gate cannot see.

The gate (`typecheck + lint + build + test`) proves the code is well-typed and the units behave. It says nothing about ordering, races, or whether two independently-correct components agree on a contract. A handler that assumes "A before B" typechecks. A `return` that reports success without doing the work passes its unit test. A `delete-then-insert` that blanks good data on an empty event is perfectly valid TypeScript. These invariants are the rules that catch the class of bug the gate waves through.

One shared substrate makes all six enforceable: the `webhook_log` table in [`schema.ts`](../../packages/api/src/db/schema.ts). Every inbound event becomes a row — deduped by a unique index, status-tracked, and archivable. It is simultaneously the dedup ledger (invariant 1), the drift detector (invariant 2), and the reconciliation queue (invariant 5). Keep it in view as you read.

## 1. Order-independent handlers

**Class of failure it prevents:** races. Two events for the same entity arriving in either order, or the same event arriving twice, must converge to the same final state.

**The trap:** you write `materialize(order)` assuming the order already exists, or assuming this is the first time you have seen it. Then a retry re-delivers the webhook, or a second workflow fires for the same event, and you either create a duplicate or crash on a row that is already there. "A always arrives before B" is a race waiting to happen, not a guarantee.

**How rafoworks does it:** the order use case is an idempotent upsert keyed on `(source, sourceOrderId)`. It does not care whether this is the first delivery or the fifth, whether the order rode in fat on the webhook or was fetched later — the last writer wins and the row converges. From [`order.ts`](../../packages/api/src/services/order.ts):

```ts
await db
  .insert(orders)
  .values({
    id: `${source}:${src.sourceOrderId}`,
    source,
    sourceOrderId: src.sourceOrderId,
    status,
    customerName: src.customerName,
    totalCents: src.totalCents,
  })
  .onConflictDoUpdate({
    target: [orders.source, orders.sourceOrderId],
    set: {
      status,
      customerName: src.customerName,
      totalCents: src.totalCents,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    },
  });
```

The unique index `orders_source_uq` on `(source, source_order_id)` in [`schema.ts`](../../packages/api/src/db/schema.ts) is what makes `onConflictDoUpdate` a merge instead of a duplicate. Call this once or ten times, from the queue consumer or the reconcile cron, and you land on the same row.

Order-independence extends up to the dispatch layer. The same event can be dispatched twice — once by the queue consumer on first delivery, once by the reconcile cron fifteen minutes later — and it must not spawn two workflow runs. The instance id is derived from the event id, so a re-dispatch is a no-op collision, not a second run. From `dispatch()` in [`index.ts`](../../packages/api/src/index.ts):

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

A deterministic instance id (`${route.name}:${msg.eventId}`) means "the same event dispatched twice creates the same workflow instance," as the comment above the function states. The two arrival paths — first-delivery and reconciliation — are interchangeable by construction.

## 2. Never silent-skip an invariant

**Class of failure it prevents:** silent drift. The slow accumulation of records that quietly did not get the work done, with no error to trace back to.

**The trap:** `if (!precondition) { log.warn(); return }`. It looks defensive. It reports success to the caller. And it leaves a hole that nothing ever fills, growing without noise until someone notices months of records are wrong. A no-op masquerading as success is the most dangerous shape in the whole system.

**How rafoworks does it:** an unrecognized status is not skipped and not coerced into a plausible neighbor — it throws. From [`order.ts`](../../packages/api/src/services/order.ts):

```ts
const status = normalizeSourceStatus(src.rawStatus);
if (!status) {
  throw new PermanentError(
    `unknown status "${src.rawStatus}" from ${source}`,
    "unknown_source_status",
  );
}
```

`PermanentError` (from [`errors.ts`](../../packages/shared/src/errors.ts)) carries a stable `error_slug`, so the failure is queryable, not a mystery in a log line. Because it is _permanent_, `isTransient()` returns false and the queue consumer will not burn retries on it — it fails loudly and moves to the dead-letter path where a human can see it. The alternative, coercing `"unknown"` into `"pending"`, would have written a wrong-but-valid row and vanished. This one screams.

The same principle governs an event with no workflow to run. It would be easy to `return` and leave the row `queued` forever — which is exactly the silent-drift trap, a status nothing ever flips. Instead `dispatch()` in [`index.ts`](../../packages/api/src/index.ts) records the terminal outcome:

```ts
if (routes.length === 0) {
  await createDb(env.DB)
    .update(webhookLog)
    .set({ status: "skipped", errorMessage: "no_route", processedAt: sql`CURRENT_TIMESTAMP` })
    .where(and(eq(webhookLog.id, msg.eventId), eq(webhookLog.status, "queued")));
  log.info({ event: "dispatch.no_route", source: msg.source, event_type: msg.eventType });
  return;
}
```

`skipped` with `errorMessage: "no_route"` is an honest terminal state. A row in `skipped` is done on purpose; a row in `queued` is a lost event the cron will chase. The difference between those two states is the difference between "we decided not to act" and "we forgot to." Never conflate them.

And when a workflow marks an event done but the row is gone — archived and reprocessed, say — the UPDATE hits zero rows. That used to be a silent no-op. Now it signals. From `markWebhookDone` in [`shared.ts`](../../packages/api/src/workflows/shared.ts):

```ts
const changes = (res as { meta?: { changes?: number } }).meta?.changes ?? 0;
if (changes === 0) {
  log.warn({ event: "webhook.mark_missing_row", webhook_id: eventId, intended_status: outcome });
}
```

The outcome can no longer vanish. A write that affected nothing is a fact worth emitting, not a shrug.

## 3. Idempotent writes do not destroy on empty

**Class of failure it prevents:** a partial or malformed event overwriting good data with nothing. "I don't know the value" and "the value is empty" are different statements, and treating them the same erases state.

**The trap:** `delete-then-insert` as your idempotency strategy. When a re-processed event arrives itemless — carrying no detail because it is a status-only ping — the delete runs, the insert has nothing, and a complete record is now empty. The write was idempotent in the trivial sense (running it twice matches running it once) and catastrophic in practice.

**How rafoworks does it:** two defenses stack. First, the write is a merge, not a replace. `onConflictDoUpdate` in [`order.ts`](../../packages/api/src/services/order.ts) sets the columns it has a value for and touches nothing else — there is no delete phase that a subsequent empty event could win. Second, and more important, a write only happens once the event has been validated as understood. The unknown-status guard runs _before_ the insert:

```ts
const status = normalizeSourceStatus(src.rawStatus);
if (!status) {
  throw new PermanentError(
    `unknown status "${src.rawStatus}" from ${source}`,
    "unknown_source_status",
  );
}

await db
  .insert(orders)
  .values({
    /* ... */
  })
  .onConflictDoUpdate({
    /* ... */
  });
```

An event the system cannot interpret never reaches the `set` clause, so it can never blank a good `status` with a guess or a null. "I don't know" short-circuits to a thrown `PermanentError`; only "here is a real value" proceeds to the merge. The order of those two statements is the invariant — validate, then write, never write-then-hope.

## 4. Do not trust an implicit invariant between data

**Class of failure it prevents:** a broken contract at a boundary where one component assumed something about another's output that was never checked. "If it has a shipping CEP it has line items" is the archetype — true until the day it isn't.

**The trap:** an external source hands you a string and you treat it as already speaking your vocabulary. Sources drift: a gateway adds a `"partially_refunded"` state, renames `"approved"` to `"captured"`, ships a typo. If your code assumes every raw status maps cleanly to a known one, the day the assumption breaks it fails somewhere far downstream, with a stack trace that points nowhere near the source.

**How rafoworks does it:** the translation from a vendor's vocabulary to the domain's is an explicit, total function that returns `null` for anything it does not recognize — it refuses to guess. From [`order-status.ts`](../../packages/shared/src/rules/order-status.ts):

```ts
export function normalizeSourceStatus(raw: string): OrderStatus | null {
  switch (raw.trim().toLowerCase()) {
    case "pending":
    case "created":
    case "waiting_payment":
      return "pending";
    case "paid":
    case "approved":
    case "confirmed":
      return "paid";
    case "fulfilled":
    case "shipped":
    case "in_transit":
      return "fulfilled";
    case "delivered":
    case "completed":
      return "delivered";
    case "cancelled":
    case "canceled":
    case "refunded":
      return "cancelled";
    default:
      return null;
  }
}
```

The `default: return null` is the whole invariant. The comment on the function is explicit: "Returns null for anything unrecognized — the caller must decide what to do (never silently coerce an unknown status into a known one; that's how drift starts)." The mapping is made a code boundary rather than a hope. The caller — invariant 2's guard in `order.ts` — turns that `null` into a loud `PermanentError` with `error_slug: "unknown_source_status"`, so the moment a source's contract changes, the failure surfaces exactly at the seam that assumed it, tagged and queryable. The state machine in the same file (`canTransition`, `isTerminal`) applies the same discipline to transitions: everything not explicitly listed is rejected.

## 5. Reconciliation as the final net, with an alert

**Class of failure it prevents:** events that are _genuinely_ lost — an outage while the queue was draining, a dropped message, a worker crash between enqueue and process. Not races (invariant 1 handles those at the source), but real gaps.

**The trap:** using a cron to paper over a race you created yourself, and letting the cron's steady hum hide a bug upstream. Reconciliation is a net for events that fall through despite correct code — never a bandage for code that drops them on purpose. And a net that always catches the same number of fish is not a healthy net; it is a leak you have learned to live with.

**How rafoworks does it:** the reconcile cron finds rows stuck in `queued` past a threshold — the primary path should have flipped them long ago — and re-drives them onto the queue. From [`reconcile-cron.ts`](../../packages/api/src/services/reconcile-cron.ts):

```ts
const stuck = await this.db
  .select({
    id: webhookLog.id,
    source: webhookLog.source,
    eventType: webhookLog.eventType,
    sourceOrderId: webhookLog.sourceOrderId,
  })
  .from(webhookLog)
  .where(
    and(
      eq(webhookLog.status, "queued"),
      sql`${webhookLog.receivedAt} < datetime('now', ${`-${STUCK_MINUTES} minutes`})`,
    ),
  )
  .limit(BATCH);

for (const row of stuck) {
  await this.queue.send({
    eventId: row.id,
    source: row.source,
    eventType: row.eventType,
    sourceOrderId: row.sourceOrderId,
    order: null,
    payload: null,
  });
}
```

Three details make this a disciplined net rather than a sloppy one. First, it re-dispatches by `sourceOrderId` with `order: null` — it does not need the original payload, because the workflow re-fetches from the source. Re-driving is safe precisely because invariant 1 made the downstream idempotent; the deterministic dispatch id means a re-run collides with the (never-completed) original instead of duplicating it. Second, `STUCK_MINUTES = 15` and `BATCH = 50` are bounded on purpose — D1 is single-threaded and capped per invocation, so the sweep respects the platform limits rather than fanning out unboundedly. Third, and most important, it alerts when it does work:

```ts
if (stuck.length > 0) {
  log.warn({ event: "reconcile.redispatched", items_processed: stuck.length });
}
```

That `log.warn` is not noise — it is the health signal. The design contract, stated at the top of the file, is that this count must tend to zero: "A residue that doesn't fall means a bug upstream; don't let the cron mask it (prevent > detect > reconcile). NEVER use a cron to paper over a race you created yourself." Every sweep also writes an `execution_log` audit row so "what did the 03:00 sweep touch?" is queryable after the fact. The cron is wired into the worker's `scheduled` handler in [`index.ts`](../../packages/api/src/index.ts), which surfaces `items_processed` on the wide event — so a rising floor is visible in observability, not buried.

## 6. Test the seam, not just the unit

**Class of failure it prevents:** a bug that lives _between_ two components, where each side is individually correct and internally consistent but they disagree on the real contract. Both mocked, both green, both wrong together.

**The trap:** a mock returns the contract you wish the other side had. Your test passes because you asserted against your own assumption twice. The real D1, the real queue message shape, the real dedup index — none of them were exercised. The unit test proves your decision ("what do I do if the row exists?"); it cannot prove the contract ("does the DB actually reject the second insert?").

**How rafoworks does it:** the ingress seam is tested against a _real_ D1 via `vitest-pool-workers`, with only the queue faked — and the queue is faked precisely because the assertion is about what got _sent_, while the DB behavior under test is genuine. From [`webhook-ingress.test.ts`](../../packages/api/src/services/webhook-ingress.test.ts):

```ts
it("is idempotent: the same payload is skipped and not re-enqueued", async () => {
  const db = createDb(env.DB);
  const { queue, sent } = fakeQueue();
  const ingress = new WebhookIngressService({ db, queue });
  const payload = { event: "order.paid", order_id: "o-seam-2" };

  await ingress.ingest(adapter, webhook(payload));
  const second = await ingress.ingest(adapter, webhook(payload));

  expect(second.status).toBe("duplicate");
  expect(sent).toHaveLength(1);
});
```

The second `ingest` is deduped by the actual `webhook_log_hash_uq` unique index in real SQLite — not by a mock that was told to say "duplicate." The test's own comment names the discipline: "the ingress runs against a REAL D1, so this exercises the actual insert/dedup contract, not a mocked stand-in. Only the queue is faked — because here we're testing the DB seam, and we assert on what got sent." That is the rule: every critical boundary (ingress→D1, workflow→D1, adapter→source) earns at least one integration test where the load-bearing side is real. A mock that returns the contract you wanted will lie to you exactly when it matters.

## The hierarchy: prevent > detect > reconcile

These invariants are not a flat list — they are ranked. Prevent the failure at the source (invariants 1, 3, 4: idempotent merges, validate-before-write, refuse to guess). Where you cannot prevent, detect and signal loudly (invariant 2: throw with a slug, warn on a missing row; invariant 6: test the seam so the contract can't silently rot). Only for the failures that survive both — genuine, once-in-an-outage event loss — do you reconcile (invariant 5), and even then with an alert whose count must fall to zero. A cron that reconciles a race you could have prevented is not resilience; it is a leak with a schedule. Fix the race at the source, and let the net catch only what truly falls through.

For invariant 6 in practice — how the seam tests are structured and which boundaries each one covers — the worked example lives in the ingress seam test at [`webhook-ingress.test.ts`](../../packages/api/src/services/webhook-ingress.test.ts).
