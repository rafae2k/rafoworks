#!/usr/bin/env node
/**
 * changelog-guard — couples a CODE change to a changelog entry.
 *
 * The rule that stops docs rotting from silent deploys: no deploy ships a code change
 * (`packages/<pkg>/src`, excluding tests) without `docs/changelog.md` (or a cycle
 * fragment) being updated too. "Shipped ⟹ recorded." It's the structural net for the
 * real problem: an agent/dev changes code and forgets the doc.
 *
 * Runs in the deploy-gate. Deterministic, git-only. Exits 0 (ok) / 1 (block).
 *
 * Checks:
 *   1. COMMITTED — did any code file change BETWEEN the last commit that touched a
 *      changelog and HEAD? Code committed after the last record = shipped without an
 *      entry → fail. (ungameable: it's git history)
 *   2. UNCOMMITTED — is there dirty code in the working tree (which `wrangler deploy`
 *      bundles) without the changelog also dirty? About to deploy unrecorded → fail.
 *
 * Escape hatch (a change with genuinely no observable impact — pure internal refactor,
 * dep bump, comment fix): SKIP_CHANGELOG_GATE=1. It's logged. Forces the DECISION
 * ("does this change prod behavior?"), never a silent skip.
 */
const { execSync } = require("child_process")
const path = require("path")

const ROOT = path.join(__dirname, "..")
const CHANGELOG = "docs/changelog.md"

function git(args) {
  try {
    return execSync(`git ${args}`, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return ""
  }
}

// code = packages/<pkg>/src/**, except tests
const isCode = (f) => /^packages\/[^/]+\/src\//.test(f) && !/\.(test|spec)\.[cm]?[tj]sx?$/.test(f)
// "changelog touched" = root OR a cycle fragment (docs/cycles/NN/changelog.md)
const isChangelog = (f) => f === CHANGELOG || /^docs\/cycles\/[^/]+\/changelog\.md$/.test(f)

if (process.env.SKIP_CHANGELOG_GATE === "1") {
  process.stderr.write("[changelog-guard] SKIP_CHANGELOG_GATE=1 — check skipped (assumed: no doc impact).\n")
  process.exit(0)
}

// 1. COMMITTED: did code change since the last commit that touched a changelog?
const clSha = git(`log -1 --format=%H -- ${CHANGELOG} "docs/cycles/*/changelog.md"`)
let committedCode = []
if (clSha) {
  committedCode = git(`diff --name-only ${clSha} HEAD -- packages`).split("\n").filter(Boolean).filter(isCode)
}

// 2. UNCOMMITTED: dirty code without the changelog also dirty?
const dirty = git("status --porcelain")
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    const p = l.slice(3)
    return p.includes(" -> ") ? p.split(" -> ")[1] : p // rename → destination
  })
const dirtyCode = dirty.filter(isCode)
const changelogDirty = dirty.some(isChangelog)

const problems = []
if (committedCode.length) problems.push({ kind: "committed after the last changelog record", files: committedCode })
if (dirtyCode.length && !changelogDirty) problems.push({ kind: "in the working tree, with no changelog entry", files: dirtyCode })

if (!problems.length) {
  process.stderr.write("[changelog-guard] ok — code and changelog coupled.\n")
  process.exit(0)
}

const sample = (fs) => fs.slice(0, 10).map((f) => "     " + f).join("\n") + (fs.length > 10 ? `\n     … +${fs.length - 10}` : "")
let msg =
  "🚫 Code changed with no changelog entry.\n\n" +
  "Every behavior change that ships to prod needs one line in docs/changelog.md.\n"
for (const p of problems) msg += `\n  [${p.kind}]\n${sample(p.files)}\n`
msg +=
  `\nFix: write the cycle fragment in docs/cycles/NN/changelog.md (\`- YYYY-MM-DD — what changes\`),` +
  ` run \`pnpm changelog:collate\`, and redeploy.` +
  `\nIf the change does NOT alter observable behavior (internal refactor, dep bump): SKIP_CHANGELOG_GATE=1.`
process.stderr.write("[changelog-guard] " + msg + "\n")
process.exit(1)
