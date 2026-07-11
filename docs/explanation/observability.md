---
type: architecture
status: current
updated: 2026-07-11
reviewed: 2026-07-11
area: platform
---

# Observability

An event-driven pipeline is opaque by default. A webhook lands, a queue swallows it, a workflow wakes up minutes later on a different machine, a cron sweeps at the top of the hour — by the time something looks wrong there is no call stack to read, only whatever the code chose to write down. Observability here is not a dashboard bolted on afterward; it is a discipline baked into three cooperating layers, each one a strict superset of the concerns below it.

The layers stack like this:

1. **Structured logs** ([`lib/logger.ts`](../../packages/api/src/lib/logger.ts)) — one JSON object per notable moment, always carrying an `event` slug and business context. The atom.
2. **Wide events** ([`lib/wide-event.ts`](../../packages/api/src/lib/wide-event.ts)) — exactly one JSON object per invocation (one request, one cron tick, one workflow run), opened at the start and enriched as context resolves. The canonical log line.
3. **CF Workers Logs + Traces, exported to Axiom over OTEL** (the `[observability]` blocks in [`wrangler.toml`](../../packages/api/wrangler.toml)) — the transport and storage that carries layers 1 and 2 off the edge and makes them queryable.

Layers 1 and 2 are _what you emit_. Layer 3 is _where it goes_. Both wide events and plain logs are just `console.info(JSON.stringify(...))` calls under the hood — the platform's job is to ship, index, and let you query them.

## Layer 1 — Structured logs

The entire logger is twenty lines, and that is the point. There is no framework, no transport config, no log level plumbing — just a typed shape and `console`.

```ts
type LogLevel = "info" | "warn" | "error" | "debug";

export interface LogFields {
  /** Stable event slug — e.g. "webhook.received", "order.upserted". Always present. */
  event: string;
  [key: string]: unknown;
}

function emit(level: LogLevel, fields: LogFields): void {
  console[level](JSON.stringify({ level, ts: new Date().toISOString(), ...fields }));
}

// Structured logging only — never console.log a raw string. Every log has an `event`
// slug and business context (order_id, source, error_slug), so logs are queryable.
export const log = {
  info: (fields: LogFields) => emit("info", fields),
  warn: (fields: LogFields) => emit("warn", fields),
  error: (fields: LogFields) => emit("error", fields),
  debug: (fields: LogFields) => emit("debug", fields),
};
```

Two rules are load-bearing, and the `LogFields` type enforces the first for you:

- **The `event` slug is mandatory.** It is a required field on the interface, so `log.info({})` won't compile. The slug is a _stable, low-cardinality identifier_ for the kind of thing that happened — `order.synced`, `webhook.ingest_failed`, `queue.retry`. You filter and group on it. Free-text messages are the enemy of grouping; a slug is a primary key for "this class of moment".
- **Never `console.log` a raw string.** `console.log("Processing order " + orderId)` produces a line you can `grep` but never aggregate — you cannot ask "how many `order.synced` in the last hour?" of prose. Every emission goes through `log.*` so it comes out as one flat JSON object with typed fields.

Here is a real call from the order workflow. It fires once the order is durably upserted:

```ts
log.info({
  event: "order.synced",
  source,
  source_order_id: order.sourceOrderId,
  order_status: order.rawStatus,
});
```

Read the fields left to right: `event` is the slug you query on; `source` is the upstream system (`"example"`); `source_order_id` is the business key that lets you trace one order end to end; `order_status` is the raw status from the source, kept for debugging status-mapping bugs. Every field is queryable, none is buried in a sentence.

The error shape adds a second slug. When webhook ingestion blows up, [`routes/webhooks.ts`](../../packages/api/src/routes/webhooks.ts) writes:

```ts
log.error({
  event: "webhook.ingest_failed",
  error: err instanceof Error ? err.message : String(err),
});
```

`event` classifies the failure; `error` carries the human-readable message. In hotter paths you will also see an `error_slug` — a stable, queryable code for the _category_ of error, distinct from the free-form `error` string — so you can count `stock_error` failures without parsing exception text. The queue consumer in [`index.ts`](../../packages/api/src/index.ts) shows the pattern under retry:

```ts
log.error({
  event: "queue.retry",
  queue: batch.queue,
  attempt: msg.attempts,
  error: err instanceof Error ? err.message : String(err),
});
```

