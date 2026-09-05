/**
 * Offline evaluation harness.
 *
 * The claim Since makes is that market-adjusted surprise identifies changes
 * worth your attention better than the percentage change every other watchlist
 * ranks by. This measures that claim instead of asserting it.
 *
 * Three properties make the number worth reading:
 *
 *   1. It runs THE PRODUCTION CODE. `computeSignals` is imported from
 *      @since/core — the same function the API calls. There is no second
 *      scoring implementation to drift.
 *   2. It is causal. Beta, residual scale and volume baselines at date t are
 *      fitted only on data before t, and the calibration grids come from a
 *      disjoint earlier period. No ranker can see its own answer.
 *   3. The label is a documented proxy, and three of them are reported. A
 *      result that only survives one definition of "meaningful" is not a result.
 *
 *   npm run eval
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { sql, marketQueries as q } from '@since/db'
import {
  computeSignals, DEFAULT_WEIGHTS, fitBeta, mad, median, logReturn,
  buildPercentileGrid, percentileOf,
  type ScoreInput, type SymbolStats, type DailyBar,
} from '@since/core'
import { LABELS, isMeaningful } from './labels.js'
import { RANKERS, CLEAN, type Candidate } from './rankers.js'

/**
 * Which dataset to evaluate.
 *
 *   npm run eval                  the product universe (NSE)
 *   npm run eval -- --universe us real US market data
 *
 * The second exists because free NSE feeds are gated behind paid plans, and a
 * scoring model measured only against data this repo generated proves nothing
 * about markets. Same code, same labels, real prices.
 */
const args = process.argv.slice(2)
const uniIdx = args.indexOf('--universe')
// npm strips unrecognised long flags before they reach the script, so accept a
// bare positional too: `npm run eval -- us` and `--universe us` both work.
const UNIVERSE_NAME =
  (uniIdx >= 0 && args[uniIdx + 1]) ? args[uniIdx + 1]!
  : args.find((a) => a === 'us' || a === 'nifty50') ?? 'nifty50'
const BENCHMARK = UNIVERSE_NAME === 'us' ? 'SPY' : '^NSEI'
const BETA_WINDOW = 60
const VOL_WINDOW = 20
const TOP_K = 3
/** Fraction of history reserved for calibration; the rest is evaluated. */
const CALIBRATION_SPLIT = 0.6
/** Percentile thresholds the product ships, for the alert-volume report. */
const BUDGETS = { LOW: 99, MEDIUM: 95, HIGH: 90 } as const

interface Series {
  symbolId: string
  dates: string[]
  bars: DailyBar[]
  ret: number[]          // log returns, index-aligned with dates[1..]
  idxRet: number[]
}

