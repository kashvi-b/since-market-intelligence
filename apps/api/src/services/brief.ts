import { and, eq, inArray } from 'drizzle-orm'
import { db, schema, marketQueries as q } from '@since/db'
import {
  TradingCalendar, resolveWindow, scoreChange, composeBrief, marketFor, type MarketDef,
  assessFreshness, assessConflict, combine, detectSuspectBar,
  logReturn, mad, frequencyPhrase, istDate,
  type Brief, type ScoreInput, type ScoreResult, type SymbolStats,
  type AttentionBudget, type QualityAssessment,
} from '@since/core'

/**
 * Which market this deployment serves, derived from the data rather than
 * configured.
 *
 * Ingestion decides the universe; the API follows. A config flag here would be
 * a second source of truth that can silently disagree with the database — and
 * the failure mode is scoring US prices against a NIFTY benchmark, which would
 * look like a broken model rather than a broken setting.
 */
let marketCache: { market: MarketDef; at: number } | null = null
const MARKET_TTL_MS = 60_000

export async function activeMarket(): Promise<MarketDef> {
  if (marketCache && Date.now() - marketCache.at < MARKET_TTL_MS) return marketCache.market
  const rows = await db.select({ id: schema.symbols.id }).from(schema.symbols)
    .where(eq(schema.symbols.id, '__meta__:us')).limit(1)
  // Both universes can coexist; the one with a seeded demo watchlist wins.
  const [item] = await db.select({ symbolId: schema.watchlistItems.symbolId })
    .from(schema.watchlistItems).limit(1)
  const id = item ? (item.symbolId.endsWith('.NS') ? 'nifty50' : 'us') : (rows[0] ? 'us' : 'nifty50')
  const market = marketFor(id)
  marketCache = { market, at: Date.now() }
  return market
}

/** Benchmark for the active market. */
export async function benchmarkId(): Promise<string> {
  return (await activeMarket()).benchmarkId
}

/**
 * The calendar date of an instant, in the active market's own timezone.
 *
 * istDate() defaults to Asia/Kolkata. Every caller that took the default was
 * asking "which session's data may I use" and getting the answer for Mumbai,
 * which rolls over at 18:30 IST — in the middle of the New York afternoon.
 */
export async function marketDate(at: Date): Promise<string> {
  return istDate(at, (await activeMarket()).timeZone)
}

export interface BriefResult extends Brief {
  at: string
  /** Which exchange these prices belong to, so the client formats correctly. */
  market: {
    id: string; label: string; timeZone: string
    currency: string; locale: string; benchmark: string
  }
  symbolNames: Record<string, string>
  sectors: Record<string, { id: string; name: string } | null>
  /** True when the underlying dataset is simulated. Surfaced in the UI. */
  simulated: boolean
  provider: string
}

let calendarCache: { cal: TradingCalendar; loadedAt: number } | null = null
const CALENDAR_TTL_MS = 60_000

export async function calendar(): Promise<TradingCalendar> {
  if (calendarCache && Date.now() - calendarCache.loadedAt < CALENDAR_TTL_MS) return calendarCache.cal
  const market = await activeMarket()
  const cal = new TradingCalendar(await q.sessionDates(market.benchmarkId), market)
  calendarCache = { cal, loadedAt: Date.now() }
  return cal
}

export async function providerInfo(): Promise<{ provider: string; simulated: boolean }> {
  const market = await activeMarket()
  const rows = await db.select({ name: schema.symbols.name }).from(schema.symbols)
    .where(eq(schema.symbols.id, `__meta__:${market.id}`)).limit(1)
  const provider = rows[0]?.name?.replace(/^provider:/, '') ?? 'unknown'
  // Only the synthetic provider generates data. Anything else is observed.
  return { provider, simulated: provider === 'synthetic' || provider === 'unknown' }
}

