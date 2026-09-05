import { winsorize, median } from './robust.js'

export interface BetaFit {
  beta: number
  /** Residuals of the fit, in the same order as the inputs. */
  residuals: number[]
  n: number
}

/**
 * OLS slope of `stock` on `index`, through the origin-adjusted means.
 *
 * Both series are winsorized first: a single mis-printed return can otherwise
 * rotate the regression line enough to make every subsequent residual wrong.
 * Alpha is estimated but deliberately NOT applied at scoring time — over a
 * few-hour window a fitted daily intercept is noise, and dropping it makes the
 * residual mean exactly "the part the market did not explain".
 */
export function fitBeta(stock: readonly number[], index: readonly number[]): BetaFit | null {
  const n = Math.min(stock.length, index.length)
  if (n < 20) return null

  const y = winsorize(stock.slice(-n))
  const x = winsorize(index.slice(-n))

  const mx = mean(x)
  const my = mean(y)

  let cov = 0
  let varx = 0
  for (let i = 0; i < n; i++) {
    const dx = x[i]! - mx
    cov += dx * (y[i]! - my)
    varx += dx * dx
  }
  if (varx === 0 || !Number.isFinite(varx)) return null

  const beta = cov / varx
  if (!Number.isFinite(beta)) return null

  // Residuals computed against the RAW series, not the winsorized one, so that
  // genuine outliers still show up as large residuals downstream.
  const residuals: number[] = []
  for (let i = 0; i < n; i++) residuals.push(stock[i]! - beta * index[i]!)

  return { beta, residuals, n }
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0
  let s = 0
  for (const x of xs) s += x
  return s / xs.length
}

export { median }
