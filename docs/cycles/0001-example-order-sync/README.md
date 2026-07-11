---
type: cycle
status: done
updated: 2026-07-11
area: platform
---

# Cycle 0001 — Example order sync

An example of what a cycle leaves behind. A real cycle run via `/cycle` writes `research.md`, `pitch.md`, `spec.md`, and `notes.md` alongside this README and the changelog fragment. This one is the seed feature that ships with the boilerplate.

## Problem

Prove the whole pipeline end to end with one thin, real slice: an order paid in an external source should show up in our D1.

## Done means

- A signed webhook `POST /webhooks/example` is authenticated, deduped, archived, recorded, and enqueued.
- The `OrderSyncWorkflow` fetches the order from the source adapter and upserts it (idempotent), then emits a domain event.
- A stuck event is re-driven by the reconcile cron.
- Every step covered by a test, including a seam test against real D1.

## Tasks

- [x] Shared: order entity, `OrderSourcePort`, `WebhookAdapterPort`, order-status rule
- [x] Adapters: `ExampleSourceAdapter`, `ExampleWebhookAdapter`
- [x] Ingress → queue → dispatch → `OrderSyncWorkflow` → D1
- [x] Reconcile cron + read routes + MCP `get_order`

## Notes

The one place order status is decided is the pure rule; unknown vendor statuses are refused, not coerced. The seam test (`webhook-ingress.test.ts`) runs against a real D1 so it exercises the dedup contract, not a mock of it.