async function main(): Promise<void> {
  const t0 = Date.now()
  console.log('[eval] loading market data from local Postgres…')

  const wantSuffix = UNIVERSE_NAME === 'us'
  const symbols = (await q.symbolsWithSectors())
    .filter((s) => !s.isIndex && s.status === 'ACTIVE' && !s.id.startsWith('__meta__'))
    // The two universes share a database; select by id shape.
    .filter((s) => (wantSuffix ? !s.id.endsWith('.NS') : s.id.endsWith('.NS')))
  const indexBars = await q.dailyBarsBetween(BENCHMARK, '1900-01-01', '2999-12-31')
  const indexByDate = new Map(indexBars.map((b) => [b.date, b]))
  if (indexBars.length < 200) {
    throw new Error(
      `Not enough history for benchmark ${BENCHMARK}. ` +
      `Run: npm run ingest -- --universe ${UNIVERSE_NAME}`,
    )
  }

  const series: Series[] = []
  for (const s of symbols) {
    const bars = (await q.dailyBarsBetween(s.id, '1900-01-01', '2999-12-31'))
      .filter((b) => indexByDate.has(b.date))
    if (bars.length < 200) continue
    const dates: string[] = []
    const ret: number[] = []
    const idxRet: number[] = []
    for (let i = 1; i < bars.length; i++) {
      const r = logReturn(bars[i - 1]!.adjClose, bars[i]!.adjClose)
      const ia = indexByDate.get(bars[i - 1]!.date)!
      const ib = indexByDate.get(bars[i]!.date)!
      const ir = logReturn(ia.adjClose, ib.adjClose)
      if (r === null || ir === null) continue
      dates.push(bars[i]!.date)
      ret.push(r)
      idxRet.push(ir)
    }
    series.push({ symbolId: s.id, dates, bars, ret, idxRet })
  }

  const n = Math.min(...series.map((s) => s.ret.length))
  const calEnd = Math.floor(n * CALIBRATION_SPLIT)
  const evalStart = Math.max(calEnd, BETA_WINDOW + VOL_WINDOW)
  console.log(`[eval] ${series.length} symbols, ${n} aligned sessions`)
  console.log(`[eval] calibration 0..${calEnd}, evaluation ${evalStart}..${n - 1} (disjoint)`)

  // --- pass 1: causal per-day features, for every symbol and every day -------
  interface Day { composite: number; residZ: number; returnPct: number; priceMove: number; residSigma: number }
  const feature = new Map<string, Day[]>()

  for (const s of series) {
    const days: Day[] = []
    for (let i = 0; i < s.ret.length; i++) {
      if (i < BETA_WINDOW) { days.push(empty()); continue }

      // Everything below uses ONLY indices strictly less than i.
      const fit = fitBeta(s.ret.slice(i - BETA_WINDOW, i), s.idxRet.slice(i - BETA_WINDOW, i))
      const resid = fit?.residuals ?? s.ret.slice(i - BETA_WINDOW, i)
      const sigma = mad(resid)
      if (!Number.isFinite(sigma) || sigma <= 0) { days.push(empty()); continue }

      const beta = fit?.beta ?? 1
      const residual = s.ret[i]! - beta * s.idxRet[i]!
      const residZ = residual / sigma

      const barIdx = i + 1                       // ret[i] is the move into bars[i+1]
      const bar = s.bars[barIdx]
      const prevBar = s.bars[barIdx - 1]
      if (!bar || !prevBar) { days.push(empty()); continue }

      const trailingVols = s.bars.slice(Math.max(0, barIdx - VOL_WINDOW), barIdx)
        .map((b) => b.volume).filter((v) => v > 0)
      const vMed = trailingVols.length ? median(trailingVols) : null
      const vLogMad = trailingVols.length ? mad(trailingVols.map((v) => Math.log(v))) : null

      const stats: SymbolStats = {
        symbolId: s.symbolId, asOf: s.dates[i]!,
        beta, residMad: sigma, residMedian: median(resid),
        volMedian20: vMed,
        volMad20: vLogMad && vLogMad > 0.25 ? vLogMad : 0.25,
        gapSigma: null, high52w: null, low52w: null, pctlGrid: null,
        sampleN: BETA_WINDOW,
      }

      const input: ScoreInput = {
        symbolId: s.symbolId,
        windowStart: new Date(`${s.dates[i - 1] ?? s.dates[i]}T10:00:00Z`),
        windowEnd: new Date(`${s.dates[i]}T10:00:00Z`),
        priceStart: prevBar.adjClose, priceEnd: bar.adjClose,
        indexStart: 1, indexEnd: 1,          // decomposition is supplied below
        volume: bar.volume, prevClose: prevBar.adjClose, sessionOpen: bar.open,
        stats, quality: CLEAN, sessions: 1,
      }

      // PRODUCTION signal code — the whole point of the harness.
      const contributions = computeSignals(input, {
        stockReturn: s.ret[i]!, indexReturn: s.idxRet[i]!, beta,
        expected: beta * s.idxRet[i]!, residual, residualZ: residZ,
        sigmaUsed: sigma, stockPct: null, expectedPct: null, residualPct: null,
      }, DEFAULT_WEIGHTS)

      days.push({
        composite: contributions.reduce((a, c) => a + c.points, 0),
        residZ,
        returnPct: (Math.exp(s.ret[i]!) - 1) * 100,
        priceMove: Math.abs(bar.adjClose - prevBar.adjClose),
        residSigma: sigma,
      })
    }
    feature.set(s.symbolId, days)
  }

  // --- calibration grids, from the disjoint earlier period only -------------
  const grids = new Map<string, number[] | null>()
  for (const s of series) {
    const days = feature.get(s.symbolId)!
    const raws = days.slice(BETA_WINDOW, calEnd).map((d) => d.composite).filter((x) => x > 0 || x === 0)
    grids.set(s.symbolId, buildPercentileGrid(raws))
  }

  // --- pass 2: rank each evaluation day and score against every label -------
  const results: Record<string, Record<string, { hits: number; total: number }>> = {}
  for (const r of RANKERS) {
    results[r.id] = {}
    for (const l of LABELS) results[r.id]![l.id] = { hits: 0, total: 0 }
  }
  const alertCounts: Record<keyof typeof BUDGETS, number[]> = { LOW: [], MEDIUM: [], HIGH: [] }
  // Per budget: did each fired alert turn out to be meaningful, and how many
  // meaningful events did that threshold miss? This is the operating point the
  // user actually chooses, so it is the thing worth measuring.
  const budgetHits: Record<keyof typeof BUDGETS, { fired: number; correct: number; missed: number }> =
    { LOW: { fired: 0, correct: 0, missed: 0 },
      MEDIUM: { fired: 0, correct: 0, missed: 0 },
      HIGH: { fired: 0, correct: 0, missed: 0 } }
  let evaluatedDays = 0

  const maxHorizon = Math.max(...LABELS.map((l) => l.horizon))

  for (let i = evalStart; i < n - maxHorizon; i++) {
    const candidates: Candidate[] = []
    const residualZ = new Map<string, number>()
    const perBudget: Record<keyof typeof BUDGETS, number> = { LOW: 0, MEDIUM: 0, HIGH: 0 }

    for (const s of series) {
      const d = feature.get(s.symbolId)![i]
      if (!d || !Number.isFinite(d.composite)) continue
      const pctl = percentileOf(grids.get(s.symbolId) ?? null, d.composite)
      candidates.push({
        symbolId: s.symbolId, returnPct: d.returnPct,
        priceMove: d.priceMove, composite: pctl ?? d.composite, pctl,
      })
      residualZ.set(s.symbolId, d.residZ)
      if (pctl !== null) {
        for (const b of Object.keys(BUDGETS) as (keyof typeof BUDGETS)[]) {
          if (pctl >= BUDGETS[b]) perBudget[b]++
        }
      }
    }
    if (candidates.length < TOP_K) continue
    evaluatedDays++
    for (const b of Object.keys(BUDGETS) as (keyof typeof BUDGETS)[]) alertCounts[b].push(perBudget[b])

    for (const label of LABELS) {
      const meaningful = new Set<string>()
      for (const s of series) {
        const days = feature.get(s.symbolId)!
        const forward: number[] = []
        for (let h = 1; h <= label.horizon; h++) {
          const f = days[i + h]
          if (f) forward.push(f.residZ * f.residSigma)
        }
        const sigma = days[i]?.residSigma ?? 0
        if (isMeaningful(forward, sigma, label)) meaningful.add(s.symbolId)
      }

      for (const r of RANKERS) {
        const ranked = r.make({ residualZ })(candidates).slice(0, TOP_K)
        const cell = results[r.id]![label.id]!
        cell.total += ranked.length
        cell.hits += ranked.filter((c) => meaningful.has(c.symbolId)).length
      }

      // Budget performance is measured against the PRIMARY label only —
      // reporting it three ways would imply a precision we cannot pick between.
      if (label.id === LABELS[0]!.id) {
        for (const b of Object.keys(BUDGETS) as (keyof typeof BUDGETS)[]) {
          const fired = candidates.filter((c) => c.pctl !== null && c.pctl >= BUDGETS[b])
          const firedIds = new Set(fired.map((c) => c.symbolId))
          budgetHits[b].fired += fired.length
          budgetHits[b].correct += fired.filter((c) => meaningful.has(c.symbolId)).length
          budgetHits[b].missed += [...meaningful].filter((id) => !firedIds.has(id)).length
        }
      }
    }
  }

  // --- report ---------------------------------------------------------------
  const meta = await providerMeta()
  const report = {
    generatedAt: new Date().toISOString(),
    dataset: {
      universe: UNIVERSE_NAME,
      provider: meta.provider, simulated: meta.simulated,
      symbols: series.length, alignedSessions: n,
      calibrationSessions: calEnd, evaluationSessions: evaluatedDays,
      benchmark: BENCHMARK,
    },
    topK: TOP_K,
    labels: LABELS,
    precisionAtK: Object.fromEntries(RANKERS.map((r) => [
      r.id,
      {
        label: r.label,
        byLabel: Object.fromEntries(LABELS.map((l) => {
          const c = results[r.id]![l.id]!
          return [l.id, c.total > 0 ? c.hits / c.total : 0]
        })),
      },
    ])),
    alertVolume: Object.fromEntries((Object.keys(BUDGETS) as (keyof typeof BUDGETS)[]).map((b) => {
      const h = budgetHits[b]
      const meaningfulTotal = h.correct + h.missed
      return [b, {
        thresholdPercentile: BUDGETS[b],
        meanAlertsPerSessionPer50Symbols: mean(alertCounts[b]),
        medianAlertsPerSession: median(alertCounts[b]),
        maxAlertsPerSession: Math.max(0, ...alertCounts[b]),
        // Of the alerts this threshold fired, how many were meaningful.
        precision: h.fired > 0 ? h.correct / h.fired : 0,
        // Of the meaningful events, how many this threshold caught.
        recall: meaningfulTotal > 0 ? h.correct / meaningfulTotal : 0,
        alertsFired: h.fired,
        labelUsed: LABELS[0]!.id,
      }]
    })),
  }

  mkdirSync(new URL('../out/', import.meta.url), { recursive: true })
  const suffix = UNIVERSE_NAME === 'nifty50' ? '' : `.${UNIVERSE_NAME}`
  writeFileSync(new URL(`../out/results${suffix}.json`, import.meta.url), JSON.stringify(report, null, 2))
  writeFileSync(new URL(`../out/results${suffix}.md`, import.meta.url), markdown(report))
  console.log('\n' + markdown(report))
  console.log(`[eval] done in ${((Date.now() - t0) / 1000).toFixed(1)}s → eval/out/results${suffix}.json`)
  await sql.end()
}

