import { quantileSorted } from '../stats/robust.js'

/** Number of quantiles stored per symbol: p0 .. p100 inclusive. */
export const GRID_SIZE = 101

/**
 * Build the empirical CDF of a symbol's historical composite scores.
 *
 * This is what gives the attention score a unit. Without it, "91" is an
 * arbitrary weighted sum and the first question a reviewer asks — "why 91 and
 * not 85?" — has no answer. With it, 91 means "a day this notable happens to
 * this stock about 9% of the time", which is a statement about the world.
 */
export function buildPercentileGrid(historicalRaw: readonly number[]): number[] | null {
  const usable = historicalRaw.filter((x) => Number.isFinite(x))
  if (usable.length < 30) return null
  const sorted = [...usable].sort((a, b) => a - b)
  const grid: number[] = []
  for (let i = 0; i < GRID_SIZE; i++) grid.push(quantileSorted(sorted, i / (GRID_SIZE - 1)))
  return grid
}

/**
 * Where does `raw` sit in this symbol's own history? Returns 0..100.
 * Linear interpolation between grid points; saturates at the ends.
 */
export function percentileOf(grid: readonly number[] | null, raw: number): number | null {
  if (!grid || grid.length < 2) return null
  if (!Number.isFinite(raw)) return null

  if (raw <= grid[0]!) return 0
  const last = grid.length - 1
  if (raw >= grid[last]!) return 100

  let lo = 0
  let hi = last
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (grid[mid]! <= raw) lo = mid
    else hi = mid
  }
  const span = grid[hi]! - grid[lo]!
  const frac = span > 0 ? (raw - grid[lo]!) / span : 0
  return ((lo + frac) / last) * 100
}

/**
 * How often does a day at this percentile occur? Used verbatim in the UI, so
 * that the score reads as a frequency rather than a rating.
 */
export function frequencyPhrase(pctl: number, sessionsPerYear = 250): string {
  if (pctl >= 99.95) return 'the most extreme day in its recorded history'
  const p = Math.min(99.99, Math.max(0, pctl))
  const perYear = ((100 - p) / 100) * sessionsPerYear
  if (perYear >= 60) return 'an ordinary day for this stock'
  if (perYear >= 1) return `about ${Math.round(perYear)} days a year`
  const perDecade = perYear * 10
  if (perDecade >= 1) return `about ${Math.round(perDecade)} days a decade`
  return 'rarer than once a decade'
}

/**
 * How the score is written down.
 *
 * A saturated percentile is displayed as "99+" rather than "100": the grid says
 * this is the most extreme value it has on record, which is a statement about
 * our sample, not a claim of certainty about the world.
 */
export function displayPercentile(pctl: number): { text: string; saturated: boolean } {
  if (pctl >= 99.95) return { text: '99+', saturated: true }
  if (pctl >= 99) return { text: pctl.toFixed(1), saturated: false }
  return { text: String(Math.round(pctl)), saturated: false }
}
