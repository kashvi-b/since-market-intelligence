import type { DataQuality, QualityAssessment } from '../types.js'

/** Freshness budgets. Deliberately generous — the point is to never lie, not to nag. */
export const FRESH_MS_OPEN = 120_000          // 2 min while the market is open
export const DELAYED_MS_OPEN = 15 * 60_000    // 15 min, still usable if labelled
export const FRESH_AFTER_CLOSE_MS = 30 * 60_000
export const DELAYED_AFTER_CLOSE_MS = 36 * 60 * 60_000

/** Two sources disagreeing by more than this are treated as conflicting. */
export const CONFLICT_TOLERANCE_PCT = 0.5

export interface SourceValue {
  source: string
  price: number | null
  observedAt: Date | null
}

/**
 * Assess how much we trust a price, BEFORE any scoring happens.
 *
 * Freshness is relative to the market, not the wall clock. At 9pm a price from
 * 15:30 is the closing price and perfectly fresh; the same age at 11am means the
 * feed has stopped. Treating those identically is the classic way a watchlist
 * ends up screaming about nothing at midnight.
 */
export function assessFreshness(params: {
  observedAt: Date | null
  evaluatedAt: Date
  marketIsOpen: boolean
  lastSessionCloseAt: Date | null
}): { quality: DataQuality; reason: string; ageMs: number | null } {
  const { observedAt, evaluatedAt, marketIsOpen, lastSessionCloseAt } = params

  if (observedAt === null) {
    return { quality: 'UNAVAILABLE', reason: 'No observation for this symbol', ageMs: null }
  }

  const ageMs = evaluatedAt.getTime() - observedAt.getTime()

  // A value stamped in the future means clock skew or a bad feed. Do not trust it.
  if (ageMs < -60_000) {
    return { quality: 'SUSPECT', reason: 'Observation timestamped in the future', ageMs }
  }

  if (marketIsOpen) {
    if (ageMs <= FRESH_MS_OPEN) return { quality: 'FRESH', reason: 'Live', ageMs }
    if (ageMs <= DELAYED_MS_OPEN) return { quality: 'DELAYED', reason: 'Feed lagging', ageMs }
    return { quality: 'STALE', reason: 'No update while the market is open', ageMs }
  }

  if (lastSessionCloseAt !== null) {
    const sinceClose = lastSessionCloseAt.getTime() - observedAt.getTime()
    if (sinceClose <= FRESH_AFTER_CLOSE_MS) {
      return { quality: 'FRESH', reason: 'Closing price', ageMs }
    }
  }
  if (ageMs <= DELAYED_AFTER_CLOSE_MS) {
    return { quality: 'DELAYED', reason: 'Market closed', ageMs }
  }
  return { quality: 'STALE', reason: 'Older than the last session', ageMs }
}

/** Detect disagreement between providers. We show the conflict; we never average it away. */
export function assessConflict(
  values: readonly SourceValue[],
  tolerancePct = CONFLICT_TOLERANCE_PCT,
): { conflicting: boolean; reason: string; chosen: SourceValue | null } {
  const usable = values.filter((v): v is SourceValue & { price: number } =>
    v.price !== null && Number.isFinite(v.price) && v.price > 0)

  if (usable.length === 0) return { conflicting: false, reason: 'No values', chosen: null }
  if (usable.length === 1) return { conflicting: false, reason: 'Single source', chosen: usable[0]! }

  let lo = usable[0]!.price
  let hi = usable[0]!.price
  for (const v of usable) {
    if (v.price < lo) lo = v.price
    if (v.price > hi) hi = v.price
  }
  const spreadPct = ((hi - lo) / lo) * 100

  // Deterministic source selection: freshest wins, ties broken by source name so
  // the same inputs always produce the same choice.
  const chosen = [...usable].sort((a, b) => {
    const at = a.observedAt?.getTime() ?? 0
    const bt = b.observedAt?.getTime() ?? 0
    if (bt !== at) return bt - at
    return a.source.localeCompare(b.source)
  })[0]!

  if (spreadPct > tolerancePct) {
    return {
      conflicting: true,
      reason: `Sources disagree by ${spreadPct.toFixed(2)}% (tolerance ${tolerancePct}%)`,
      chosen,
    }
  }
  return { conflicting: false, reason: `Sources agree within ${spreadPct.toFixed(2)}%`, chosen }
}

/** Quality states that must never produce an attention alert. */
export const SUPPRESSING: ReadonlySet<DataQuality> =
  new Set<DataQuality>(['STALE', 'UNAVAILABLE', 'CONFLICTING', 'SUSPECT'])

export function suppresses(q: DataQuality): boolean {
  return SUPPRESSING.has(q)
}

export function combine(
  freshness: { quality: DataQuality; reason: string; ageMs: number | null },
  conflict: { conflicting: boolean; reason: string },
  sanity: { suspect: boolean; reason: string },
  sources: string[],
): QualityAssessment {
  // Order matters: a suspect value is worse than a stale one, because a stale
  // value is merely old whereas a suspect value is actively wrong.
  if (sanity.suspect) {
    return { quality: 'SUSPECT', reason: sanity.reason, ageMs: freshness.ageMs, sources }
  }
  if (conflict.conflicting) {
    return { quality: 'CONFLICTING', reason: conflict.reason, ageMs: freshness.ageMs, sources }
  }
  return { quality: freshness.quality, reason: freshness.reason, ageMs: freshness.ageMs, sources }
}
