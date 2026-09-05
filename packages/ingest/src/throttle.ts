/**
 * Request pacing for an unofficial, rate-limited upstream.
 *
 * Yahoo returns HTTP 429 under burst load — discovered the hard way by firing
 * 51 requests at it. The response is not to give up on real data but to behave
 * like a good client: serialise requests, keep a minimum gap between them, and
 * back off exponentially when told to.
 */
export class Throttle {
  private chain: Promise<unknown> = Promise.resolve()
  private lastAt = 0

  constructor(private readonly minGapMs: number) {}

  /** Run `fn` after the minimum gap, serialised against every other caller. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(async () => {
      const wait = Math.max(0, this.minGapMs - (Date.now() - this.lastAt))
      if (wait > 0) await sleep(wait)
      this.lastAt = Date.now()
      return fn()
    })
    // Keep the chain alive even when a link rejects.
    this.chain = result.then(() => undefined, () => undefined)
    return result
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function isRateLimit(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /429|too many requests|rate limit/i.test(msg)
}

/** Retry with exponential backoff and jitter, but only for retryable failures. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number; label?: string } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 4
  const baseMs = opts.baseMs ?? 2000
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i === attempts - 1) break
      const retryable = isRateLimit(err) || /timeout|ECONN|socket|network/i.test(String(err))
      if (!retryable) break
      const delay = baseMs * 2 ** i + Math.random() * 500
      if (opts.label) console.log(`[ingest]   ${opts.label}: retry ${i + 1}/${attempts - 1} in ${Math.round(delay)}ms`)
      await sleep(delay)
    }
  }
  throw lastErr
}
