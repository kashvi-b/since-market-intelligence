/**
 * Robust statistics.
 *
 * Everything here is median-based rather than mean-based, deliberately.
 * A single fat-finger print inflates a 60-day standard deviation enough to hide
 * every genuine signal for the next 60 sessions — the detector goes quiet and
 * nothing tells you it has. The median absolute deviation does not move.
 * See DECISIONS.md #4.
 */

/** Consistency constant making MAD an unbiased sigma estimator under normality. */
export const MAD_TO_SIGMA = 1.4826

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  if (s.length % 2 === 1) return s[mid]!
  return (s[mid - 1]! + s[mid]!) / 2
}

/** Robust scale estimate: 1.4826 * median(|x - median(x)|). */
export function mad(xs: readonly number[]): number {
  if (xs.length === 0) return NaN
  const m = median(xs)
  return MAD_TO_SIGMA * median(xs.map((x) => Math.abs(x - m)))
}

/** Linear-interpolated quantile of an UNSORTED sample. p in [0,1]. */
export function quantile(xs: readonly number[], p: number): number {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return quantileSorted(s, p)
}

/** Linear-interpolated quantile of an already-sorted sample. */
export function quantileSorted(sorted: readonly number[], p: number): number {
  const n = sorted.length
  if (n === 0) return NaN
  if (n === 1) return sorted[0]!
  const clamped = Math.min(1, Math.max(0, p))
  const pos = clamped * (n - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]!
  const frac = pos - lo
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac
}

/**
 * Clamp extreme values to a robust band instead of dropping them.
 * Used before fitting beta so one bad print cannot rotate the regression.
 */
export function winsorize(xs: readonly number[], k = 5): number[] {
  if (xs.length === 0) return []
  const m = median(xs)

  let scale = mad(xs)

  // Degenerate sample: when most values are identical the MAD collapses to zero
  // and a naive implementation would return the outlier untouched — exactly the
  // case winsorizing exists to handle. Fall back to the interquartile range.
  if (!Number.isFinite(scale) || scale === 0) {
    const iqr = quantile(xs, 0.75) - quantile(xs, 0.25)
    scale = iqr > 0 ? iqr / 1.349 : 0    // 1.349 = IQR/sigma under normality
  }

  // Still no dispersion at all: every value equals the median except the
  // outliers, so any deviation is by definition an outlier. Clamp to the median.
  if (!Number.isFinite(scale) || scale === 0) return xs.map(() => m)

  const lo = m - k * scale
  const hi = m + k * scale
  return xs.map((x) => Math.min(hi, Math.max(lo, x)))
}

export function clip(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo
  return Math.min(hi, Math.max(lo, x))
}

/** Natural log return. Returns null when either side is unusable. */
export function logReturn(from: number | null, to: number | null): number | null {
  if (from === null || to === null) return null
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null
  if (from <= 0 || to <= 0) return null
  return Math.log(to / from)
}

/** Convert a log return to a display percentage. */
export function toPct(logRet: number | null): number | null {
  if (logRet === null) return null
  return (Math.exp(logRet) - 1) * 100
}