function empty() { return { composite: NaN, residZ: 0, returnPct: 0, priceMove: 0, residSigma: 0 } }
function mean(xs: readonly number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0 }

async function providerMeta(): Promise<{ provider: string; simulated: boolean }> {
  const rows = await q.symbolsWithSectors([`__meta__:${UNIVERSE_NAME}`])
  const provider = rows[0]?.name?.replace(/^provider:/, '') ?? 'unknown'
  return { provider, simulated: provider === 'synthetic' || provider === 'unknown' }
}

function markdown(r: ReturnType<typeof Object> extends never ? never : any): string {
  const lines: string[] = []
  lines.push(`### Precision@${r.topK}`)
  lines.push('')
  lines.push(`Dataset: **${r.dataset.provider}**${r.dataset.simulated ? ' (simulated)' : ''} · ` +
    `${r.dataset.universe} · ${r.dataset.symbols} symbols · ${r.dataset.evaluationSessions} evaluation sessions ` +
    `(calibrated on ${r.dataset.calibrationSessions} disjoint earlier sessions)`)
  lines.push('')
  const labelIds: string[] = r.labels.map((l: any) => l.id)
  lines.push(`| Ranker | ${labelIds.join(' | ')} |`)
  lines.push(`|---|${labelIds.map(() => '---').join('|')}|`)
  for (const id of Object.keys(r.precisionAtK)) {
    const row = r.precisionAtK[id]
    const cells = labelIds.map((l) => row.byLabel[l].toFixed(3))
    const bold = id === 'since'
    lines.push(`| ${bold ? '**' : ''}${row.label}${bold ? '**' : ''} | ${cells.map((c) => bold ? `**${c}**` : c).join(' | ')} |`)
  }
  lines.push('')
  lines.push('Labels:')
  for (const l of r.labels) lines.push(`- \`${l.id}\` — ${l.description}`)
  lines.push('')
  lines.push('### Alert volume (per session, 50-symbol watchlist)')
  lines.push('')
  lines.push('| Budget | Threshold | Mean/session | Max | Precision | Recall |')
  lines.push('|---|---|---|---|---|---|')
  for (const b of Object.keys(r.alertVolume)) {
    const a = r.alertVolume[b]
    lines.push(`| ${b} | p${a.thresholdPercentile} | ${a.meanAlertsPerSessionPer50Symbols.toFixed(2)} | ` +
      `${a.maxAlertsPerSession} | ${a.precision.toFixed(3)} | ${a.recall.toFixed(3)} |`)
  }
  return lines.join('\n')
}

main().catch(async (err) => {
  console.error('[eval] FAILED:', err)
  await sql.end().catch(() => {})
  process.exit(1)
})
