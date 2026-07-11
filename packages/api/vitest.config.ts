import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers"
import { defineConfig } from "vitest/config"
import fs from "node:fs"
import path from "node:path"

// Read D1 migrations so tests run against the real schema (applied per test worker
// in src/test/setup.ts). Guarded so the config still loads before the first
// migration is generated (`pnpm --filter @rafoworks/api db:generate init`).
const migrationsPath = path.join(import.meta.dirname, "drizzle")
const migrations = fs.existsSync(migrationsPath) ? await readD1Migrations(migrationsPath) : []

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.toml" },
      miniflare: {
        bindings: {
          ENVIRONMENT: "test",
          EXAMPLE_API_TOKEN: "test-example-token",
          EXAMPLE_WEBHOOK_TOKEN: "test-webhook-token",
          MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    name: "api",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test/setup.ts"],
    // Integration tests boot a worker in miniflare (cold-start). 30s gives the full
    // suite headroom; isolated tests still run in well under 2s.
    hookTimeout: 30_000,
    testTimeout: 30_000,
    coverage: {
      // v8 coverage doesn't work inside the Workers runtime (no node:inspector).
      // istanbul works with pool-workers.
      provider: "istanbul",
      reporter: ["text", "html", "lcov"],
      reportsDirectory: "../../coverage/api",
      include: ["src/**/*.ts"],
      exclude: ["**/*.d.ts", "**/index.ts", "**/types.ts", "**/*.test.ts", "src/test/**"],
    },
  },
})
