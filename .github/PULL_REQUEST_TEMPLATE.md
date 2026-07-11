<!-- Keep it focused. A boilerplate grows by staying legible. -->

## What & why

<!-- What does this change, and what problem does it solve? In plain language. -->

## Checklist

- [ ] `pnpm gate` is green (typecheck + lint + build + test + docs + changelog)
- [ ] New behavior at a boundary has a seam test with the real component
- [ ] Changed business logic (rules/core services) keeps mutation green (`pnpm mutation`) — surviving mutants killed, not thresholds lowered
- [ ] Docs the change makes untrue are updated in this PR (you own the doc)
- [ ] Change stays generic — no vendor names in the domain or UI
