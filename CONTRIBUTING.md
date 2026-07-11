# Contributing to rafoworks

Thanks for your interest. rafoworks is a boilerplate, so the bar is a little different from a normal app: changes should keep it **generic, minimal, and green**. One clean example of each primitive beats five real ones.

## Getting started

```bash
pnpm install
pnpm --filter @rafoworks/api db:generate init   # first time only: generate the D1 migration
pnpm test                                        # 20 tests, incl. seam tests against a real D1
```

## The gate is the contract

Every change must pass the full gate before it can ship:

```bash
pnpm gate   # typecheck + lint + build + test + docs-lint + changelog-guard
```

`wrangler deploy` runs none of these on its own — the gate (a `PreToolUse` hook + `pnpm gate`) is what keeps `main` deployable. Don't route around it; fix the cause.

## How we work

This repo uses the Shape Up loop via the [shapeup](https://github.com/rafae2k/rafoflow) plugin. For anything non-trivial, run `/cycle "your goal"` (or drive `/shape`, `/scope`, `/engineer`, `/debug` by hand) and leave the artifact trail in `docs/cycles/NN/`.

Two rules that the gate enforces:

- **You own the doc.** If your code change makes a doc untrue, updating it is part of the same change — not a follow-up. A code change with no changelog fragment is denied at the gate.
- **Test the seam.** New behavior at a boundary (adapter ↔ API, queue ↔ consumer, DB write ↔ read) needs at least one integration test with the real component. See `packages/api/src/services/webhook-ingress.test.ts`.
- **Keep mutation green.** For changes to business logic (rules, core services), run `pnpm mutation` — a surviving mutant is a weak test. Kill the mutant (strengthen the test); don't lower the threshold. See [CLAUDE.md → Mutation testing](CLAUDE.md).

Read [CLAUDE.md](CLAUDE.md) — it's the full operating manual (architecture, resilience invariants, platform limits, conventions).

## Adding an adapter (the common extension)

1. Define or reuse a port in `packages/shared/src/ports/`.
2. Implement it as a class with constructor injection in `packages/api/src/adapters/`, validating the vendor response at the boundary (zod).
3. Wire it in `packages/api/src/lib/container.ts` (the composition root).
4. Add a unit test for the mapping and, if it crosses a critical seam, an integration test.

Keep vendor names out of the domain and the UI — the ports exist so the rest of the platform never learns which vendor you plugged in.

## Pull requests

- Keep it focused and small. A boilerplate grows by staying legible.
- `pnpm gate` green; `pnpm mutation` green for changed business logic.
- Describe the change in the user's language, not the implementation's.

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).
