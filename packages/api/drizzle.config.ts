import { defineConfig } from "drizzle-kit"

// Generates SQL migrations from src/db/schema.ts into ./drizzle.
// Generate: `pnpm --filter @rafoworks/api db:generate <name>`
// Apply:    `pnpm --filter @rafoworks/api db:migrate` (remote) / `:local`
export default defineConfig({
  dialect: "sqlite",
  driver: "d1-http",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
})
