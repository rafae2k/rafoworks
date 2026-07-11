#!/usr/bin/env node
/**
 * changelog-collate — assembles the per-cycle changelog fragments into the root.
 *
 * News-fragments pattern (towncrier / changesets): each cycle writes its own file at
 * docs/cycles/NN/changelog.md — one line per change reaching prod:
 *   - YYYY-MM-DD — what changes
 * This script collates ALL fragments into the GENERATED REGION of docs/changelog.md
 * (between <!-- collate:start --> and <!-- collate:end -->), reverse-chronological,
 * each line linked to its cycle.
 *
 * Why: conflict-free writes (one file per cycle, no merge conflicts across parallel
 * cycles) + narrative reads (the root is generated, not a wall of links). Fragments
 * stay in the cycle (document-in-cycle); the root is a projection of them.
 *
 * Usage:
 *   node scripts/changelog-collate.cjs          # regenerate the root
 *   node scripts/changelog-collate.cjs --check   # exit 1 if the root is out of sync
 */
const fs = require("fs")
const path = require("path")

const ROOT = path.resolve(__dirname, "..")
const CYCLES = path.join(ROOT, "docs", "cycles")
const ROOT_CHANGELOG = path.join(ROOT, "docs", "changelog.md")
const START = "<!-- collate:start -->"
const END = "<!-- collate:end -->"

// fragment entry: "- YYYY-MM-DD — text" (accepts —, – or - as the separator)
const ENTRY_RE = /^-\s+(\d{4}-\d{2}-\d{2})\s*[—–-]\s*(.+?)\s*$/

function collectEntries() {
  const entries = []
  if (!fs.existsSync(CYCLES)) return entries
  for (const dir of fs.readdirSync(CYCLES, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const frag = path.join(CYCLES, dir.name, "changelog.md")
    if (!fs.existsSync(frag)) continue
    const m = dir.name.match(/^(\d+)-/)
    const num = m ? parseInt(m[1], 10) : 0
    for (const line of fs.readFileSync(frag, "utf8").split("\n")) {
      const e = line.match(ENTRY_RE)
      if (e) entries.push({ date: e[1], text: e[2].trim(), num, slug: dir.name })
    }
  }
  // reverse-chron; date tie: higher cycle number first
  entries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.num - a.num))
  return entries
}

function blockLines(entries) {
  if (!entries.length) return ["_(no fragments yet — each cycle writes its own in docs/cycles/NN/changelog.md)_"]
  const out = []
  let curDate = null
  for (const e of entries) {
    if (e.date !== curDate) {
      out.push(`## ${e.date}`)
      curDate = e.date
    }
    const label = e.num ? `**Cycle ${e.num}**` : "**—**"
    out.push(`- ${label} — ${e.text} ([cycle](cycles/${e.slug}/))`)
  }
  return out
}

function regionOf(text) {
  const s = text.indexOf(START)
  const e = text.indexOf(END)
  if (s === -1 || e === -1 || e < s) throw new Error(`markers ${START} / ${END} missing in docs/changelog.md`)
  return { s, e, inner: text.slice(s + START.length, e) }
}

const entries = collectEntries()
const lines = blockLines(entries)
const current = fs.readFileSync(ROOT_CHANGELOG, "utf8")
const { s, e, inner } = regionOf(current)

// prettier-robust comparison: non-empty trimmed lines only
const norm = (t) =>
  t
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
const inSync = JSON.stringify(norm(inner)) === JSON.stringify(lines)

if (process.argv.includes("--check")) {
  if (!inSync) {
    process.stderr.write(
      "[changelog-collate] docs/changelog.md out of sync with the cycle fragments.\n" +
        "Run: pnpm changelog:collate — and commit the result.\n",
    )
    process.exit(1)
  }
  process.stderr.write("[changelog-collate] ok — root in sync with fragments.\n")
  process.exit(0)
}

if (inSync) {
  process.stderr.write("[changelog-collate] nothing to do — already in sync.\n")
  process.exit(0)
}
const next = current.slice(0, s + START.length) + "\n\n" + lines.join("\n") + "\n\n" + current.slice(e)
fs.writeFileSync(ROOT_CHANGELOG, next)
process.stderr.write(
  `[changelog-collate] root regenerated (${entries.length} entr${entries.length === 1 ? "y" : "ies"} from ${new Set(entries.map((x) => x.slug)).size} fragment(s)).\n`,
)