/**
 * THE core function.
 *
 * `at` is the only thing separating live from replay. Live passes `now`; the
 * replay UI passes a historical instant. There is no second implementation and
 * no demo-only branch — if replay works, live works, and vice versa.
 */
export async function evaluateBrief(params: {
  userId: string
  at: Date
  budgetOverride?: AttentionBudget
  capOverride?: number
}): Promise<BriefResult> {
  const { userId, at } = params
  const cal = await calendar()
  const market = await activeMarket()
  const BENCH = market.benchmarkId

  const [settingsRow] = await db.select().from(schema.attentionSettings)
    .where(eq(schema.attentionSettings.userId, userId)).limit(1)
  const budget: AttentionBudget = params.budgetOverride ?? settingsRow?.budget ?? 'MEDIUM'
  const cap = params.capOverride ?? settingsRow?.maxCards ?? 3

  const items = await db.select({ symbolId: schema.watchlistItems.symbolId })
    .from(schema.watchlistItems)
    .innerJoin(schema.watchlists, eq(schema.watchlists.id, schema.watchlistItems.watchlistId))
    .where(eq(schema.watchlists.userId, userId))
  const symbolIds = items.map((i) => i.symbolId)

  const meta = await providerInfo()
  const marketPayload = {
    id: market.id, label: market.label, timeZone: market.timeZone,
    currency: market.currency, locale: market.locale, benchmark: market.benchmarkLabel,
    // The instant the last session closed, so the client can offer "last close"
    // without re-deriving an exchange calendar it does not have.
    lastCloseAt: cal.lastSessionCloseAt(at)?.toISOString() ?? null,
  }
  const emptyWindow = resolveWindow({ lastSeenAt: null, at, calendar: cal })
  // Sentinel for the reduce below: any real cursor must beat it.
  const farFuture = { ...emptyWindow, windowStart: new Date(8640000000000000) }

  if (symbolIds.length === 0) {
    return {
      ...composeBrief({
        scored: [], window: emptyWindow, budget, cap,
        indexReturn: null, indexSigma: null, sectorOf: () => null,
      }),
      at: at.toISOString(), symbolNames: {}, sectors: {}, market: marketPayload, ...meta,
    }
  }

  const [cursors, thresholds, symbolRows, statsMap, obsMap] = await Promise.all([
    db.select().from(schema.readCursors)
      .where(and(eq(schema.readCursors.userId, userId), inArray(schema.readCursors.symbolId, symbolIds))),
    db.select().from(schema.userThresholds)
      .where(and(eq(schema.userThresholds.userId, userId), inArray(schema.userThresholds.symbolId, symbolIds))),
    q.symbolsWithSectors([...symbolIds, BENCH]),
    q.statsFor(symbolIds, await marketDate(at)),
    q.observationsFor(symbolIds, at),
  ])

  const sectorRows = await db.select().from(schema.sectors)
  const sectorById = new Map(sectorRows.map((s) => [s.id, s]))
  const symbolById = new Map(symbolRows.map((s) => [s.id, s]))
  const cursorBySymbol = new Map(cursors.map((c) => [c.symbolId, c]))
  const thresholdBySymbol = new Map(thresholds.map((t) => [t.symbolId, t]))

  // Windows differ per symbol (each has its own cursor), so batch the price
  // lookups by distinct window start rather than issuing one query per symbol.
  const windows = new Map<string, ReturnType<typeof resolveWindow>>()
  const byStart = new Map<number, string[]>()
  for (const id of symbolIds) {
    const w = resolveWindow({ lastSeenAt: cursorBySymbol.get(id)?.lastSeenAt ?? null, at, calendar: cal })
    windows.set(id, w)
    const key = w.windowStart.getTime()
    const list = byStart.get(key)
    if (list) list.push(id)
    else byStart.set(key, [id])
  }

  const endPrices = await q.pricesAt([...symbolIds, BENCH], at)
  const startPrices = new Map<string, { price: number }>()
  const indexStartByTime = new Map<number, number | null>()
  for (const [startMs, ids] of byStart) {
    const start = new Date(startMs)
    const prices = await q.pricesAt([...ids, BENCH], start)
    for (const id of ids) {
      const p = prices.get(id)
      if (p) startPrices.set(id, p)
    }
    indexStartByTime.set(startMs, prices.get(BENCH)?.price ?? null)
  }

  const indexEnd = endPrices.get(BENCH)?.price ?? null
  const marketOpen = cal.isOpen(at)
  const lastClose = cal.lastSessionCloseAt(at)

  // Batch every remaining lookup. Scoring a 30-symbol watchlist used to issue
  // ~240 queries and take nine seconds; this is a fixed number regardless of
  // watchlist size.
  const barsFrom = new Date(at.getTime() - 20 * 86400_000).toISOString().slice(0, 10)
  const barsTo = await marketDate(at)
  const earliestWindow = new Date(Math.min(...[...windows.values()].map((w) => w.windowStart.getTime())))
  const [barsBySymbol, indexBarsList, actionsBySymbol, eventsBySymbol, idxSigma] = await Promise.all([
    q.dailyBarsBatch(symbolIds, barsFrom, barsTo),
    q.dailyBarsBetween(BENCH, barsFrom, barsTo),
    q.corporateActionsBatch(symbolIds, barsFrom, barsTo),
    q.eventsBatch(symbolIds, earliestWindow, at),
    benchmarkSigma(1),
  ])
  const indexByDate = new Map(indexBarsList.map((b) => [b.date, b]))
  const grid = await fallbackGrid()

  const scored: ScoreResult[] = []
  for (const id of symbolIds) {
    const w = windows.get(id)!
    const stats = toSymbolStats(id, statsMap.get(id))
    const observations = obsMap.get(id) ?? []

    const bars = buildRecentBars(barsBySymbol.get(id) ?? [], indexByDate, actionsBySymbol.get(id) ?? [])

    const quality = assessQualitySync({
      at, observations, marketOpen, lastClose,
      observedAt: endPrices.get(id)?.observedAt ?? null,
      bars,
    })

    const threshold = thresholdBySymbol.get(id)
    const events = (eventsBySymbol.get(id) ?? []).filter((e) => e.publishedAt > w.windowStart)

    const input: ScoreInput = {
      symbolId: id,
      windowStart: w.windowStart, windowEnd: w.windowEnd,
      priceStart: startPrices.get(id)?.price ?? null,
      priceEnd: endPrices.get(id)?.price ?? null,
      indexStart: indexStartByTime.get(w.windowStart.getTime()) ?? null,
      indexEnd,
      volume: bars.today?.volume ?? null,
      prevClose: bars.prev?.adjClose ?? null,
      sessionOpen: bars.today?.open ?? null,
      stats,
      quality,
      sessions: w.sessions,
      sessionResiduals: bars.residuals,
      userThreshold: threshold ? { kind: threshold.kind, value: threshold.value } : undefined,
      // Prices in explanation text belong to this exchange, not to whichever
      // one the scoring code was first written for.
      money: { currency: market.currency, locale: market.locale },
      hasEventInWindow: events.length > 0,
      eventHeadline: events[0]?.headline,
    }

    scored.push(scoreChange(input, { fallbackGrid: grid }))
  }

  // The headline window is the OLDEST cursor, not an arbitrary symbol's.
  //
  // Cursors advance per symbol, so after opening one card that symbol's window
  // collapses to "moments". Taking the first symbol's window then makes the hero
  // claim you have been away for seconds when most of the list is days stale.
  // "How long were you away" means the longest, across everything still unread.
  const headlineWindow = [...windows.values()]
    .reduce((oldest, w) => (w.windowStart < oldest.windowStart ? w : oldest), farFuture)
  const anyWindow = windows.size > 0 ? headlineWindow : emptyWindow
  const indexStart = indexStartByTime.get(anyWindow.windowStart.getTime()) ?? null
  const indexReturn = logReturn(indexStart, indexEnd)
  const indexSigma = idxSigma !== null ? idxSigma * Math.sqrt(Math.max(1, anyWindow.sessions)) : null

  const brief = composeBrief({
    scored, window: anyWindow, budget, cap,
    indexReturn, indexSigma,
    sectorOf: (id) => {
      const sym = symbolById.get(id)
      if (!sym?.sectorId) return null
      const sec = sectorById.get(sym.sectorId)
      return sec ? { id: sec.id, name: sec.name } : null
    },
  })

  return {
    ...brief,
    at: at.toISOString(),
    market: marketPayload,
    symbolNames: Object.fromEntries(symbolRows.map((s) => [s.id, s.name])),
    sectors: Object.fromEntries(symbolIds.map((id) => {
      const sym = symbolById.get(id)
      const sec = sym?.sectorId ? sectorById.get(sym.sectorId) : null
      return [id, sec ? { id: sec.id, name: sec.name } : null]
    })),
    ...meta,
  }
}

