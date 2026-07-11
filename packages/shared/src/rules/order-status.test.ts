import { describe, it, expect } from "vitest"
import { canTransition, isTerminal, normalizeSourceStatus } from "./order-status.js"

describe("canTransition", () => {
  it("allows valid forward transitions", () => {
    expect(canTransition("pending", "paid")).toBe(true)
    expect(canTransition("paid", "fulfilled")).toBe(true)
    expect(canTransition("fulfilled", "delivered")).toBe(true)
  })

  it("allows cancelling from pending and paid", () => {
    expect(canTransition("pending", "cancelled")).toBe(true)
    expect(canTransition("paid", "cancelled")).toBe(true)
  })

  it("rejects skipping states", () => {
    expect(canTransition("pending", "fulfilled")).toBe(false)
    expect(canTransition("pending", "delivered")).toBe(false)
  })

  it("rejects moving backwards", () => {
    expect(canTransition("paid", "pending")).toBe(false)
    expect(canTransition("delivered", "fulfilled")).toBe(false)
  })

  it("rejects any transition out of a terminal status", () => {
    expect(canTransition("delivered", "paid")).toBe(false)
    expect(canTransition("cancelled", "paid")).toBe(false)
  })
})

describe("isTerminal", () => {
  it("marks delivered and cancelled as terminal", () => {
    expect(isTerminal("delivered")).toBe(true)
    expect(isTerminal("cancelled")).toBe(true)
  })

  it("marks in-flight states as non-terminal", () => {
    expect(isTerminal("pending")).toBe(false)
    expect(isTerminal("paid")).toBe(false)
    expect(isTerminal("fulfilled")).toBe(false)
  })
})

describe("normalizeSourceStatus", () => {
  it("maps every known vendor synonym to our vocabulary", () => {
    expect(normalizeSourceStatus("pending")).toBe("pending")
    expect(normalizeSourceStatus("created")).toBe("pending")
    expect(normalizeSourceStatus("waiting_payment")).toBe("pending")
    expect(normalizeSourceStatus("paid")).toBe("paid")
    expect(normalizeSourceStatus("APPROVED")).toBe("paid")
    expect(normalizeSourceStatus("confirmed")).toBe("paid")
    expect(normalizeSourceStatus("fulfilled")).toBe("fulfilled")
    expect(normalizeSourceStatus("shipped")).toBe("fulfilled")
    expect(normalizeSourceStatus("in_transit")).toBe("fulfilled")
    expect(normalizeSourceStatus("delivered")).toBe("delivered")
    expect(normalizeSourceStatus(" Completed ")).toBe("delivered")
    expect(normalizeSourceStatus("cancelled")).toBe("cancelled")
    expect(normalizeSourceStatus("canceled")).toBe("cancelled")
    expect(normalizeSourceStatus("refunded")).toBe("cancelled")
  })

  it("returns null for unknown statuses instead of guessing", () => {
    expect(normalizeSourceStatus("frobnicated")).toBeNull()
    expect(normalizeSourceStatus("")).toBeNull()
  })
})
