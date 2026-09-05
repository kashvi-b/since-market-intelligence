/** Domain types for Since. Pure data — no behaviour, no I/O. */

/** How much we trust a value at the moment we are about to reason about it. */
export type DataQuality =
  | 'FRESH'        // inside the freshness budget for this market session
  | 'DELAYED'      // older than fresh, still usable, must be labelled
  | 'STALE'        // too old to reason about — suppress rather than guess
  | 'UNAVAILABLE'  // no value at all
  | 'CONFLICTING'  // sources disagree beyond tolerance
  | 'SUSPECT'      // failed a sanity check (suspected corporate action / bad tick)

/** Tier is a property of the event. Budget (below) is a user filter on top. */
export type AttentionTier =
  | 'NORMAL' | 'WORTH_WATCHING' | 'SIGNIFICANT' | 'CRITICAL' | 'SUPPRESSED'

/** The user's own false-positive budget, expressed as a percentile threshold. */
export type AttentionBudget = 'LOW' | 'MEDIUM' | 'HIGH'

export type HypothesisId = 'MARKET' | 'SECTOR' | 'EVENT' | 'UNEXPLAINED' | 'DATA_ARTIFACT'

export interface DailyBar {
  date: string          // YYYY-MM-DD
  open: number
  high: number
  low: number
  close: number
  /** Corporate-action adjusted. Divergence from `close` is how we detect splits. */
  adjClose: number
  volume: number
}

export interface IntradayBar {
  ts: Date
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface Observation {
  price: number | null
  volume: number | null
  observedAt: Date
  receivedAt: Date
  source: string
}

/** Precomputed per-symbol rolling statistics. Shared by every user. */
export interface SymbolStats {
  symbolId: string
  asOf: string
  /** OLS slope of daily log returns against the benchmark, 60 trailing sessions. */
  beta: number | null
  /** Robust residual scale: 1.4826 * MAD. Never stdev — one bad tick kills stdev. */
  residMad: number | null
  residMedian: number | null
  volMedian20: number | null
  volMad20: number | null
  gapSigma: number | null
  high52w: number | null
  low52w: number | null
  /** Empirical CDF of the composite `raw` score: 101 quantiles, p0..p100. */
  pctlGrid: number[] | null
  sampleN: number
}

export interface SignalContribution {
  key: SignalKey
  label: string
  /** Normalised magnitude before weighting (z-score, or 1 for flat signals). */
  z: number
  weight: number
  /** weight * clip(z) — what actually entered `raw`. */
  points: number
  /** Human-readable, shown verbatim in the WHY panel. */
  detail: string
}

export type SignalKey =
  | 'residual' | 'volume' | 'gap' | 'crossing52w' | 'userThreshold' | 'event' | 'cumulative'

export interface QualityAssessment {
  quality: DataQuality
  reason: string
  /** Age of the value in milliseconds at evaluation time. */
  ageMs: number | null
  sources: string[]
}

/** Everything needed to score one symbol for one user over one window. */
export interface ScoreInput {
  symbolId: string
  windowStart: Date
  windowEnd: Date
  /** Price the user actually last saw. Left-hand side of the diff. */
  priceStart: number | null
  priceEnd: number | null
  indexStart: number | null
  indexEnd: number | null
  volume: number | null
  /** Previous session close, for the overnight gap signal. */
  prevClose: number | null
  sessionOpen: number | null
  stats: SymbolStats | null
  quality: QualityAssessment
  /** Number of trading sessions spanned — scales the residual sigma. */
  sessions: number
  /** Per-session residuals inside the window, for the persistence signal. */
  sessionResiduals?: number[] | undefined
  userThreshold?: { kind: 'ABOVE' | 'BELOW'; value: number } | undefined
  /**
   * How to render a price in explanation text. Supplied by the caller because
   * core must not guess a currency: the threshold signal used to print a rupee
   * sign and Indian digit grouping onto US prices.
   */
  money?: { currency: string; locale: string } | undefined
  hasEventInWindow?: boolean
  eventHeadline?: string | undefined
}

export interface ScoreResult {
  symbolId: string
  raw: number
  /** Calibrated percentile of `raw` against this symbol's own history. 0-100. */
  pctl: number
  tier: AttentionTier
  contributions: SignalContribution[]
  quality: DataQuality
  qualityReason: string
  returnPct: number | null
  /** Market-implied return over the window, given beta. */
  expectedPct: number | null
  residualPct: number | null
  residualZ: number | null
  /** Set when scoring could not be completed and why. */
  degraded: string | null
}
