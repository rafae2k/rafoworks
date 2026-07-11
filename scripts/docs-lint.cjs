#!/usr/bin/env node
/**
 * docs-lint — enforces the checkable parts of the docs contract (see
 * docs/convencoes.md). Incremental: it ERRORS on migrated docs (those with
 * frontmatter) and only WARNS on docs still missing it, so rigor tightens as coverage
 * grows without blocking untouched files.
 *
 * Errors (block): invalid frontmatter type/status, superseded without a resolving
 * superseded_by, an intent checkbox in a durable doc, a broken relative link.
 * Warnings: a doc under docs/ with no frontmatter yet.
 *
 * Run: `pnpm docs:lint`. In the deploy-gate + the commit-touches-docs hook.
 */
const fs = require("fs")
const path = require("path")

const ROOT = path.join(__dirname, "..")
const DOCS = path.join(ROOT, "docs")

const VALID_TYPES = new Set([
  "architecture", "vision", "rule", "integration", "reference", "runbook",
  "spec", "adr", "incident", "analysis", "cycle", "changelog", "index",
])
const VALID_STATUS = new Set([
  "current", "superseded", "proposed", "accepted", "in_progress", "done", "parked",
])
// Durable doc types — a future-intent checkbox doesn't belong in these.
const DURABLE = new Set(["architecture", "vision", "rule", "integration", "reference", "runbook"])

const errors = []
const warnings = []

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const stat = fs.statSync(p)
    if (stat.isDirectory()) walk(p, out)
    else if (name.endsWith(".md")) out.push(p)
  }
  return out
}

function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) return null
  const end = text.indexOf("\n---", 4)
  if (end === -1) return null
  const block = text.slice(4, end)
  const fm = {}
  for (const line of block.split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/)
    if (m) fm[m[1]] = m[2].trim()
  }
  return fm
}

function checkLinks(file, text) {
  const dir = path.dirname(file)
  const re = /\[[^\]]*\]\(([^)]+)\)/g
  let m
  while ((m = re.exec(text))) {
    let target = m[1].trim()
    if (/^(https?:|mailto:|#|tel:)/.test(target)) continue
    target = target.split("#")[0]
    if (!target) continue
    const resolved = path.resolve(dir, target)
    if (!fs.existsSync(resolved)) {
      errors.push(`${path.relative(ROOT, file)}: broken link → ${m[1]}`)
    }
  }
}

for (const file of walk(DOCS)) {
  const rel = path.relative(ROOT, file)
  const text = fs.readFileSync(file, "utf8")
  checkLinks(file, text)

  const fm = parseFrontmatter(text)
  if (!fm) {
    // changelog.md is generated (collate) and root README is the human entry point.
    if (!/\/(changelog|README)\.md$/.test(rel)) warnings.push(`${rel}: no frontmatter yet`)
    continue
  }

  if (!fm.type || !VALID_TYPES.has(fm.type)) errors.push(`${rel}: invalid or missing type "${fm.type ?? ""}"`)
  if (!fm.status || !VALID_STATUS.has(fm.status)) errors.push(`${rel}: invalid or missing status "${fm.status ?? ""}"`)

  if (fm.status === "superseded") {
    if (!fm.superseded_by) errors.push(`${rel}: status superseded but no superseded_by`)
    else if (!fs.existsSync(path.resolve(path.dirname(file), fm.superseded_by)))
      errors.push(`${rel}: superseded_by does not resolve → ${fm.superseded_by}`)
  }

  if (fm.type && DURABLE.has(fm.type) && /^\s*-\s*\[[ x]\]/m.test(text)) {
    errors.push(`${rel}: intent checkbox in a durable doc (type ${fm.type}) — the future lives in backlog.md`)
  }
}

for (const w of warnings) process.stderr.write(`  ⚠ ${w}\n`)
if (errors.length) {
  process.stderr.write(`\n🚫 [docs-lint] ${errors.length} error(s):\n`)
  for (const e of errors) process.stderr.write(`  ✖ ${e}\n`)
  process.exit(1)
}
process.stderr.write(`[docs-lint] ok — ${warnings.length} warning(s).\n`)
process.exit(0)
