#!/usr/bin/env node
// A loose tripwire for files that have grown too big to reason about. Not in the gate
// — run `pnpm check:sizes` when you want the signal. Complexity (eslint) is the real
// guard; this just flags monster files worth splitting.
const fs = require("fs")
const path = require("path")

const MAX_LINES = parseInt(process.argv[2]) || 400
const IGNORE_PATTERNS = [".test.ts", ".spec.ts", ".d.ts"]

const PROJECTS = [
  { name: "SHARED", path: path.join(__dirname, "../packages/shared/src") },
  { name: "API", path: path.join(__dirname, "../packages/api/src") },
  { name: "MCP", path: path.join(__dirname, "../packages/mcp/src") },
]

const colors = { reset: "\x1b[0m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", bold: "\x1b[1m" }

function countLines(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").split("\n").length
  } catch {
    return 0
  }
}

function shouldIgnore(fileName) {
  return IGNORE_PATTERNS.some((p) => fileName.endsWith(p))
}

function scanDirectory(dir, fileList = []) {
  if (!fs.existsSync(dir)) return fileList
  for (const file of fs.readdirSync(dir)) {
    const filePath = path.join(dir, file)
    const stat = fs.statSync(filePath)
    if (stat.isDirectory()) {
      scanDirectory(filePath, fileList)
    } else if (/\.(ts|tsx|js|jsx)$/.test(file) && !shouldIgnore(file)) {
      const lines = countLines(filePath)
      if (lines > MAX_LINES) fileList.push({ path: filePath, lines })
    }
  }
  return fileList
}

console.log(`${colors.bold}Checking for files larger than ${MAX_LINES} lines...${colors.reset}\n`)

let totalIssues = 0
for (const project of PROJECTS) {
  const largeFiles = scanDirectory(project.path).sort((a, b) => b.lines - a.lines)
  console.log(`${colors.cyan}${colors.bold}[ ${project.name} ]${colors.reset}`)
  if (largeFiles.length === 0) {
    console.log(`${colors.green}  All files under ${MAX_LINES} lines.${colors.reset}`)
  } else {
    for (const file of largeFiles) {
      const rel = path.relative(path.join(__dirname, ".."), file.path)
      const color = file.lines > MAX_LINES * 1.5 ? colors.red : colors.yellow
      console.log(`  ${color}${file.lines.toString().padEnd(5)}${colors.reset} lines  ${rel}`)
    }
    totalIssues += largeFiles.length
  }
  console.log("")
}

console.log(`${colors.bold}--------------------------------------------------${colors.reset}`)
if (totalIssues === 0) {
  console.log(`${colors.green}${colors.bold}All clear! No large files detected.${colors.reset}`)
} else {
  console.log(`${colors.yellow}${colors.bold}Total: ${totalIssues} files over ${MAX_LINES} lines${colors.reset}`)
  process.exit(1)
}
