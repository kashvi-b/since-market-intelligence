import { logReturn, toPct } from '../stats/robust.js'

export interface Decomposition {
  /** Log return of the stock over the user's window. */
  stockReturn: number | null
  /** Log return of the benchmark over the same window. */
  indexReturn: number | null
  beta: number | null
  /** beta * indexReturn — the part the market explains. */
  expected: number | null
  /** stockReturn - expected — the part it does not. This is what we rank on. */
  residual: number | null
  /** Residual expressed in robust sigmas, scaled to the window length. */
  residualZ: number | null
  /** Sigma actually used, after session scaling. */
  sigmaUsed: number | null
  stockPct: number | null
  expectedPct: number | null
  residualPct: number | null
}

/**
 * Split a move into the part the market explains and the part it does not.
 *
 * This is the central idea of the product. Everything in a watchlist falling 2%
 * because the index fell 2.5% is not forty pieces of news; it is one piece of
 * news about the index. Ranking on the residual is what lets Since say
 * "everything moved, nothing happened — except this one."
 *
 * Sigma is scaled by sqrt(sessions) because residuals accumulate like a random
 * walk: a 3-day window legitimately has more room to move than a 1-day window,
 * and not scaling would make every multi-day return look like an anomaly.
 */
export function decompose(params: {
  priceStart: number | null
  priceEnd: number | null
  indexStart: number | null
  indexEnd: number | null
  beta: number | null
  residMad: number | null
  sessions: number
}): Decomposition {
  const { priceStart, priceEnd, indexStart, indexEnd, beta, residMad } = params
  const sessions = Math.max(params.sessions, 1)

  const stockReturn = logReturn(priceStart, priceEnd)
  const indexReturn = logReturn(indexStart, indexEnd)

  const empty: Decomposition = {
    stockReturn, indexReturn, beta, expected: null, residual: null,
    residualZ: null, sigmaUsed: null,
    stockPct: toPct(stockReturn), expectedPct: null, residualPct: null,
  }

  if (stockReturn === null) return empty

  // With no benchmark or no fitted beta we fall back to the raw return. The
  // result is still usable, just less discriminating — and we say so upstream
  // by lowering the tier through a reduced sample size.
  if (indexReturn === null || beta === null || !Number.isFinite(beta)) {
    const sigma = residMad !== null && residMad > 0 ? residMad * Math.sqrt(sessions) : null
    return {
      ...empty,
      expected: 0,
      residual: stockReturn,
      residualZ: sigma ? stockReturn / sigma : null,
      sigmaUsed: sigma,
      expectedPct: 0,
      residualPct: toPct(stockReturn),
    }
  }

  const expected = beta * indexReturn
  const residual = stockReturn - expected
  const sigma = residMad !== null && residMad > 0 ? residMad * Math.sqrt(sessions) : null

  return {
    stockReturn, indexReturn, beta, expected, residual,
    residualZ: sigma ? residual / sigma : null,
    sigmaUsed: sigma,
    stockPct: toPct(stockReturn),
    expectedPct: toPct(expected),
    residualPct: toPct(residual),
  }
}
