---
type: architecture
status: current
updated: 2026-07-11
reviewed: 2026-07-11
area: platform
---

# Testing

Three layers, one through-line. Pure rules get fast unit tests. Anything that touches a binding — D1, a queue, R2, the worker's own fetch handler — gets a seam test against the _real_ component. And mutation testing audits the tests themselves, because a green suite that never checks the seam is a false sense of security, not a safety net.

The philosophy is the same one that shapes the [architecture](./architecture.md): the tests exist to prevent _classes_ of failure — a race, a broken contract, a silently-coerced status — not to hit a coverage number. A test that runs a line but asserts nothing meaningful about it is worse than no test: it makes the line look guarded when it isn't.

| Layer | What it proves | Runs against | Example |
| --- | --- | --- | --- |
| Unit | Your decision logic is correct | Nothing — pure functions | [`order-status.test.ts`](../../packages/shared/src/rules/order-status.test.ts) |
| Seam / integration | The _other side's_ contract holds | Real D1 (Miniflare), real worker | [`webhook-ingress.test.ts`](../../packages/api/src/services/webhook-ingress.test.ts) |
| Mutation | The tests actually _check_ the code | The test suite, re-run per mutant | Stryker on the pure rules |

## Test the seam, not just the unit

This is resilience invariant #6, and it is the reason the api tests boot a real database. A **mock tests your decision** — "what do I do when the queue hands me an empty list?" An **integration test tests the contract** — "what does the queue, or D1, or the ERP, _actually_ hand me?" Those are different questions, and the dangerous bugs live in the gap between them.

A seam bug is the one that passes when both sides are mocked consistently-but-wrong. You mock the DB to accept two inserts of the same event; your dedup code, tested against that mock, looks correct; production has a `UNIQUE` index that throws on the second insert, and the mock never told you. Both halves agreed with each other and disagreed with reality. The only way to catch it is to run one side for real.

So the rule for what to fake is precise: **fake only the thing you are asserting on the other side of; never fake the seam under test.** The ingress seam test makes this explicit — the queue is faked (we want to inspect what got sent), but the database is real:

```ts
// packages/api/src/services/webhook-ingress.test.ts
// Seam test: the ingress runs against a REAL D1 (vitest-pool-workers), so this
// exercises the actual insert/dedup contract, not a mocked stand-in. Only the queue
// is faked — because here we're testing the DB seam, and we assert on what got sent.
function fakeQueue() {
  const sent: WebhookQueueMessage[] = [];
  const queue = {
    send: async (m: WebhookQueueMessage) => void sent.push(m),
  } as unknown as Queue<WebhookQueueMessage>;
  return { queue, sent };
}
```

## Unit tests: the pure rules

The bulk of the suite is fast, dependency-free unit tests over the domain rules in `packages/shared`. These functions have no I/O — the [order state machine](../../packages/shared/src/rules/order-status.ts) is a switch and a lookup table — so the tests are pure input/output, run in milliseconds, and are exactly the code that most rewards mutation testing later.

`canTransition` encodes which order moves are legal. The test pins down every category the state machine cares about — forward moves, cancellation, skipped states, backwards moves, and the terminal trap:

```ts
// packages/shared/src/rules/order-status.test.ts
it("rejects skipping states", () => {
  expect(canTransition("pending", "fulfilled")).toBe(false);
  expect(canTransition("pending", "delivered")).toBe(false);
});

it("rejects any transition out of a terminal status", () => {
  expect(canTransition("delivered", "paid")).toBe(false);
  expect(canTransition("cancelled", "paid")).toBe(false);
});
```

The most load-bearing rule is `normalizeSourceStatus`, the boundary that turns a vendor's raw status string into our vocabulary. It exists so "never assume status semantics" is a _code_ boundary, not a hope — and it returns `null` for anything unrecognized rather than guessing, because a silent coercion of an unknown status into a known one is how drift starts. The test asserts both halves: every known synonym maps, and the unknowns come back `null`.

