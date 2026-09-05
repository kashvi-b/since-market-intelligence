import type { ScoreInput, ScoreResult, SignalContribution } from '../types.js'
import { decompose } from '../market/decompose.js'
import { computeSignals, DEFAULT_WEIGHTS, type Weights } from '../signals/index.js'
import { percentileOf } from './calibrate.js'
import { tierFor } from './tier.js'
import { suppresses } from '../quality/gate.js'
import { toPct } from '../stats/robust.js'

export interface ScoreOptions {
  weights?: Weights
  /** Fallback grid for symbols without enough history of their own. */
  fallbackGrid?: readonly number[] | null
}

/**
 * Score one symbol for one user over one window.
 *
 * Pure: same inputs always produce the same output. No clock, no database, no
 * network, no LLM. This is the function the evaluation harness measures and the
 * API serves — there is exactly one implementation of it.
 *
 * ORDER MATTERS. The quality gate runs before scoring, not after. Scoring bad
 * data and then hiding the result still means the statistics saw it.
 */
export function scoreChange(input: ScoreInput, opts: ScoreOptions = {}): ScoreResult {
  const weights = opts.weights ?? DEFAULT_WEIGHTS
  const quality = input.quality.quality

  const d = decompose({
    priceStart: input.priceStart,
    priceEnd: input.priceEnd,
    indexStart: input.indexStart,
    indexEnd: input.indexEnd,
    beta: input.stats?.beta ?? null,
    residMad: input.stats?.residMad ?? null,
    sessions: input.sessions,
  })

  const base = {
    symbolId: input.symbolId,
    quality,
    qualityReason: input.quality.reason,
    returnPct: d.stockPct,
    expectedPct: d.expectedPct,
    residualPct: d.residualPct,
    residualZ: d.residualZ,
  }

  // Degrade, don't lie. Unreliable data never produces an alert — and it never
  // produces a *score* either, so nothing downstream can accidentally rank it.
  if (suppresses(quality)) {
    return {
      ...base,
      raw: 0,
      pctl: 0,
      tier: 'SUPPRESSED',
      contributions: [],
      degraded: `Suppressed: ${input.quality.reason}`,
    }
  }

  const contributions: SignalContribution[] = computeSignals(input, d, weights)
  const raw = contributions.reduce((sum, c) => sum + c.points, 0)

  const ownGrid = input.stats?.pctlGrid ?? null
  const grid = ownGrid ?? opts.fallbackGrid ?? null
  const pctl = percentileOf(grid, raw)

  const degraded =
    ownGrid === null && grid !== null ? 'Limited baseline — calibrated against peers'
    : grid === null ? 'Limited baseline — no calibration available'
    : null

  return {
    ...base,
    raw,
    pctl: pctl ?? 0,
    tier: tierFor(pctl, quality),
    contributions,
    degraded,
  }
}

/** Display helper: the score as a whole number, the way the UI shows it. */
export function displayScore(r: ScoreResult): number {
  return Math.round(r.pctl)
}

export { toPct }