`attempt` on the line means a saw-tooth of retry counts in your logs _is_ your backoff working; a flat line of `attempt: 0` that never climbs means messages are dying on first try.

## Layer 2 — Wide events

Structured logs tell you about _moments_. A wide event tells you about a _unit of work_ — one per invocation, start to finish, in a single row. This is the "canonical log line" pattern: instead of reconstructing what a request did by stitching together ten scattered log lines, you emit one fat object that already carries everything.

The full field set is the contract. Everything optional is filled in only when it applies:

```ts
export interface WideEvent {
  // always present
  event: string;
  request_id: string;
  type: "http" | "queue" | "cron" | "workflow" | "mcp_tool";
  outcome: "success" | "error" | "skipped";
  duration_ms?: number;
  service: string;
  version: string;
  environment: string;

  // http
  method?: string;
  path?: string;
  route?: string;
  status_code?: number;

  // business context (enriched by handlers)
  source_system?: string;
  event_type?: string;
  order_id?: string;
  source_order_id?: string;
  customer_name?: string;

  // queue / workflow / cron
  workflow_name?: string;
  queue_name?: string;
  cron_trigger?: string;
  cron_action?: string;
  items_processed?: number;
  items_failed?: number;

  // mcp_tool
  tool_name?: string;
  actor?: string;

  // error
  error_slug?: string;
  error_message?: string;
}
```

The `type` discriminator is the key. It says which invocation kind this row describes, and it tells you which optional groups to expect: an `http` row has `method`/`path`/`status_code`; a `workflow` row has `workflow_name`; a `cron` row has `cron_trigger`/`cron_action`/`items_processed`. One table, one schema, five shapes.

Three functions manage the lifecycle:

```ts
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
  };
}

/**
 * Enrich the request's wide event with business context as handlers resolve it.
 * Safe no-op when no wide event is set on the context.
 */
export function enrichWideEvent(c: Context<AppEnv>, partial: Partial<WideEvent>): void {
  const we = c.get("wideEvent");
  Object.assign(we, partial);
}
```

`createWideEvent` seeds the defaults — a fresh `request_id`, `outcome: "success"` as the optimistic starting assumption, the service name — and lets the caller override anything. `enrichWideEvent` mutates the in-flight event stored on the Hono context; `emitWideEvent` flushes it through the same `log.info` as everything else, so the wide event rides the exact same pipe as a structured log.

### The HTTP path: open once, enrich, emit once

The whole HTTP surface is wrapped by one middleware in [`index.ts`](../../packages/api/src/index.ts). It opens the wide event before any route runs and guarantees emission in a `finally`, so a thrown handler still produces exactly one row:

```ts
app.use("*", async (c, next) => {
  const start = Date.now()
  const we = createWideEvent({
    type: "http",
    method: c.req.method,
    path: c.req.path,
    version: c.env.CF_VERSION_METADATA?.id ?? "dev",
    environment: c.env.ENVIRONMENT,
  })
  c.set("wideEvent", we)
  c.set("requestId", we.request_id)
  try {
    await next()
    we.status_code = c.res.status
    we.outcome = c.res.status >= 500 ? "error" : "success"
  } catch (err) {
    we.outcome = "error"
    we.error_message = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    we.duration_ms = Date.now() - start
    emitWideEvent(we)
  }
}
```

Note the outcome policy: a `5xx` is an `error`, everything else is a `success`. That is a deliberate boundary — a `401` from a webhook whose signature failed is a _successful rejection_, not a system error, so it stays `success` and doesn't pollute your error rate. Note too that `duration_ms` is computed here, in the middleware; the cron and workflow paths open their own wide events but don't currently stamp a duration, so `duration_ms` is an HTTP-populated field in practice.

Handlers deep in the stack contribute business context without knowing anything about the middleware. The webhook route, after ingestion succeeds, tells the wide event _what kind of event_ it just handled:

```ts
const result = await container.webhookIngress.ingest(container.webhookAdapter, incoming);
enrichWideEvent(c, { source_system: "example", event_type: result.eventType });
return c.json({ ok: true, status: result.status }, 200);
```

By the time the middleware's `finally` runs, that one row already carries `source_system` and `event_type`. The handler resolved the business meaning; the middleware owns the mechanics. Neither reaches into the other.

