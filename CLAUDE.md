# rafoworks

An event-driven integration platform on Cloudflare Workers — a batteries-included, agent-native boilerplate. This file is the operating manual for anyone (human or agent) working in this repo. It is intentionally opinionated; the opinions are what keep an event-driven system from rotting.

## Stack

- **Monorepo**: pnpm workspaces (`packages/shared`, `packages/api`, `packages/mcp`, `packages/web`)
- **api**: Hono on Cloudflare Workers + D1 + KV + Queues + Workflows + R2
- **mcp**: a read-only MCP server for agents, consuming the api via a `ToolsEntrypoint` service binding
- **shared**: domain types, ports, pure rules — no I/O, consumed as source (JIT)
- **DB**: D1 (SQLite) via Drizzle ORM. Migrations: `drizzle-kit generate` + `wrangler d1 migrations apply`
- **Tests**: Vitest + `@cloudflare/vitest-pool-workers` (real D1 in tests). Coverage: istanbul (v8 doesn't work in the Workers runtime)

## Commands

```bash
pnpm install
pnpm test            # all tests
pnpm -r typecheck    # typecheck every package
pnpm lint            # eslint (strictTypeChecked)
pnpm gate            # the full deploy gate, locally
pnpm dev             # wrangler dev (api)
pnpm scrub           # fail if any private identifier leaked (public-repo safety)
```

## Architecture

Hexagonal (ports & adapters) over an event-driven pipeline. The domain never imports an adapter. See [docs/explanation/architecture.md](docs/explanation/architecture.md).

- `packages/shared/src/ports/` — interfaces adapters implement
- `packages/shared/src/rules/` — pure business logic (the order state machine)
- `packages/api/src/adapters/` — concrete implementations (the example source + webhook adapters)
- `packages/api/src/services/` — use cases (webhook ingress, order upsert, reconcile cron)
- `packages/api/src/workflows/` — Cloudflare Workflows (durable execution)
- `packages/api/src/lib/container.ts` — the composition root (wires concretes to ports)
- `packages/web/` — a React + Vite dashboard, served as a Worker via Static Assets (`pnpm build` → `pnpm deploy:web`)

## Resilience invariants (structural rules)

An event-driven system (webhooks → queues → workflows → D1) with eventual consistency. These prevent CLASSES of failure that the gate can't catch — a violation compiles, lints, and passes tests, then drifts in production. Full detail in [architecture.md](docs/explanation/architecture.md).

1. **Order-independent handlers** — don't assume "A before B"; fire materialization from both sides, idempotently.
2. **Never silent-skip an invariant** — `if (!precondition) return` that reports success is the most dangerous anti-pattern. Handle it or signal loud.
3. **Idempotent writes don't destroy on empty** — distinguish "unknown" from "zero"; empty = a no-op that preserves state.
4. **Don't trust an implicit invariant between data** — validate at the boundary that assumes it, with a clear `error_slug`.
5. **Reconciliation is the final net, with an alert** — a cron heals genuinely-lost events; it must tend to zero.
6. **Test the seam, not just the unit** — every critical boundary gets one integration test with real components.

Hierarchy: **prevent > detect > reconcile.** Never use a cron to patch a race you created yourself.

## Platform limits (check before any batch / fan-out)

Hard Cloudflare limits — exceeding them throws `overloaded` in production, not a warning.

- **D1**: 6 concurrent connections/invocation, single-threaded — keep `Promise.all` of queries ≤ 5; 1,000 queries/invocation.
- **Workers**: 6 concurrent outbound fetches; a sub-1h cron gets 30s CPU.
- Parallel backfill: `BATCH ≤ 5`, bounded `LIMIT`, process in rounds — never `Promise.all` the whole array.

## Conventions

- ESM (import/export). Imports carry the `.js` extension.
- TypeScript strict mode.
- Entities are interfaces, not classes. Adapters are classes with constructor injection.
- Secrets in Workers Secrets, never hardcoded. Volatile config (mappings, flags, rules) in D1 (`system_config`), not in code.
- **Structured logging only** — never `console.log` a raw string. Every log has an `event` slug + business context. Use `packages/api/src/lib/logger.ts`.
- **Markdown**: one paragraph per line (soft wrap). A hook runs `prettier --prose-wrap never` after Write/Edit.

## Deploy gate (enforced, not trusted)

No deploy happens without typecheck + lint + build + test + docs + changelog green. A `PreToolUse` hook (`.claude/settings.json` → `scripts/deploy-gate.cjs`) runs the checks before any `wrangler deploy` and denies it on failure. `wrangler deploy` itself runs none of these — that's why the gate exists.

- Run it manually: `pnpm gate`.
- Never route around the gate (don't edit the settings, don't run the bundler another way, don't `--dry-run` to "pass"). If it blocks, fix the cause.

## Production writes

Destructive prod writes (`UPDATE`/`DELETE`/`INSERT`/`ALTER`/`DROP`/`TRUNCATE`) are blocked for the agent (deny list in `.claude/settings.json`), even with verbal authorization. The flow: dry-run `SELECT` showing the rows that will change → hand the user a ready-to-run script → confirm with a `SELECT` after. **Never create an HTTP route to fix one datum** — that's a permanent surface for a one-time problem. Fix in order of preference: (1) make the generic cron/net good enough, (2) a one-shot `scripts/*.mjs`, (3) ready-to-paste SQL.

## Development workflow

Use the Shape Up loop via the [shapeup](https://github.com/rafae2k/rafoflow) plugin:

```
/plugin marketplace add rafae2k/rafoflow
/plugin install shapeup@rafoflow
```

Then `/cycle "your goal"` runs research → shape → bet → scope → build → review → ship, writing artifacts to `docs/cycles/NN/`. Or drive each step by hand (`/shape`, `/scope`, `/engineer`, `/debug`, `/review`, `/ship`). This repo ships the enforcement that makes the method non-optional (the gate, docs-lint, changelog-guard); the plugin ships the method.

**You own the doc.** The agent that writes code owns the docs the change makes untrue — updating them is part of the task. The gate denies a deploy of changed code with no changelog fragment.

## Docs

Start at [docs/README.md](docs/README.md). Read [docs/conventions.md](docs/conventions.md) before writing or moving a doc — durable × dated, frontmatter, "the index doesn't lie".

## This is a public repo

`pnpm scrub` fails if a private identifier leaks. Keep example names generic (`example`, `example.com`); never hardcode real resource ids (use placeholders in `wrangler.toml` and `wrangler d1 create` your own).
