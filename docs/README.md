---
type: index
status: current
updated: 2026-07-11
area: docs
---

# Docs

The canonical index. Start here.

## What this is

An event-driven integration platform on Cloudflare Workers — the batteries-included skeleton behind [rafoworks](../README.md). Webhooks come in, become durable events, and flow through queues and workflows into D1, with structured observability and a read-only MCP surface for agents.

## Map

**Understand the platform** (deep dives):

- [explanation/architecture.md](explanation/architecture.md) — the shape: hexagonal + event-driven, the resilience invariants, platform limits.
- [explanation/pipeline.md](explanation/pipeline.md) — one webhook traced end to end: ingress → queue → dispatch → workflow → D1 → domain events.
- [explanation/durable-workflows.md](explanation/durable-workflows.md) — Cloudflare Workflows: `step.do`, resume-after-crash, idempotent steps, deterministic instance ids.
- [explanation/observability.md](explanation/observability.md) — the three layers: structured logs → wide events → CF Logs/Traces over OTEL to Axiom.
- [explanation/resilience.md](explanation/resilience.md) — the six resilience invariants, each with the trap and the real code that avoids it.
- [explanation/testing.md](explanation/testing.md) — unit vs seam tests (against a real D1) and mutation testing.

**Do things**:

- [how-to/add-an-adapter.md](how-to/add-an-adapter.md) — a runbook to add a real source adapter end to end.

**Reference**:

- [reference/rules/order-status.md](reference/rules/order-status.md) — the example business rule (the order state machine).
- [reference/mcp.md](reference/mcp.md) — the MCP server + how to put OAuth in front of it.

**Meta**:

- [conventions.md](conventions.md) — the docs contract: durable × dated, frontmatter, "you own the doc". Read before writing or moving a doc.
- [changelog.md](changelog.md) — what changed in prod (generated from cycle fragments).
- [cycles/](cycles/) — the dated work log. Each cycle leaves research / pitch / spec / notes / changelog.

## The loop

Development runs the Shape Up loop via the [rafoflow](https://github.com/rafae2k/rafoflow) plugin (`/cycle`, `/shape`, `/engineer`, `/debug`, …) — see its [skills in practice](https://github.com/rafae2k/rafoflow/blob/main/docs/skills-in-practice.md) guide for worked examples. This repo ships the _enforcement_ that makes the method non-optional — the deploy gate, docs-lint, and changelog guard. See the root [CLAUDE.md](../CLAUDE.md).