/* --------------------------------------------------------------- internals */

/**
 * Quality is assessed BEFORE scoring. Three independent checks combine, and the
 * worst one wins: a value that is actively wrong is worse than one that is
 * merely old.
 *
 * Pure and synchronous — all data is fetched in batch by the caller.
 */
export function assessQualitySync(p: {
  at: Date
  observations: readonly { source: string; price: number | null; observedAt: Date; quality: string }[]
  marketOpen: boolean
  lastClose: Date | null
  observedAt: Date | null
  bars: RecentBars
}): QualityAssessment {
  const sources = p.observations.map((o) => o.source)
  const newest = p.observations[0] ?? null

  const freshness = assessFreshness({
    observedAt: newest?.observedAt ?? p.observedAt,
    evaluatedAt: p.at,
    marketIsOpen: p.marketOpen,
    lastSessionCloseAt: p.lastClose,
  })

  const conflict = assessConflict(p.observations.map((o) => ({
    source: o.source, price: o.price, observedAt: o.observedAt,
  })))

  // A corporate action inside the recent window makes the raw move meaningless;
  // quarantine rather than fire the loudest false alert the system can produce.
  let sanity = { suspect: false, reason: 'Passes sanity checks' }
  if (p.bars.today && p.bars.prev) {
    sanity = detectSuspectBar({
      close: p.bars.today.close, prevClose: p.bars.prev.close,
      adjClose: p.bars.today.adjClose, prevAdjClose: p.bars.prev.adjClose,
      knownCorporateAction: p.bars.hasCorporateAction,
    })
  }

  return combine(freshness, conflict, sanity, sources.length ? sources : ['daily-close'])
}

