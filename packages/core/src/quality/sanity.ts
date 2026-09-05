/**
 * Sanity checks that run at ingestion and again before scoring.
 *
 * The single most damaging bug a watchlist can have is treating a 1:2 stock
 * split as a real -50% move. It fires the loudest false alert the system is
 * capable of, and then the outlier poisons the rolling statistics so the symbol
 * is effectively blind for the next sixty sessions.
 */

/** A move beyond this, unexplained by the market, is not credible as real news. */
export const IMPLAUSIBLE_LOG_MOVE = 0.35        // ~ -30% / +42%
/** Divergence between raw and adjusted close ratios that implies a corporate action. */
export const ADJ_DIVERGENCE = 0.02

export interface SuspectResult {
  suspect: boolean
  reason: string
  /** Present when we can name the corporate action ratio implied by the data. */
  impliedRatio?: number
}

/**
 * Decide whether a session's move is real, or an artefact.
 *
 * The trick is that `close` is as-traded and `adjClose` is corporate-action
 * adjusted. On an ordinary day their ratios agree. Across a split they diverge
 * by exactly the split ratio — which is a fact in the data, not a guess.
 */
export function detectSuspectBar(params: {
  close: number
  prevClose: number
  adjClose: number
  prevAdjClose: number
  /** Benchmark log return for the same session, when known. */
  indexReturn?: number | null
  /** Set when a corporate action is already known for this date. */
  knownCorporateAction?: boolean
}): SuspectResult {
  const { close, prevClose, adjClose, prevAdjClose, knownCorporateAction } = params

  if (!(close > 0 && prevClose > 0 && adjClose > 0 && prevAdjClose > 0)) {
    return { suspect: true, reason: 'Non-positive price in bar' }
  }

  const rawRet = Math.log(close / prevClose)
  const adjRet = Math.log(adjClose / prevAdjClose)
  const divergence = Math.abs(rawRet - adjRet)

  if (divergence > ADJ_DIVERGENCE) {
    return {
      suspect: true,
      reason: 'Raw and adjusted closes diverge — corporate action, not a price move',
      impliedRatio: Math.exp(rawRet - adjRet),
    }
  }

  if (knownCorporateAction) {
    return { suspect: true, reason: 'Known corporate action on this date' }
  }

  const idx = params.indexReturn ?? 0
  if (Math.abs(rawRet) > IMPLAUSIBLE_LOG_MOVE && Math.abs(rawRet - idx) > IMPLAUSIBLE_LOG_MOVE) {
    return {
      suspect: true,
      reason: `Implausible single-session move (${((Math.exp(rawRet) - 1) * 100).toFixed(1)}%) unexplained by the market`,
    }
  }

  return { suspect: false, reason: 'Passes sanity checks' }
}

/** A tick that arrives older than one we already have must never overwrite it. */
export function isOutOfOrder(incomingObservedAt: Date, latestObservedAt: Date | null): boolean {
  if (latestObservedAt === null) return false
  return incomingObservedAt.getTime() < latestObservedAt.getTime()
}

/** Reject a tick that is wildly off the recent band before it reaches the stats. */
export function isBadTick(price: number, recentMedian: number | null, recentMad: number | null): boolean {
  if (recentMedian === null || recentMad === null || recentMad <= 0) return false
  return Math.abs(price - recentMedian) > 10 * recentMad
}