```ts
// packages/shared/src/rules/order-status.test.ts
it("maps every known vendor synonym to our vocabulary", () => {
  expect(normalizeSourceStatus("created")).toBe("pending");
  expect(normalizeSourceStatus("APPROVED")).toBe("paid");
  expect(normalizeSourceStatus("shipped")).toBe("fulfilled");
  expect(normalizeSourceStatus(" Completed ")).toBe("delivered");
  expect(normalizeSourceStatus("refunded")).toBe("cancelled");
});

it("returns null for unknown statuses instead of guessing", () => {
  expect(normalizeSourceStatus("frobnicated")).toBeNull();
  expect(normalizeSourceStatus("")).toBeNull();
});
```

Note the `" Completed "` case — mixed case, surrounding whitespace. That single assertion pins the `raw.trim().toLowerCase()` normalization in the source. Delete the `.trim()` and this test goes red. That is the kind of specificity that makes a unit test worth keeping.

## Seam / integration tests: a real D1

The api package uses [`@cloudflare/vitest-pool-workers`](../../packages/api/vitest.config.ts), which runs each test _inside_ the Workers runtime under Miniflare and hands it a **real D1 instance**. Not a SQLite shim, not an in-memory fake of Drizzle — the actual binding your worker gets in production. That is what lets a seam test exercise a real contract.

Getting there is three small pieces of plumbing. First, the config reads your migrations off disk and injects them as a binding, so tests run against the real schema rather than an imagined one:

```ts
// packages/api/vitest.config.ts
const migrationsPath = path.join(import.meta.dirname, "drizzle")
const migrations = fs.existsSync(migrationsPath) ? await readD1Migrations(migrationsPath) : []

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          ENVIRONMENT: "test",
          EXAMPLE_API_TOKEN: "test-example-token",
          EXAMPLE_WEBHOOK_TOKEN: "test-webhook-token",
          MIGRATIONS: migrations,
        },
      },
    }),
  ],
```

The `fs.existsSync` guard matters: it lets the config load before the very first migration exists, so a fresh clone can run `db:generate` without a chicken-and-egg failure. The Miniflare bindings mirror `wrangler.toml` but with test-safe values — this is where `ENVIRONMENT: "test"` comes from, which the health check below asserts on.

Second, [`src/test/setup.ts`](../../packages/api/src/test/setup.ts) applies those migrations into the test DB before anything runs, so every seam test hits the real schema:

```ts
// packages/api/src/test/setup.ts
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS);
});
```

Third, [`src/test/env.d.ts`](../../packages/api/src/test/env.d.ts) augments the global `Cloudflare.Env` so `env.DB` and the injected `env.MIGRATIONS` are fully typed inside tests, without a `wrangler types` step:

```ts
// packages/api/src/test/env.d.ts
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      MIGRATIONS: D1Migration[];
    }
  }
}
```

With that in place, the ingress test proves the thing a mock structurally cannot: **idempotency enforced by the database**. The [ingress service](../../packages/api/src/services/webhook-ingress.ts) does a fast-path `SELECT` on `payload_hash`, but the real guard against a concurrent double-delivery is the `UNIQUE` index. Re-deliver the same payload and the second call must resolve to `duplicate` with nothing new enqueued:

```ts
// packages/api/src/services/webhook-ingress.test.ts
it("is idempotent: the same payload is skipped and not re-enqueued", async () => {
  const db = createDb(env.DB);
  const { queue, sent } = fakeQueue();
  const ingress = new WebhookIngressService({ db, queue });
  const payload = { event: "order.paid", order_id: "o-seam-2" };

  await ingress.ingest(adapter, webhook(payload));
  const second = await ingress.ingest(adapter, webhook(payload));

  expect(second.status).toBe("duplicate");
  expect(sent).toHaveLength(1);
});
```

