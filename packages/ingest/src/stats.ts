import {
  fitBeta, mad, median, logReturn, buildPercentileGrid, computeSignals,
  detectSuspectBar, DEFAULT_WEIGHTS,
  type DailyBar, type SymbolStats, type ScoreInput, type QualityAssessment,
} from '@since/core'

export const BETA_WINDOW = 60
export const VOL_WINDOW = 20
export const GRID_WINDOW = 250
export const MIN_HISTORY = 80

const CLEAN: QualityAssessment = { quality: 'FRESH', reason: 'Historical bar', ageMs: 0, sources: ['history'] }

export interface QuarantinedBar {
  date: string
  reason: string
  impliedRatio?: number | undefined
  /** What the raw close implies — the move we would have wrongly reported. */
  apparentMovePct: number
}

export interface StatsResult {
  stats: SymbolStats
  /** Dates whose bars failed sanity checks and were excluded from every estimate. */
  quarantined: QuarantinedBar[]
}

/**
 * Compute the rolling statistics one symbol needs to be scored.
 *
 * Two properties matter here and both are deliberate:
 *
 *  1. Everything is CAUSAL. The beta used to score day i is fitted only on days
 *     before i. The calibration grid is built the same way. Without this the
 *     percentiles would carry lookahead and the evaluation numbers would be
 *     flattering nonsense.
 *
 *  2. Bars that fail sanity checks are excluded from every estimate, not merely
 *     hidden from the UI. A split left in the sample inflates the residual scale
 *     enough to blind the symbol for the next sixty sessions.
 */
export function computeSymbolStats(params: {
  symbolId: string
  bars: readonly DailyBar[]
  indexBars: readonly DailyBar[]
  corporateActionDates?: ReadonlySet<string>
}): StatsResult | null {
  const { symbolId, bars, indexBars } = params
  const actionDates = params.corporateActionDates ?? new Set<string>()

  const indexByDate = new Map(indexBars.map((b) => [b.date, b]))
  const aligned = bars.filter((b) => indexByDate.has(b.date)).sort((a, b) => a.date.localeCompare(b.date))
  if (aligned.length < MIN_HISTORY) return null

  // --- sanity pass: quarantine artefacts before they reach any estimator -----
  const quarantined: QuarantinedBar[] = []
  const clean: DailyBar[] = []
  for (let i = 0; i < aligned.length; i++) {
    const bar = aligned[i]!
    const prev = aligned[i - 1]
    if (!prev) { clean.push(bar); continue }
    const idx = indexByDate.get(bar.date)!
    const prevIdx = indexByDate.get(prev.date)
    const verdict = detectSuspectBar({
      close: bar.close, prevClose: prev.close,
      adjClose: bar.adjClose, prevAdjClose: prev.adjClose,
      indexReturn: prevIdx ? logReturn(prevIdx.adjClose, idx.adjClose) : null,
      knownCorporateAction: actionDates.has(bar.date),
    })
    if (verdict.suspect) {
      quarantined.push({
        date: bar.date,
        reason: verdict.reason,
        impliedRatio: verdict.impliedRatio,
        apparentMovePct: prev.close > 0 ? (bar.close / prev.close - 1) * 100 : 0,
      })
    }
    else clean.push(bar)
  }
  if (clean.length < MIN_HISTORY) return null

  // --- returns, always on the ADJUSTED series -------------------------------
  const stockRet: number[] = []
  const indexRet: number[] = []
  const dates: string[] = []
  for (let i = 1; i < clean.length; i++) {
    const a = clean[i - 1]!
    const b = clean[i]!
    const ia = indexByDate.get(a.date)
    const ib = indexByDate.get(b.date)
    const sr = logReturn(a.adjClose, b.adjClose)
    const ir = ia && ib ? logReturn(ia.adjClose, ib.adjClose) : null
    if (sr === null || ir === null) continue
    stockRet.push(sr)
    indexRet.push(ir)
    dates.push(b.date)
  }
  if (stockRet.length < BETA_WINDOW) return null

  const fit = fitBeta(stockRet.slice(-BETA_WINDOW), indexRet.slice(-BETA_WINDOW))
  const residuals = fit?.residuals ?? stockRet.slice(-BETA_WINDOW)
  const residMad = mad(residuals)

  const recent = clean.slice(-VOL_WINDOW)
  const volumes = recent.map((b) => b.volume).filter((v) => v > 0)
  const volMedian20 = volumes.length ? median(volumes) : null
  // volMad20 is the MAD of LOG volumes — volume is lognormal, and a linear MAD
  // makes an ordinary busy day look like a 6-sigma event. The scoring engine
  // divides log(volume / median) by this. A floor of 0.25 keeps a symbol with
  // freakishly steady volume from turning every tick into an anomaly.
  const logVolMad = volumes.length ? mad(volumes.map((v) => Math.log(v))) : null
  const volMad20 = logVolMad && logVolMad > 0.25 ? logVolMad : volumes.length ? 0.25 : null

  const gaps: number[] = []
  for (let i = 1; i < clean.length; i++) {
    const g = logReturn(clean[i - 1]!.adjClose, clean[i]!.open)
    if (g !== null) gaps.push(g)
  }
  const gapMad = gaps.length >= 30 ? mad(gaps) : null

  const yearBars = clean.slice(-GRID_WINDOW)
  const high52w = yearBars.length ? Math.max(...yearBars.map((b) => b.high)) : null
  const low52w = yearBars.length ? Math.min(...yearBars.map((b) => b.low)) : null

  const base: SymbolStats = {
    symbolId,
    asOf: clean[clean.length - 1]!.date,
    beta: fit?.beta ?? null,
    residMad: Number.isFinite(residMad) && residMad > 0 ? residMad : null,
    residMedian: median(residuals),
    volMedian20,
    volMad20,
    gapSigma: gapMad && gapMad > 0 ? gapMad : null,
    high52w,
    low52w,
    pctlGrid: null,
    sampleN: clean.length,
  }

  base.pctlGrid = buildCausalGrid({ symbolId, clean, indexByDate, stockRet, indexRet, dates, base })
  return { stats: base, quarantined }
}