### The cron path

The scheduled handler builds its own wide event with `type: "cron"` and the reconcile-specific fields, then mirrors the HTTP `try/finally` discipline so a crashing sweep still emits one row:

```ts
async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
  const requestId = crypto.randomUUID()
  const we = createWideEvent({
    type: "cron",
    cron_trigger: event.cron,
    cron_action: "reconcile",
    version: env.CF_VERSION_METADATA?.id ?? "dev",
    environment: env.ENVIRONMENT,
  })
  try {
    const result = await new ReconcileCron(createDb(env.DB), env.WEBHOOK_QUEUE).run(requestId)
    we.items_processed = result.redispatched
  } catch (err) {
    we.outcome = "error"
    we.error_message = err instanceof Error ? err.message : String(err)
  } finally {
    emitWideEvent(we)
  }
}
```

`items_processed` is where reconciliation becomes observable. Per the resilience invariants, the reconcile cron must _tend to zero_ — a healthy pipeline loses nothing, so `items_processed` should hover near 0. Plotting this one field over time turns "is the async plumbing leaking?" into a chart: a rising redispatch count is a bug upstream, not a busy cron.

### The workflow path

The order-sync workflow opens a `type: "workflow"` wide event seeded with the business keys it already knows, then — like the others — guarantees emission in `finally`, even on the re-throw that lets the Workflows engine retry the step:

```ts
const we = createWideEvent({
  type: "workflow",
  workflow_name: "order-sync",
  version: this.env.CF_VERSION_METADATA?.id ?? "dev",
  environment: this.env.ENVIRONMENT,
  source_system: source,
  source_order_id: sourceOrderId ?? undefined,
});

try {
  // ... fetch-order / upsert-order / emit-domain-event steps ...
} catch (err) {
  we.outcome = "error";
  we.error_message = err instanceof Error ? err.message : String(err);
  throw err;
} finally {
  emitWideEvent(we);
}
```

The workflow also uses `outcome: "skipped"` for the legitimate no-work cases (no order and no source id, or the order genuinely not found in the source) — the third outcome value that keeps "we correctly did nothing" distinct from both success and failure. That distinction matters: a silent skip that masquerades as success is exactly the drift the platform's invariants forbid, so `skipped` is a first-class, queryable outcome rather than a suppressed log.

### One gap worth naming: the queue consumer

The `queue()` handler in [`index.ts`](../../packages/api/src/index.ts) does _not_ open a wide event today. Each message emits structured logs instead — `dispatch.no_route`, `dlq.message`, `domain_event.received`, `queue.retry`:

```ts
if (batch.queue === "domain-events") {
  log.info({ event: "domain_event.received", ...(msg.body as DomainEnvelope) });
  msg.ack();
  continue;
}
```

