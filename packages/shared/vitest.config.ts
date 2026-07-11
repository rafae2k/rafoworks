import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    name: "shared",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "../../coverage/shared",
      include: ["src/**/*.ts"],
      exclude: ["**/*.d.ts", "**/index.ts", "**/*.test.ts"],
    },
  },
})
