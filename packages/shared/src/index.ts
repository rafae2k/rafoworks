// Barrel export for @rafoworks/shared — the domain: entities, ports, pure rules,
// events, error taxonomy. No runtime dependencies, no I/O. Adapters implement the
// ports; the api and mcp workers consume this as source (see tsconfig note).

export * from "./entities.js"
export * from "./errors.js"

// Port interfaces (the "plug shapes" adapters implement)
export * from "./ports/order-source.js"
export * from "./ports/webhook.js"

// Business rules (pure functions — the part worth unit-testing hardest)
export * from "./rules/order-status.js"

// Domain event transport
export * from "./events/envelope.js"
