import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Only packages that carry tests. mcp is thin RPC glue, covered by typecheck.
    projects: ["packages/shared", "packages/api"],
  },
})
