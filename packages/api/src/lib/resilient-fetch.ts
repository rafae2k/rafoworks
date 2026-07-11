import { TransientError } from "@rafoworks/shared"

export interface ResilientFetchOptions extends RequestInit {
  timeoutMs?: number
  /** Slug prefix for error classification (e.g. "example"). */
  slug?: string
}

/**
 * fetch with a timeout, classifying only TRANSPORT-level failures: network errors,
 * timeouts, and 5xx ⟹ TransientError (worth retrying). It returns the Response for
 * everything else (2xx AND 4xx), because a 4xx's meaning is domain-specific — a 404
 * might mean "return null", a 409 "already exists". The caller (adapter) decides,
 * throwing PermanentError where a 4xx really is unrecoverable. A queue/workflow
 * boundary uses this transient-vs-permanent split to choose retry vs dead-letter.
 */
export async function resilientFetch(url: string, opts: ResilientFetchOptions = {}): Promise<Response> {
  const { timeoutMs = 10_000, slug = "fetch", ...init } = opts
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: controller.signal })
  } catch (err) {
    throw new TransientError(`${slug}: ${err instanceof Error ? err.message : String(err)}`, `${slug}_network`)
  } finally {
    clearTimeout(timer)
  }
  if (res.status >= 500) {
    throw new TransientError(`${slug}: upstream ${res.status}`, `${slug}_5xx`)
  }
  return res
}