A mocked DB would happily "insert" the same row twice and this test would pass while production behaved differently. Because the DB is real, the test runs the actual index constraint and the actual dedup path together — the seam, not the two halves in isolation.

The [order use case](../../packages/api/src/services/order.ts) gets the same treatment for the _other_ database contract that matters: the `onConflictDoUpdate` upsert keyed on `(source, sourceOrderId)`. Re-delivering an event with a new raw status must update the same row — normalized on the way in — never create a duplicate:

```ts
// packages/api/src/services/order.test.ts
// Re-deliver with a new status → same row updates (normalized), no duplicate.
await upsertOrderFromSource(db, "example", {
  sourceOrderId: "o-up-1",
  rawStatus: "shipped",
  customerName: "Ada",
  totalCents: 4990,
});
expect((await getOrderById(db, "example:o-up-1"))?.status).toBe("fulfilled");
```

And the same test file confirms the boundary refuses an unknown status by throwing the typed error rather than writing garbage — the invariant enforced end to end, not just in the pure function:

```ts
// packages/api/src/services/order.test.ts
await expect(
  upsertOrderFromSource(db, "example", {
    sourceOrderId: "o-up-2",
    rawStatus: "frobnicated",
    customerName: null,
    totalCents: 0,
  }),
).rejects.toMatchObject({
  slug: "unknown_source_status",
  message: expect.stringContaining("unknown status"),
});
```

Two more seam tests round out the pattern. [`reconcile-cron.test.ts`](../../packages/api/src/services/reconcile-cron.test.ts) seeds one event stuck in `queued` 30 minutes ago and one that arrived a minute ago, then asserts the cron re-dispatches exactly the stale one. That test is only meaningful against a real DB, because what it exercises is the SQL time-window comparison `receivedAt < datetime('now', '-15 minutes')` — a mock of the query would just return whatever list you told it to. Finally, [`health.test.ts`](../../packages/api/src/routes/health.test.ts) drives the actual `worker.fetch` handler, booting the middleware and route exactly as a request hits them:

```ts
// packages/api/src/routes/health.test.ts
const res = await worker.fetch(new Request("https://rafoworks.test/health"), env, ctx);
expect(res.status).toBe(200);
const body = (await res.json()) as { status: string; environment: string };
expect(body.environment).toBe("test");
```

One platform note lives in the same config: coverage uses the **istanbul** provider, not v8, because v8 coverage relies on `node:inspector`, which the Workers runtime doesn't expose. The `hookTimeout`/`testTimeout` are bumped to 30s to absorb the Miniflare cold-start; isolated tests still finish in well under two seconds.

## Mutation testing: does the test actually _check_ the line?

Coverage answers "did this line run?" Mutation answers the question that actually matters: "if this line were wrong, would a test catch it?" Those come apart constantly. A line can be at 100% coverage and completely unguarded — executed by a test that asserts nothing about _its_ behavior.

[Stryker](../../stryker.config.json) closes that gap by attacking the code. It makes a small, semantics-changing edit — flip `===` to `!==`, delete a branch, blank a string literal, force a conditional to `true` — and re-runs the suite. If a test fails, the **mutant is killed**: something checked that line. If every test still passes, the mutant **survived**, and you have found a hole that coverage was blind to.

### A concrete kill

Take `normalizeSourceStatus`. Stryker's string-literal mutator replaces a non-empty string with an empty one, so this case:

```ts
// packages/shared/src/rules/order-status.ts (original)
case "pending":
case "created":
case "waiting_payment":
  return "pending"
```

becomes, in one mutant:

```ts
// mutant: the "created" label blanked to ""
case "pending":
case "":
case "waiting_payment":
  return "pending"
```

Line coverage does not move. The `return "pending"` line is still executed by the `normalizeSourceStatus("pending")` assertion, so a coverage report shows 100% either way. But the behavior changed: `normalizeSourceStatus("created")` no longer matches `case ""`, falls through to `default`, and returns `null`. The mutant is caught only because a test specifically pins that synonym:

