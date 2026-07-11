---
type: changelog
status: current
updated: 2026-07-11
area: docs
---

# Changelog

What changed in production. Generated from per-cycle fragments (`docs/cycles/NN/changelog.md`) by `pnpm changelog:collate` — don't edit the region between the markers by hand.

<!-- collate:start -->

## 2026-07-11
- **Cycle 1** — Initial platform skeleton: webhook → queue → workflow → D1, with an idempotent order sync, a reconcile cron, and a read-only MCP surface. ([cycle](cycles/0001-example-order-sync/))
- **Cycle 1** — Add a React + Vite web dashboard (served as a Worker via Static Assets); fat-webhook path so the example materializes an order with no external source. ([cycle](cycles/0001-example-order-sync/))

<!-- collate:end -->
