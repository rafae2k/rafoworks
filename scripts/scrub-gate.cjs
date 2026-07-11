#!/usr/bin/env node
/**
 * scrub-gate — since this is a PUBLIC boilerplate derived from a private production
 * platform, this scan fails if any private identifier leaks in: the origin company /
 * platform names, vendor names that would signal copied domain code, the production
 * domain, or hardcoded production resource ids. Instrument, don't trust.
 *
 * Run: `pnpm scrub`. Scans git-tracked text files. Exits 1 on any hit.
 * If you legitimately need one of these words (docs example), add a narrow allowance
 * below — don't widen the pattern.
 */
const { execSync } = require("child_process")
const path = require("path")
const fs = require("fs")

const ROOT = path.join(__dirname, "..")

// Private identifiers that must never appear in the public repo. Case-insensitive.
const FORBIDDEN = [
  "nuture",
  "nutool",
  "pagbrasil",
  "pagstream",
  "stokki",
  "klaviyo",
  "\\bcrisp\\b",
  "yampi",
  "digitalmanager",
  "nuture\\.com\\.br",
  // hardcoded production resource ids (D1 / KV) — never ship real ones
  "5138a95a",
  "f375574f9b994c1188856561db357347",
]
const RE = new RegExp(`(${FORBIDDEN.join("|")})`, "i")

// Files that legitimately contain the words (this scanner itself).
const SKIP = new Set(["scripts/scrub-gate.cjs"])

function trackedFiles() {
  return execSync("git ls-files", { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((f) => !SKIP.has(f))
    .filter((f) => !/\.(png|jpg|jpeg|gif|webp|ico|lock|woff2?)$/i.test(f))
    .filter((f) => f !== "pnpm-lock.yaml")
}

const hits = []
for (const f of trackedFiles()) {
  const abs = path.join(ROOT, f)
  let content
  try {
    content = fs.readFileSync(abs, "utf8")
  } catch {
    continue
  }
  content.split("\n").forEach((line, i) => {
    const m = line.match(RE)
    if (m) hits.push({ file: f, line: i + 1, token: m[1] })
  })
}

if (hits.length === 0) {
  process.stderr.write("[scrub] clean — no private identifiers found.\n")
  process.exit(0)
}

process.stderr.write(`🚫 [scrub] ${hits.length} private identifier(s) found — must not ship in a public repo:\n\n`)
for (const h of hits.slice(0, 50)) {
  process.stderr.write(`  ${h.file}:${h.line}  →  "${h.token}"\n`)
}
if (hits.length > 50) process.stderr.write(`  … +${hits.length - 50} more\n`)
process.exit(1)
