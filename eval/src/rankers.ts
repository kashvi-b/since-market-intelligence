import {
  computeSignals, DEFAULT_WEIGHTS, fitBeta, mad, median, logReturn,
  buildPercentileGrid, percentileOf, clip,
  type ScoreInput, type SymbolStats, type QualityAssessment,
} from '@since/core'

const CLEAN: QualityAssessment = { quality: 'FRESH', reason: 'Historical', ageMs: 0, sources: ['history'] }

export interface Candidate {
  symbolId: string
  /** Percentage return over the decision window. */
  returnPct: number
  /** Absolute move per share, in the market's own currency. */
  priceMove: number
  /** Our composite, produced by the PRODUCTION signal code. */
  composite: number
  /** Calibrated percentile of the composite. */
  pctl: number | null
}

export type Ranker = (candidates: readonly Candidate[]) => Candidate[]

/** Baseline 1: what almost every watchlist does. */
export const byAbsolutePercent: Ranker = (c) =>
  [...c].sort((a, b) => Math.abs(b.returnPct) - Math.abs(a.returnPct) || a.symbolId.localeCompare(b.symbolId))

/** Baseline 2: rank by the size of the move in currency terms. */
export const byPriceMove: Ranker = (c) =>
  [...c].sort((a, b) => Math.abs(b.priceMove) - Math.abs(a.priceMove) || a.symbolId.localeCompare(b.symbolId))

/** Ours: market-adjusted surprise, volume, gap and crossings, calibrated. */
export const bySinceComposite: Ranker = (c) =>
  [...c].sort((a, b) => b.composite - a.composite || a.symbolId.localeCompare(b.symbolId))

/**
 * Ablation: residual only, no other signals. Included so the README can say
 * which part of the model is doing the work rather than just that it works.
 */
export const byResidualOnly = (residualZ: Map<string, number>): Ranker => (c) =>
  [...c].sort((a, b) =>
    Math.abs(residualZ.get(b.symbolId) ?? 0) - Math.abs(residualZ.get(a.symbolId) ?? 0)
    || a.symbolId.localeCompare(b.symbolId))

export const RANKERS: { id: string; label: string; make: (ctx: RankCtx) => Ranker }[] = [
  { id: 'abs-percent', label: 'Absolute % change (baseline)', make: () => byAbsolutePercent },
  { id: 'price-move', label: 'Absolute price move (baseline)', make: () => byPriceMove },
  { id: 'residual-only', label: 'Market-adjusted residual only (ablation)', make: (ctx) => byResidualOnly(ctx.residualZ) },
  { id: 'since', label: 'Since composite', make: () => bySinceComposite },
]

export interface RankCtx { residualZ: Map<string, number> }

export {
  computeSignals, DEFAULT_WEIGHTS, fitBeta, mad, median, logReturn,
  buildPercentileGrid, percentileOf, clip,
}
export type { ScoreInput, SymbolStats }
export { CLEAN }