/** Async wrapper retained for callers that hold no batch (e.g. /api/data-health). */
export async function assessQuality(p: {
  symbolId: string
  at: Date
  observations: readonly { source: string; price: number | null; observedAt: Date; quality: string }[]
  marketOpen: boolean
  lastClose: Date | null
  priceEnd: number | null
  observedAt: Date | null
}): Promise<QualityAssessment> {
  const to = await marketDate(p.at)
  const from = new Date(p.at.getTime() - 20 * 86400_000).toISOString().slice(0, 10)
  const [bars, idx, actions] = await Promise.all([
    q.dailyBarsBetween(p.symbolId, from, to),
    q.dailyBarsBetween(await benchmarkId(), from, to),
    q.corporateActionsBetween(p.symbolId, from, to),
  ])
  return assessQualitySync({
    ...p, bars: buildRecentBars(bars, new Map(idx.map((b) => [b.date, b])), actions),
  })
}

export interface RecentBars {
  today: { open: number; close: number; adjClose: number; volume: number } | null
  prev: { close: number; adjClose: number } | null
  residuals: number[]
  hasCorporateAction: boolean
}

/** Derive the per-symbol view the scorer needs from already-loaded bars. */
function buildRecentBars(
  bars: readonly { date: string; open: number; close: number; adjClose: number; volume: number }[],
  indexByDate: Map<string, { date: string; adjClose: number }>,
  actions: readonly { exDate: string }[],
): RecentBars {
  const residuals: number[] = []
  for (let i = 1; i < bars.length; i++) {
    const r = logReturn(bars[i - 1]!.adjClose, bars[i]!.adjClose)
    const ia = indexByDate.get(bars[i - 1]!.date)
    const ib = indexByDate.get(bars[i]!.date)
    const ir = ia && ib ? logReturn(ia.adjClose, ib.adjClose) : null
    if (r !== null) residuals.push(ir !== null ? r - ir : r)
  }
  const today = bars[bars.length - 1] ?? null
  const prev = bars[bars.length - 2] ?? null
  return {
    today: today ? { open: today.open, close: today.close, adjClose: today.adjClose, volume: today.volume } : null,
    prev: prev ? { close: prev.close, adjClose: prev.adjClose } : null,
    residuals: residuals.slice(-5),
    hasCorporateAction: actions.some((a) => a.exDate >= (prev?.date ?? '9999-12-31')),
  }
}

