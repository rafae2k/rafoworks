# rafoworks

**An event-driven integration platform on Cloudflare Workers — batteries included, agent-native.**

Most Workers starters give you a router and a `hello world`. Real integration work — webhooks from vendors, payments, ERPs, carriers — needs more: durable events, idempotency, dead-letter queues, reconciliation, structured observability, and a way for an LLM to safely read production. rafoworks is that skeleton, distilled from a production platform, with the vendor-specific parts stripped out and one clean example of each primitive left in.

It ships as two halves that compose:

- **The platform** — a Hono Worker with D1, KV, Queues, Workflows, and R2 wired the way they should be, plus a read-only MCP server for agents.
- **The agent harness** — a deploy gate, docs-lint, and changelog guard wired into hooks, so an AI (or a human) can't ship code that breaks the build or lets the docs rot. It pairs with the [shapeup](https://github.com/rafae2k/claude-flow) Shape Up plugin for the workflow itself.

MIT licensed. Fork it and build your integration platform on top.

## What's inside

```
packages/
  shared/   domain — entities, ports, pure rules, event envelope, error taxonomy (no I/O)
  api/      the Worker — adapters, services, workflows, routes, the composition root
  mcp/      a read-only MCP server (service binding → the api's ToolsEntrypoint)
scripts/    the enforcement — deploy-gate, docs-lint, changelog-guard/collate, scrub-gate
docs/       durable × dated docs with a machine-readable frontmatter contract
.claude/    hooks (the gate) + the destructive-write deny list
CLAUDE.md   the operating manual for humans and agents
```

The one worked example runs the whole pipeline end to end:

```
POST /webhooks/example ─▶ ingress (auth, dedup, archive to R2, record) ─▶ [queue]
   ─▶ dispatch ─▶ OrderSyncWorkflow (durable, idempotent) ─▶ upsert order in D1
      ─▶ emit domain event ─▶ [domain-events queue] ─▶ business consumers
                                                            ▲
                        hourly reconcile cron re-drives anything stuck ┘
```

Swap `ExampleSourceAdapter` for a real vendor and the rest of the platform doesn't change — that's the point of the ports.

## Quickstart

```bash
pnpm install
pnpm --filter @rafoworks/api db:generate init   # generate the initial D1 migration
pnpm test         # 20 tests, incl. seam tests against a real D1
pnpm gate         # the full deploy gate (typecheck + lint + build + test + docs + changelog)
```

To deploy, create your own Cloudflare resources and paste the ids into `packages/api/wrangler.toml`:

```bash
wrangler d1 create rafoworks-db
wrangler kv namespace create CACHE
wrangler r2 bucket create rafoworks-raw-data
# then: pnpm deploy:api  (the gate runs first and blocks on any red check)
```

## The agent harness

This repo assumes an AI is writing code in it, and instruments accordingly:

- **The deploy gate** (`.claude/settings.json` → `scripts/deploy-gate.cjs`) runs typecheck + lint + build + test + docs + changelog before any `wrangler deploy`, and **denies** it on failure. `wrangler deploy` runs none of these on its own.
- **changelog-guard** denies a deploy of changed code with no changelog entry — "shipped ⟹ recorded", enforced from git history.
- **docs-lint** keeps the docs contract (frontmatter, resolving links, no future-intent in durable docs) valid at commit time.
- **scrub-gate** fails if a private identifier ever leaks into this public repo.
- A **deny list** blocks destructive production SQL from the agent, even with verbal approval.

For the workflow itself, install the Shape Up plugin:

```
/plugin marketplace add rafae2k/claude-flow
/plugin install shapeup@rafo-flow
```

Then `/cycle "your goal"` orchestrates research → shape → bet → scope → build → review → ship, leaving an artifact trail in `docs/cycles/`. The plugin ships the **method**; this repo ships the **enforcement** that makes it non-optional. Read [CLAUDE.md](CLAUDE.md) for the full operating manual.

## Why these opinions

Every rule here prevents a class of failure that a typechecker can't see — a race, silent drift, a broken contract. They're documented as resilience invariants in [docs/explanation/architecture.md](docs/explanation/architecture.md). If you keep them, an event-driven system stays honest as it grows.

---

Built by Rafo. MIT.
