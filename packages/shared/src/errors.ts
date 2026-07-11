// Error taxonomy: transient (retry) vs permanent (don't). The queue consumer and
// workflow steps use this to decide whether to re-drive an event or dead-letter it.
// A 500/timeout from an external API is transient; a 422/validation error is permanent.

export class TransientError extends Error {
  readonly slug: string
  constructor(message: string, slug = "transient") {
    super(message)
    this.name = "TransientError"
    this.slug = slug
  }
}

export class PermanentError extends Error {
  readonly slug: string
  constructor(message: string, slug = "permanent") {
    super(message)
    this.name = "PermanentError"
    this.slug = slug
  }
}

/** Retry only what's worth retrying. Unknown errors are treated as transient (fail-safe). */
export function isTransient(err: unknown): boolean {
  if (err instanceof PermanentError) return false
  if (err instanceof TransientError) return true
  return true
}