// Keyed by benchmark: a grid cached under one index must not be handed to the
// other when the active market changes.
let fallbackGridCache: { benchmark: string; grid: number[] | null } | null = null
async function fallbackGrid(): Promise<number[] | null> {
  const bench = await benchmarkId()
  if (fallbackGridCache?.benchmark === bench) return fallbackGridCache.grid
  const row = await q.latestStats(bench)
  fallbackGridCache = { benchmark: bench, grid: row?.pctlGrid ?? null }
  return fallbackGridCache.grid
}

let sigmaCache: { benchmark: string; value: number | null; at: number } | null = null

/**
 * Typical benchmark move for one session. Cached; it changes once a day.
 *
 * This scales the market-regime test. Reading it from the NIFTY while the
 * index return came from the S&P compared two different markets' units, so the
 * z-score was meaningless and the regime headline could never fire — the one
 * piece of the brief whose whole job is to say "this is the market, not your
 * stock" was silently switched off.
 */
async function benchmarkSigma(sessions: number): Promise<number | null> {
  const bench = await benchmarkId()
  if (sigmaCache && sigmaCache.benchmark === bench && Date.now() - sigmaCache.at < 300_000) {
    return sigmaCache.value === null ? null : sigmaCache.value * Math.sqrt(Math.max(1, sessions))
  }
  const to = new Date().toISOString().slice(0, 10)
  const from = new Date(Date.now() - 200 * 86400_000).toISOString().slice(0, 10)
  const bars = await q.dailyBarsBetween(bench, from, to)
  const rets: number[] = []
  for (let i = 1; i < bars.length; i++) {
    const r = logReturn(bars[i - 1]!.adjClose, bars[i]!.adjClose)
    if (r !== null) rets.push(r)
  }
  if (rets.length < 30) { sigmaCache = { benchmark: bench, value: null, at: Date.now() }; return null }
  const s = mad(rets)
  const base = Number.isFinite(s) && s > 0 ? s : null
  sigmaCache = { benchmark: bench, value: base, at: Date.now() }
  return base === null ? null : base * Math.sqrt(Math.max(1, sessions))
}

function toSymbolStats(
  symbolId: string, row: typeof schema.symbolStats.$inferSelect | undefined,
): SymbolStats | null {
  if (!row) return null
  return {
    symbolId, asOf: row.asOf, beta: row.beta, residMad: row.residMad,
    residMedian: row.residMedian, volMedian20: row.volMedian20, volMad20: row.volMad20,
    gapSigma: row.gapSigma, high52w: row.high52w, low52w: row.low52w,
    pctlGrid: row.pctlGrid, sampleN: row.sampleN,
  }
}

export { frequencyPhrase }
