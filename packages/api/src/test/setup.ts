import { beforeAll } from "vitest"
import { applyD1Migrations } from "cloudflare:test"
import { env } from "cloudflare:workers"

// Apply D1 migrations into the test database before tests run, so integration tests
// hit the REAL schema. vitest-pool-workers gives each test worker a real D1 instance
// (Miniflare) — this is how a seam test exercises the actual DB contract, not a mock.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.MIGRATIONS)
})
