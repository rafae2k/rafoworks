---
type: rule
status: current
updated: 2026-07-11
reviewed: 2026-07-11
area: platform
---

# Rule: order status lifecycle

**An order moves only along `pending → paid → fulfilled → delivered`, with `cancelled` reachable from `pending` or `paid`. `delivered` and `cancelled` are terminal.**

## Why

The state machine is the one piece of domain logic that everything else trusts. Keeping it pure (no I/O) and in one place means it's the same rule in the webhook path, the workflow, and any future dashboard — and it's the part worth the hardest unit + mutation tests.

## Where it applies

- Enforced in [`packages/shared/src/rules/order-status.ts`](../../../packages/shared/src/rules/order-status.ts): `canTransition`, `isTerminal`, `normalizeSourceStatus`.
- `normalizeSourceStatus` is the boundary that turns a vendor's raw status string into our vocabulary — and returns `null` for anything unrecognized rather than guessing. A source's status never leaks past the adapter (see invariant "never assume status semantics").
- Consumed by [`services/order.ts`](../../../packages/api/src/services/order.ts), which refuses an unknown status (`PermanentError`) instead of coercing it.
