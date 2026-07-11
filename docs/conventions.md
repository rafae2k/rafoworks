---
type: index
status: current
updated: 2026-07-11
reviewed: 2026-07-11
area: docs
---

# How the docs work here

The contract that lets `docs/` guide an agent: where things live, the machine-readable frontmatter that routes context, and what "in the standard" means. `scripts/docs-lint.cjs` enforces the checkable parts. (The full method, portable across projects, lives in the shapeup plugin's `cycle` skill under `artifact-discipline.md`.)

## The principle: durable × dated

Every doc is one of two things, and this decides everything:

- **Durable** — describes what is **true now**. If it changes, **edit it in place**. (architecture, rules, integrations, runbooks)
- **Dated** — records what **happened at a moment**. It's **immutable**: you don't edit it, you **supersede** it (`status: superseded` + `superseded_by`). (cycles, incidents, analyses, ADRs)

Mixing the two is the root of drift: nobody can tell, looking at a file, whether it's the current truth or an old snapshot.

## Frontmatter (the machine contract)

```yaml
---
type: rule # architecture · vision · rule · integration · reference · runbook · spec · adr · incident · analysis · cycle · changelog · index
status: current # current · superseded (ADR: proposed/accepted; cycle: in_progress/done/parked)
updated: 2026-07-11 # last change to the FILE (incl. move/format)
reviewed: 2026-07-11 # last time content was CHECKED against code/prod and confirmed true (durable docs)
area: platform # domain, to scope agent context
superseded_by: ../x.md # required when status: superseded
---
```

`reviewed` ≠ `updated` is the anti-stale distinction: a move or a formatter bumps `updated` but must **not** bump `reviewed` — otherwise the freshness date lies. `reviewed` only moves when someone proves the content against the source.

## Cross-cutting rules

- **You own the doc.** The agent that writes the code owns the docs the change makes untrue — updating them is part of the task, not "later". The gate enforces it (`changelog-guard`).
- **The future lives in one place.** Intent checkboxes (`- [ ]`) belong only in cycle docs and `backlog.md`. In a durable doc, the future is a link to the backlog.
- **The index doesn't lie.** Every doc in an indexed area is linked from its neighbor README, and every link resolves (`docs-lint` checks this).
- **Changelog = per-cycle fragment, generated root.** Each cycle writes `docs/cycles/NN/changelog.md`; `pnpm changelog:collate` assembles `changelog.md`. Don't hand-edit the generated region.
