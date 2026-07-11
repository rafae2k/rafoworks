# rafoworks

[![CI](https://github.com/rafae2k/rafoworks/actions/workflows/ci.yml/badge.svg)](https://github.com/rafae2k/rafoworks/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**An opinionated, event-driven integration platform on Cloudflare Workers — batteries included, agent-native.**

Most Workers starters give you a router and a `hello world`. Real integration work — webhooks from vendors, payments, ERPs, carriers — needs more: durable events, idempotency, dead-letter queues, reconciliation, structured observability, a read-only surface an agent can safely query, and a dashboard. rafoworks is that skeleton, distilled from a production platform, with the vendor-specific parts stripped out and one clean, runnable example of each primitive left in.

## Why this exists

- **Why an integration platform, not a router.** Integrations fail in ways a request/response app doesn't: a webhook arrives twice, a downstream is down for an hour, an event gets dropped, two events race. A router has no answer for any of these. rafoworks bakes in the answers — dedup, durable retries, a reconciliation net — so you don't rediscover them in an incident.
- **Why event-driven.** Turning every inbound webhook into a durable, idempotent event (webhook → queue → workflow → D1) decouples _receiving_ from _processing_. The queue becomes an outage buffer; the workflow gives you durable, resumable execution; the domain-events arm lets business consumers subscribe without touching ingestion.
- **Why opinionated.** Every convention here prevents a _class_ of failure that a typechecker can't see — a race, silent drift, a broken contract. They're written down as [resilience invariants](docs/explanation/architecture.md). Opinionated defaults are the point: you inherit the scars, not the incidents.
- **Why Cloudflare Workers.** D1, KV, Queues, Workflows, and R2 are one platform, at the edge, with a generous free tier and no servers to run. The whole pipeline in this repo deploys as three small workers.

## What's inside

```txt
packages/
  shared/   domain — entities, ports, pure rules, event envelope, error taxonomy (no I/O)
  api/      the Worker — adapters, services, workflows, routes, the composition root
  mcp/      a read-only MCP server (service binding → the api's ToolsEntrypoint)
  web/      a React + Vite dashboard, served as a Worker via Static Assets
scripts/    the enforcement — deploy-gate, docs-lint, changelog-guard/collate, scrub-gate
docs/       durable × dated docs with a machine-readable frontmatter contract
.claude/    hooks (the gate) + the destructive-write deny list
CLAUDE.md   the operating manual for humans and agents
```

The one worked example runs the whole pipeline end to end:

```txt
POST /webhooks/example ─▶ ingress (auth, dedup, archive to R2, record) ─▶ [queue]
   ─▶ dispatch ─▶ OrderSyncWorkflow (durable, idempotent) ─▶ upsert order in D1
      ─▶ emit domain event ─▶ [domain-events queue] ─▶ business consumers
                                                            ▲
                        hourly reconcile cron re-drives anything stuck ┘
```

A **fat** webhook (carrying the order) materializes the order directly; a **thin** one (just an id) makes the workflow fetch it from the source adapter. Swap `ExampleSourceAdapter` for a real vendor and nothing else changes — that's the point of the ports.

## Prerequisites

- **Node ≥ 20** and **pnpm 10** (`corepack enable` gives you pnpm).
- A **Cloudflare account** (free tier is enough) — only needed to _deploy_, not to run locally.

## Quickstart — run it locally

No Cloudflare account needed; everything runs in Miniflare.

```bash
pnpm install

# secrets for local `wrangler dev`
cp packages/api/.dev.vars.example packages/api/.dev.vars

# create the local D1 schema (the migration is committed under packages/api/drizzle)
pnpm --filter @rafoworks/api db:migrate:local

# boot the api worker on http://localhost:8787 (queues + workflows run locally too)
pnpm dev
```

Now drive the whole pipeline with one webhook (the token matches `.dev.vars`):

```bash
curl -sX POST http://localhost:8787/webhooks/example \
  -H "x-webhook-token: dev-webhook-token" \
  -H "content-type: application/json" \
  -d '{"event":"order.paid","order_id":"o-1","status":"paid","customer_name":"Ada Lovelace","total_cents":4990}'
# → {"ok":true,"status":"queued"}

# the queue consumer + OrderSyncWorkflow run; a moment later the order is materialized:
curl -s http://localhost:8787/orders/example:o-1
# → {"id":"example:o-1","source":"example","sourceOrderId":"o-1","status":"paid",
#    "customerName":"Ada Lovelace","totalCents":4990, ...}

# send the same payload again — deduped, no duplicate (idempotent by construction):
curl -sX POST http://localhost:8787/webhooks/example -H "x-webhook-token: dev-webhook-token" \
  -H "content-type: application/json" -d '{"event":"order.paid","order_id":"o-1","status":"paid"}'
# → {"ok":true,"status":"duplicate"}
```

See it in the dashboard (a second terminal):

```bash
VITE_API_BASE=http://localhost:8787 pnpm --filter @rafoworks/web dev
# open the printed URL — "Recent orders" lists what you just created
```

## Quickstart — deploy to your account

```bash
npx wrangler login   # or set CLOUDFLARE_API_TOKEN (see .envrc.example)

# 1. create the resources (names are yours to choose)
npx wrangler d1 create rafoworks-db
npx wrangler kv namespace create CACHE
npx wrangler r2 bucket create rafoworks-raw-data
npx wrangler queues create webhook-events
npx wrangler queues create webhook-events-dlq
npx wrangler queues create domain-events
npx wrangler queues create domain-events-dlq

# 2. paste the printed database_id / kv id into packages/api/wrangler.toml

# 3. set the api secrets
cd packages/api
npx wrangler secret put EXAMPLE_API_TOKEN
npx wrangler secret put EXAMPLE_WEBHOOK_TOKEN
cd ../..

# 4. apply migrations to the remote D1
pnpm --filter @rafoworks/api db:migrate

# 5. deploy (the gate runs first and blocks on any red check)
pnpm deploy:api
pnpm deploy:mcp
pnpm build && pnpm deploy:web
```

## The green gate

Every change must pass before it ships. Run it any time:

```bash
pnpm gate   # typecheck + lint + build + test + docs-lint + changelog-guard
```

A `PreToolUse` hook runs the same checks before any `wrangler deploy` and **denies** the deploy on failure — because `wrangler deploy` runs none of them on its own. The example ships with **22 tests**, including seam tests against a real D1 (`vitest-pool-workers`).

## Extending it

**Add an adapter** (the common case):

1. Define or reuse a port in `packages/shared/src/ports/`.
2. Implement it as a class with constructor injection in `packages/api/src/adapters/`, validating the vendor response at the boundary with zod.
3. Wire it in `packages/api/src/lib/container.ts` (the composition root) — the only place concretes meet the environment.
4. Add a unit test for the mapping and, if it crosses a critical seam, an integration test (see `packages/api/src/services/webhook-ingress.test.ts`).

**Add a workflow**: create a `WorkflowEntrypoint` in `packages/api/src/workflows/`, export it from `index.ts`, add a `[[workflows]]` block to `wrangler.toml`, and route to it in `services/event-router.ts`.

## The agent harness

This repo assumes an AI is writing code in it, and instruments accordingly:

- **The deploy gate** blocks a deploy on any red check (typecheck/lint/build/test/docs/changelog).
- **changelog-guard** denies a deploy of changed code with no changelog entry — "shipped ⟹ recorded", enforced from git history.
- **docs-lint** keeps the docs contract (frontmatter, resolving links, no future-intent in durable docs) valid at commit time.
- **scrub-gate** fails if a private identifier ever leaks into this public repo.
- A **deny list** blocks destructive production SQL from the agent, even with verbal approval.

For the workflow itself, pair it with **[rafoflow](https://github.com/rafae2k/rafoflow)** — an opinionated Shape Up agent fleet for Claude Code:

```txt
/plugin marketplace add rafae2k/rafoflow
/plugin install shapeup@rafoflow
```

Then `/cycle "your goal"` orchestrates research → shape → bet → scope → build → review → ship, leaving an artifact trail in `docs/cycles/`. rafoflow ships the **method**; this repo ships the **enforcement** that makes it non-optional. Read [CLAUDE.md](CLAUDE.md) for the full operating manual and [docs/explanation/architecture.md](docs/explanation/architecture.md) for the resilience invariants.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: keep it generic and minimal, `pnpm gate` green, `pnpm scrub` clean.

---

Built by Rafo. MIT.
