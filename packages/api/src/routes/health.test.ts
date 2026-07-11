import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"
import worker from "../index.js"

// Integration test through the real worker fetch handler — boots the middleware and
// route the way a request actually hits them.
describe("GET /health", () => {
  it("returns ok", async () => {
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
    const res = await worker.fetch(new Request("https://rafoworks.test/health"), env, ctx)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; environment: string }
    expect(body.status).toBe("ok")
    expect(body.environment).toBe("test")
  })
})
