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

- [explanation/architecture.md](explanation/architecture.md) — how the platform is shaped (hexagonal + event-driven) and why.
- [conventions.md](conventions.md) — the docs contract: durable × dated, frontmatter, "you own the doc". Read before writing or moving a doc.
- [reference/rules/order-status.md](reference/rules/order-status.md) — the one example business rule (the order state machine).
- [reference/mcp.md](reference/mcp.md) — the MCP server + how to put OAuth in front of it.
- [changelog.md](changelog.md) — what changed in prod (generated from cycle fragments).
- [cycles/](cycles/) — the dated work log. Each cycle leaves research / pitch / spec / notes / changelog.

## The loop

Development runs the Shape Up loop via the [shapeup](https://github.com/rafae2k/rafoflow) plugin (`/cycle`, `/shape`, `/engineer`, `/debug`, …). This repo ships the _enforcement_ that makes the method non-optional — the deploy gate, docs-lint, and changelog guard. See the root [CLAUDE.md](../CLAUDE.md).
