type LogLevel = "info" | "warn" | "error" | "debug"

export interface LogFields {
  /** Stable event slug — e.g. "webhook.received", "order.upserted". Always present. */
  event: string
  [key: string]: unknown
}

function emit(level: LogLevel, fields: LogFields): void {
  console[level](JSON.stringify({ level, ts: new Date().toISOString(), ...fields }))
}

// Structured logging only — never console.log a raw string. Every log has an `event`
// slug and business context (order_id, source, error_slug), so logs are queryable.
export const log = {
  info: (fields: LogFields) => emit("info", fields),
  warn: (fields: LogFields) => emit("warn", fields),
  error: (fields: LogFields) => emit("error", fields),
  debug: (fields: LogFields) => emit("debug", fields),
}