```ts
// packages/shared/src/rules/order-status.test.ts
expect(normalizeSourceStatus("created")).toBe("pending"); // now null → FAILS → mutant killed
```

The `expect(normalizeSourceStatus("")).toBeNull()` assertion kills the _same_ mutant from the other direction — with the label blanked to `""`, an empty input now matches and returns `"pending"` instead of `null`. Two independent tests, two ways to catch one defect: that is what a mutation-hardened suite looks like. Without either assertion — if the test only checked `"pending"` — the mutant survives at full coverage, and Stryker reports the survivor as a precise, line-level pointer to the missing case.

### The configs

There are two Stryker configs because the two packages sit at different risk levels. The [shared config](../../stryker.config.json) targets the pure rules and holds them to a high bar:

```json
{
  "testRunner": "vitest",
  "plugins": ["@stryker-mutator/vitest-runner", "@stryker-mutator/typescript-checker"],
  "checkers": ["typescript"],
  "tsconfigFile": "packages/shared/tsconfig.json",
  "mutate": ["packages/shared/src/rules/*.ts", "!packages/shared/src/**/*.test.ts"],
  "coverageAnalysis": "perTest",
  "incremental": true,
  "concurrency": 8,
  "thresholds": { "high": 90, "low": 70, "break": 80 }
}
```

The `typescript` checker is the important detail here: before running the suite against a mutant, Stryker type-checks it and discards mutants that don't compile, so it doesn't waste time "killing" edits that `tsc` would have rejected anyway. `mutate` scopes the attack to the rules and explicitly excludes test files. `coverageAnalysis: "perTest"` maps which tests cover which code so each mutant only re-runs the relevant tests, and `incremental` caches results between runs so an unchanged file isn't re-mutated.

The [api config](../../stryker-api.config.json) targets the two services with the densest decision logic — the order upsert and the event router — and sets a deliberately lower floor:

```json
{
  "mutate": [
    "packages/api/src/services/order.ts",
    "packages/api/src/services/event-router.ts",
    "!packages/api/src/**/*.test.ts"
  ],
  "coverageAnalysis": "perTest",
  "incremental": true,
  "concurrency": 6,
  "thresholds": { "high": 80, "low": 60, "break": 50 }
}
```

It drops the TypeScript checker (these run through the workers vitest setup) and lowers `break` to 50, because I/O-shaped service code has more mutants that are effectively equivalent or not worth chasing than a pure state machine does. The `concurrency: 6` mirrors the platform's outbound-connection ceiling rather than the shared package's 8.

### Thresholds and where it runs

The three thresholds mean: `high` is the score above which the report shows green, `low` is the amber line, and **`break` is the floor that fails the run**. Shared breaks at 80 because pure rules should be almost fully guarded; the api breaks at 50 because the honest achievable score on I/O code is lower and pretending otherwise just games the number.

Mutation is deliberately a **separate job**, not part of the deploy gate. The gate runs the fast, deterministic checks — typecheck, lint, build, and `pnpm test` (the whole vitest workspace, shared unit plus api seam) — on every deploy. Mutation is slower and analytical; it runs on its own via `pnpm mutation:shared`, `pnpm mutation:api`, or `pnpm mutation` for both. Keeping it out of the blocking path keeps deploys fast while still holding a standing bar on how well-tested the code that matters actually is.

## When to reach for which

1. **Pure logic** — a rule, a mapping, a state machine — gets unit tests, and if it lives in a Stryker `mutate` glob, mutation testing hardens them. This is the bulk of the suite and where the highest bar belongs.
2. **Anything that touches a binding** — D1, a queue, R2, the fetch handler — gets at least one seam test with the _real_ component, so it exercises the contract and not a mock's imagination of it.
3. **Fake only what you assert on the far side** — the queue in the ingress test, never the database under test. If you find yourself mocking the seam you're trying to verify, you're testing your own assumptions back to yourself.
