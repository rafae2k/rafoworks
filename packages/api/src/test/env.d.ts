import type { Env as WorkerEnv } from "../lib/types.js"
import type { D1Migration } from "cloudflare:test"

// `env` from cloudflare:test / cloudflare:workers is typed as `Cloudflare.Env`.
// Augment that global with our bindings + the injected migrations list, so tests see
// a fully-typed env without running `wrangler types`.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      MIGRATIONS: D1Migration[]
    }
  }
}