/**
 * Build the empirical distribution of this symbol's composite score.
 *
 * Each historical day is scored with THE PRODUCTION SIGNAL CODE — the same
 * `computeSignals` the API calls — using only data available before that day.
 * That is what makes "97th percentile" a statement about this stock rather than
 * a number we chose.
 */
function buildCausalGrid(p: {
  symbolId: string
  clean: readonly DailyBar[]
  indexByDate: Map<string, DailyBar>
  stockRet: readonly number[]
  indexRet: readonly number[]
  dates: readonly string[]
  base: SymbolStats
}): number[] | null {
  const { clean, indexByDate, stockRet, indexRet, dates, base } = p
  const byDate = new Map(clean.map((b) => [b.date, b]))
  const raws: number[] = []

  const start = Math.max(BETA_WINDOW, stockRet.length - GRID_WINDOW)
  for (let i = start; i < stockRet.length; i++) {
    const date = dates[i]!
    const bar = byDate.get(date)
    if (!bar) continue
    const prevDate = dates[i - 1]
    const prevBar = prevDate ? byDate.get(prevDate) : undefined
    const idx = indexByDate.get(date)
    const prevIdx = prevDate ? indexByDate.get(prevDate) : undefined
    if (!prevBar || !idx || !prevIdx) continue

    // Point-in-time estimates: strictly the window BEFORE day i.
    const trailingStock = stockRet.slice(Math.max(0, i - BETA_WINDOW), i)
    const trailingIndex = indexRet.slice(Math.max(0, i - BETA_WINDOW), i)
    if (trailingStock.length < 30) continue
    const fit = fitBeta(trailingStock, trailingIndex)
    const resid = fit?.residuals ?? trailingStock
    const rmad = mad(resid)
    if (!Number.isFinite(rmad) || rmad <= 0) continue

    const trailingVols = clean
      .filter((b) => b.date < date)
      .slice(-VOL_WINDOW)
      .map((b) => b.volume)
      .filter((v) => v > 0)
    const vMed = trailingVols.length ? median(trailingVols) : null
    const vLogMad = trailingVols.length ? mad(trailingVols.map((v) => Math.log(v))) : null
    const vMadRaw = vLogMad && vLogMad > 0.25 ? vLogMad : trailingVols.length ? 0.25 : null

    const input: ScoreInput = {
      symbolId: p.symbolId,
      windowStart: new Date(`${prevDate}T10:00:00Z`),
      windowEnd: new Date(`${date}T10:00:00Z`),
      priceStart: prevBar.adjClose, priceEnd: bar.adjClose,
      indexStart: prevIdx.adjClose, indexEnd: idx.adjClose,
      volume: bar.volume, prevClose: prevBar.adjClose, sessionOpen: bar.open,
      stats: {
        ...base,
        beta: fit?.beta ?? null,
        residMad: rmad,
        volMedian20: vMed,
        volMad20: vMadRaw,
        // 52-week levels are excluded from the grid: a crossing is a discrete
        // event, and including it would make the baseline lumpy for no gain.
        high52w: null, low52w: null,
        pctlGrid: null,
      },
      quality: CLEAN,
      sessions: 1,
    }

    const d = {
      stockReturn: stockRet[i]!,
      indexReturn: indexRet[i]!,
      beta: fit?.beta ?? null,
      expected: (fit?.beta ?? 0) * indexRet[i]!,
      residual: stockRet[i]! - (fit?.beta ?? 0) * indexRet[i]!,
      residualZ: (stockRet[i]! - (fit?.beta ?? 0) * indexRet[i]!) / rmad,
      sigmaUsed: rmad,
      stockPct: null, expectedPct: null, residualPct: null,
    }

    raws.push(computeSignals(input, d, DEFAULT_WEIGHTS).reduce((s, c) => s + c.points, 0))
  }

  return buildPercentileGrid(raws)
}

/** Grid used for symbols without enough history of their own. */
export function buildFallbackGrid(allGrids: readonly (number[] | null)[]): number[] | null {
  const usable = allGrids.filter((g): g is number[] => g !== null && g.length > 0)
  if (usable.length === 0) return null
  const size = usable[0]!.length
  const out: number[] = []
  for (let i = 0; i < size; i++) out.push(median(usable.map((g) => g[i] ?? 0)))
  return out
}
