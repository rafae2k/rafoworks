import { describe, expect, it } from "vitest"
import { getWorkflowsForEvent } from "./event-router.js"
import type { Env } from "../lib/types.js"

// A fake env — getWorkflowsForEvent only reads which binding to return, never calls it.
const env = { ORDER_WORKFLOW: {} as Workflow } as Env

describe("getWorkflowsForEvent", () => {
  it("routes order.* events to the order-sync workflow", () => {
    expect(getWorkflowsForEvent(env, "order.paid").map((r) => r.name)).toEqual(["order-sync"])
    expect(getWorkflowsForEvent(env, "order.synced").map((r) => r.name)).toEqual(["order-sync"])
  })

  it("returns no route for unrelated events", () => {
    expect(getWorkflowsForEvent(env, "customer.created")).toEqual([])
    expect(getWorkflowsForEvent(env, "unknown")).toEqual([])
  })
})
