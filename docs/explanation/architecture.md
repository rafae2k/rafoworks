---
type: architecture
status: current
updated: 2026-07-11
reviewed: 2026-07-11
area: platform
---

# Architecture

Hexagonal (ports & adapters) on top of an event-driven Cloudflare Workers pipeline. Two ideas do the heavy lifting: the domain never depends on a vendor, and every inbound event becomes a durable, idempotent, reconcilable fact.

## Shape

```
webhook ──▶ ingress ──▶ [webhook-events queue] ──▶ dispatch ──▶ workflow ──▶ D1
   │            │                                                    │
 route      dedup + archive (R2)                              step.do (durable)
                                                                     │
                                                          [domain-events queue] ──▶ business consumers
```

- **`packages/shared`** — the domain: entities, port interfaces, pure rules, the event envelope, the error taxonomy. No I/O, no dependencies. Consumed as source (JIT), so what typecheck validates is exactly what ships.
- **`packages/api`** — the Worker. Adapters implement the ports; services are use cases; workflows are durable execution; the composition root (`lib/container.ts`) wires concretes to ports.
- **`packages/mcp`** — a read-only MCP server that reaches the api's `ToolsEntrypoint` over a service binding, giving an agent a safe window in.
- **`packages/web`** — a React + Vite dashboard, served as a Worker via Static Assets, reading from the api.

## Resilience invariants

These prevent classes of failure that the gate can't catch (races, silent drift, broken contracts):

1. **Order-independent handlers.** If materializing X depends on Y, don't assume Y arrived first — fire from both sides, idempotently, last writer wins.
2. **Never silent-skip an invariant.** `if (!precondition) return` that reports success is the most dangerous anti-pattern — it becomes drift that accrues without noise. Either handle it, or signal loud.
3. **Idempotent writes don't destroy on empty.** Distinguish "I don't know the value" (partial event) from "the value is zero". Empty = a no-op that preserves state.
4. **Don't trust an implicit invariant between data.** Validate completeness at the boundary that assumes it, with a clear error slug.
5. **Reconciliation is the final net, with an alert.** A cron finds genuinely-lost events and heals them. It must tend to zero — a residue that doesn't fall means a bug upstream.
6. **Test the seam, not just the unit.** A mock tests your decision; an integration test tests the contract. Every critical boundary needs at least one integration test with real components (see `webhook-ingress.test.ts`).

Hierarchy: **prevent > detect > reconcile.** Never use a cron to patch a race you created — fix the race at the source.

## Platform limits (check before any batch / fan-out)

Hard Cloudflare limits — exceeding them throws `overloaded` in production, not a warning:

- **D1**: 6 concurrent connections per invocation, single-threaded (keep `Promise.all` of queries ≤ 5); 1,000 queries per invocation.
- **Workers**: 6 concurrent outbound fetches; a sub-1h cron gets 30s CPU.

Rule of thumb for parallel backfill: `BATCH ≤ 5`, bound the `LIMIT`, process in rounds — never `Promise.all` the whole array.