The `type: "queue"` discriminator and `queue_name` field exist in the `WideEvent` schema precisely so this consumer (and the MCP server's `mcp_tool` type) can adopt the one-row-per-message pattern later without changing the contract. Until then, the queue arm is observable through its per-message slugs, and end-to-end order tracing leans on `source_order_id`, which the HTTP row and the workflow row both carry.

## Layer 3 — CF Workers Logs, Traces, and the Axiom export

Emitting good JSON is worthless if it evaporates. Layer 3 is the Cloudflare-side config that captures every `console` call and every trace and, optionally, forwards them to Axiom. It lives entirely in [`wrangler.toml`](../../packages/api/wrangler.toml):

```toml
[observability]
enabled = true
head_sampling_rate = 1

[observability.logs]
invocation_logs = true
head_sampling_rate = 1
# destinations = ["axiom-logs"]

[observability.traces]
enabled = true
head_sampling_rate = 1
# destinations = ["axiom-traces"]
```

Walking the blocks:

- **`[observability]`** turns Workers Logs on for the Worker. `head_sampling_rate = 1` means keep 100% of invocations — no sampling. For a low-to-moderate volume integration platform you want every event; sampling is a knob for when volume forces it.
- **`[observability.logs]`** with `invocation_logs = true` captures the `console.*` output — which is every structured log and every wide event, since both are `console` calls. This is what makes layers 1 and 2 land somewhere.
- **`[observability.traces]`** enables distributed traces (spans), so a request that fans out to D1, a queue, and a workflow shows up as a connected trace, not just isolated log lines.
- **`destinations`** is the OTEL export target. Commented out, logs and traces stay in Cloudflare's own Workers Logs UI. Uncommented, they are forwarded to the named destinations over OpenTelemetry.

To turn Axiom on:

1. In the Cloudflare dashboard, go to Workers → Observability → destinations and create two destinations named `axiom-logs` and `axiom-traces` pointed at your Axiom dataset.
2. Uncomment the two `destinations = [...]` lines above.
3. Redeploy. From then on every wide event and structured log streams into Axiom, queryable in APL.

### Version stamping — correlate behavior with a deploy

The last observability block wires the deploy id into the runtime:

```toml
# Exposes the deploy version id to the Worker (env.CF_VERSION_METADATA.id) — every
# wide event is stamped with it, so you can correlate behavior with a specific deploy.
[version_metadata]
binding = "CF_VERSION_METADATA"
```

That binding is why every `createWideEvent` call reads `version: env.CF_VERSION_METADATA?.id ?? "dev"`. Every wide event carries the exact deploy that produced it in its `version` field. When an error rate spikes at 14:03, you don't guess whether a deploy caused it — you group errors by `version` and watch the count jump on one id. The `?? "dev"` fallback keeps local runs (where the binding is absent) from crashing.

## Querying: from JSON line to answer

Here is a single HTTP wide event as it lands — one flat row, everything about the request in it:

```json
{
  "level": "info",
  "ts": "2026-07-11T14:03:22.481Z",
  "event": "wide_event",
  "request_id": "3f9c1e02-7a6b-4d51-9c2a-8e1f0b7d4a10",
  "type": "http",
  "outcome": "success",
  "service": "rafoworks-api",
  "version": "b2c4a1e8-...-deploy-id",
  "environment": "production",
  "method": "POST",
  "path": "/webhooks/example",
  "status_code": 200,
  "source_system": "example",
  "event_type": "order.paid",
  "duration_ms": 42
}
```

A workflow row for the same order looks like this — different `type`, different fields, same `source_order_id` to join on:

```json
{
  "level": "info",
  "ts": "2026-07-11T14:03:25.902Z",
  "event": "wide_event",
  "request_id": "9a12...",
  "type": "workflow",
  "workflow_name": "order-sync",
  "outcome": "success",
  "service": "rafoworks-api",
  "version": "b2c4a1e8-...-deploy-id",
  "environment": "production",
  "source_system": "example",
  "source_order_id": "SO-10231"
}
```

With the rows in Axiom, questions become one-liners. Every error outcome in the last hour, newest first:

```text
['rafoworks-api']
| where event == "wide_event" and outcome == "error"
| sort by _time desc
| limit 50
```

The full timeline of one order — the HTTP ingress, the workflow run, and any error along the way — by joining on the business key:

```text
['rafoworks-api']
| where source_order_id == "SO-10231"
| sort by _time asc
```

The reconcile-cron health check, which should trend toward zero:

```text
['rafoworks-api']
| where type == "cron" and cron_action == "reconcile"
| summarize sum(items_processed) by bin(_time, 1h)
```

Before the Axiom export is on, the same rows are visible in the Cloudflare dashboard's Workers Logs, and `npx wrangler tail` streams them live during a deploy.

## Why wide events beat scattered logs

The instinct is to sprinkle `log.info` at every interesting line and reconstruct the story later by searching for a request id. That works until it doesn't: you are forever one missing log call away from a blind spot, high-cardinality context (the customer name, the source order id) is smeared across ten rows so no single row is answerable on its own, and counting "requests that touched customer X and failed" means a self-join across your logs.

The wide event inverts it. One unit of work produces **one row that already holds every dimension you'd want to slice by** — outcome, duration, source system, order id, deploy version, error slug. That is the canonical-log-line pattern: the row _is_ the record of the work, not a fragment of it. Adding a new dimension is one `enrichWideEvent` call, and it is instantly available to every past-and-future query without touching a schema. Scattered logs still have their place — they narrate the _moments within_ a unit of work, the retries and the intermediate decisions — but the wide event is the row you actually query when you ask "what is my system doing?". Structured logs are the transcript; the wide event is the headline.
