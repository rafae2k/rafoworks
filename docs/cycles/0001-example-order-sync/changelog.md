# Cycle 0001 — changelog fragment

- 2026-07-11 — Initial platform skeleton: webhook → queue → workflow → D1, with an idempotent order sync, a reconcile cron, and a read-only MCP surface.
- 2026-07-11 — Add a React + Vite web dashboard (served as a Worker via Static Assets); fat-webhook path so the example materializes an order with no external source.
- 2026-07-11 — Emit a wide event on every workflow invocation (observability parity with http/queue/cron) + CF Logs/Traces export config for Axiom over OTEL.
