#!/usr/bin/env node
/**
 * Deploy gate — blocks a deploy unless typecheck + lint + build + test + docs +
 * changelog are all green. Also blocks a COMMIT that touches docs/ if docs-lint fails
 * (keeps the shared tree's docs structurally valid, catching doc errors at commit
 * time, not only at deploy).
 *
 * Two modes:
 *   1. Hook mode (default): used as a Claude Code PreToolUse hook. Reads the hook JSON
 *      on stdin, detects a `wrangler deploy` (or `pnpm deploy*`), and — if it is one —
 *      runs the checks. A failing check emits a `deny` decision that STOPS the deploy.
 *      Non-deploy commands pass through (no-op).
 *   2. Manual mode (`--check`): runs the checks and exits 0 (ok) / 1 (failed).
 *      Run locally: `node scripts/deploy-gate.cjs --check` (aliased to `pnpm gate`).
 *
 * Why it exists: `wrangler deploy` uses esbuild and does NOT run tsc/eslint/vitest.
 * Without this gate, a deploy can ship code that breaks typecheck/lint/test.
 */

const { execSync } = require("child_process")
const path = require("path")

const ROOT = path.join(__dirname, "..")

// Checks in increasing cost order (fail fast on the cheapest).
const CHECKS = [
  { name: "changelog", cmd: "node scripts/changelog-guard.cjs" },
  { name: "changelog-sync", cmd: "node scripts/changelog-collate.cjs --check" },
  { name: "typecheck", cmd: "pnpm -r typecheck" },
  { name: "lint", cmd: "pnpm lint" },
  { name: "build", cmd: "pnpm build" },
  { name: "test", cmd: "pnpm test" },
  { name: "docs", cmd: "pnpm docs:lint" },
]

function runCheck(check) {
  try {
    execSync(check.cmd, { cwd: ROOT, encoding: "utf8", stdio: "pipe", timeout: 300_000 })
    return { ok: true, output: "" }
  } catch (err) {
    const out = `${err.stdout || ""}\n${err.stderr || ""}`.trim()
    return { ok: false, output: out }
  }
}

function runAllChecks(log) {
  for (const check of CHECKS) {
    if (log) process.stderr.write(`[deploy-gate] ${check.name}... `)
    const result = runCheck(check)
    if (log) process.stderr.write(result.ok ? "ok\n" : "FAILED\n")
    if (!result.ok) return { check, output: result.output }
  }
  return null
}

function isDeployCommand(cmd) {
  if (!cmd || typeof cmd !== "string") return false
  if (/--dry-run/.test(cmd)) return false // dry-run ships nothing
  if (/\bwrangler\s+deploy\b/.test(cmd)) return true
  if (/\bpnpm\b[^\n|&;]*\bdeploy(:api|:mcp)?\b/.test(cmd)) return true
  return false
}

function isCommitCommand(cmd) {
  return typeof cmd === "string" && /\bgit\s+commit\b/.test(cmd)
}

function stagedTouchesDocs() {
  try {
    const out = execSync("git diff --cached --name-only", { cwd: ROOT, encoding: "utf8", stdio: "pipe" })
    return out.split("\n").some((f) => f.startsWith("docs/"))
  } catch {
    return false
  }
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  )
  process.exit(0)
}

function allowPassthrough() {
  process.exit(0)
}

function manualMode() {
  process.stderr.write(`[deploy-gate] running checks: ${CHECKS.map((c) => c.name).join(", ")}...\n`)
  const failure = runAllChecks(true)
  if (failure) {
    process.stderr.write(`\n[deploy-gate] BLOCKED: '${failure.check.cmd}' failed.\n\n`)
    process.stderr.write(failure.output.slice(-4000) + "\n")
    process.exit(1)
  }
  process.stderr.write("[deploy-gate] all green — deploy allowed.\n")
  process.exit(0)
}

function hookMode() {
  let raw = ""
  try {
    raw = require("fs").readFileSync(0, "utf8")
  } catch {
    allowPassthrough()
  }

  let payload = {}
  try {
    payload = JSON.parse(raw || "{}")
  } catch {
    allowPassthrough()
  }

  const cmd = payload?.tool_input?.command ?? ""

  if (isCommitCommand(cmd)) {
    if (stagedTouchesDocs()) {
      const result = runCheck({ name: "docs", cmd: "pnpm docs:lint" })
      if (!result.ok) {
        deny(
          "🚫 Commit blocked: it touches docs/ and `docs:lint` failed.\n\n" +
            "Fix the docs structure (frontmatter/link/type) and recommit. Manual: `pnpm docs:lint`.\n\n" +
            "--- docs-lint (tail) ---\n" +
            result.output.slice(-2000),
        )
      }
    }
    allowPassthrough()
    return
  }

  if (!isDeployCommand(cmd)) {
    allowPassthrough()
    return
  }

  const failure = runAllChecks(false)
  if (failure) {
    const tail = failure.output.slice(-2500)
    deny(
      `🚫 Deploy blocked by the deploy-gate: check \`${failure.check.cmd}\` failed.\n\n` +
        `Fix the cause below, then redeploy. Do NOT route around the gate.\n\n` +
        `--- output of \`${failure.check.cmd}\` (tail) ---\n${tail}`,
    )
  }
  allowPassthrough()
}

if (process.argv.includes("--check")) {
  manualMode()
} else {
  hookMode()
}
