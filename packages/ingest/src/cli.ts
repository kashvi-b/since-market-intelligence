/**
 * One-shot ingestion. The ONLY component that talks to an external market feed.
 *
 * Everything on the request path reads Postgres, so a demo can never be broken
 * by a third party's availability or rate limits. Re-running is safe: every
 * write is an idempotent upsert keyed on natural identity.
 *
 *   npm run ingest                      real NSE data via Yahoo
 *   npm run ingest -- --provider synthetic
 *   npm run ingest -- --no-faults       skip injected data-quality faults
 */
import { sql, db, schema } from '@since/db'
import { desc, eq, inArray, sql as dsql } from 'drizzle-orm'
import { detectSuspectBar, logReturn, marketFor, instantAtLocalMinute, type DailyBar } from '@since/core'
import { SECTORS, universeFor, type UniverseName } from './universe.js'
import { YahooProvider } from './providers/yahoo.js'
import { SyntheticProvider } from './providers/synthetic.js'
import { TwelveDataProvider } from './providers/twelvedata.js'
import { computeSymbolStats, buildFallbackGrid } from './stats.js'
import type { MarketDataProvider } from './provider.js'

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`)
const opt = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1]! : dflt
}

const PROVIDER = opt('provider', 'yahoo')
const YEARS = Number(opt('years', '3'))
const INTRADAY_DAYS = Number(opt('intraday-days', '55'))
const WITH_FAULTS = !flag('no-faults')
const CLEAN = flag('clean')
/**
 * Which universe to load.
 *
 * `nifty50` is the product. `us` exists so the evaluation can run against real
 * market data: free NSE feeds are gated behind paid plans, and a model measured
 * only on data I generated proves nothing about markets.
 */
const UNIVERSE_NAME = opt('universe', 'nifty50') as UniverseName

/**
 * The exchange being ingested. Everything time-shaped below derives from this
 * rather than assuming a market, which is what previously stamped US prices
 * with the NSE close.
 */
const MARKET = marketFor(UNIVERSE_NAME)
// Twelve Data's free tier allows 8 req/min, so real runs are serialised by the
// provider's own throttle regardless of this.
const CONCURRENCY = Number(opt('concurrency', '3'))

const DEMO_EMAIL = 'demo@since.local'
/** A realistic watchlist: big enough that filtering is visibly doing work. */
const DEMO_WATCHLIST_SIZE = 30

/**
 * Symbols carrying injected data-quality faults, per universe.
 *
 * STALE_FEED_SYMBOL gets NO closing-price observation written for it. That is
 * what a stopped feed actually means — and without it the fault silently expires
 * at 15:30 when the session-close observation lands and supersedes it, turning
 * the "stale data" scenario back into a healthy one mid-demo.
 */
const FAULT_SYMBOLS: Record<string, { stale: string; conflict: string }> = {
  nifty50: { stale: 'RELIANCE', conflict: 'ONGC' },
  us: { stale: 'XOM', conflict: 'CVX' },
}

/**
 * Pick a provider.
 *
 * `auto` (the default) prefers Twelve Data when a key is present, since Yahoo's
 * unofficial endpoint rate-limits entire carrier ranges. Either real provider
 * falls back to the deterministic synthetic one if the benchmark cannot be
 * fetched — loudly, and recorded on every observation.
 */
function buildProvider(name: string, toDate: string, timeZone: string): MarketDataProvider {
  const key = process.env.TWELVEDATA_API_KEY
  if (name === 'synthetic') return new SyntheticProvider(toDate)
  if (name === 'twelvedata') return new TwelveDataProvider(requireKey(key), { timeZone })
  if (name === 'yahoo') return new YahooProvider()
  return key ? new TwelveDataProvider(key, { timeZone }) : new YahooProvider()
}

function requireKey(key: string | undefined): string {
  if (!key) {
    console.error('[ingest] TWELVEDATA_API_KEY is not set.')
    console.error('[ingest] Get a free key at https://twelvedata.com/pricing (free tier: 800 req/day)')
    process.exit(1)
  }
  return key
}

async function main(): Promise<void> {
  const t0 = Date.now()
  const today = new Date()
  const toDate = today.toISOString().slice(0, 10)
  const fromDate = new Date(today.getTime() - YEARS * 365 * 86400_000).toISOString().slice(0, 10)
  const intradayFrom = new Date(today.getTime() - INTRADAY_DAYS * 86400_000).toISOString().slice(0, 10)

  let provider: MarketDataProvider = buildProvider(PROVIDER, toDate, marketFor(UNIVERSE_NAME).timeZone)

  const uni = universeFor(UNIVERSE_NAME)
  const UNIVERSE = uni.symbols
  const BENCHMARK_ID = uni.benchmarkId
  const symbolId = (t: string) => `${t}${uni.suffix}`

  log(`provider=${provider.source} simulated=${provider.isSimulated} universe=${UNIVERSE_NAME} ` +
      `(${UNIVERSE.length} symbols, benchmark ${BENCHMARK_ID}) range=${fromDate}..${toDate}`)

  // Mixing providers inside one dataset would silently corrupt every statistic:
  // real bars for 2024 and synthetic bars for 2026 produce a fictitious return
  // at the seam. --clean makes a run reproducible from empty.
  if (CLEAN) {
    // Scoped to this universe: wiping everything would destroy the other
    // dataset, and the two are ingested independently.
    const ids = [BENCHMARK_ID, ...UNIVERSE.map((s) => symbolId(s.ticker))]
    await db.delete(schema.dailyBars).where(inArray(schema.dailyBars.symbolId, ids))
    await db.delete(schema.intradayBars).where(inArray(schema.intradayBars.symbolId, ids))
    await db.delete(schema.corporateActions).where(inArray(schema.corporateActions.symbolId, ids))
    await db.delete(schema.marketEvents).where(inArray(schema.marketEvents.symbolId, ids))
    await db.delete(schema.symbolStats).where(inArray(schema.symbolStats.symbolId, ids))
    await db.delete(schema.observations).where(inArray(schema.observations.symbolId, ids))
    await db.delete(schema.dataQuarantine).where(inArray(schema.dataQuarantine.symbolId, ids))
    log(`cleaned market-truth rows for the ${UNIVERSE_NAME} universe (--clean)`)
  }

  // ---- reference data ------------------------------------------------------
  await db.insert(schema.sectors).values(SECTORS.map((s) => ({
    id: s.id, name: s.name, indexTicker: s.indexTicker,
  }))).onConflictDoUpdate({
    target: schema.sectors.id,
    set: { name: sqlExcluded('name'), indexTicker: sqlExcluded('index_ticker') },
  })

  await db.insert(schema.symbols).values([
    {
      id: BENCHMARK_ID, ticker: BENCHMARK_ID, name: uni.benchmarkName,
      exchange: uni.exchange, sectorId: null, isIndex: true, status: 'ACTIVE' as const,
    },
    ...UNIVERSE.map((s) => ({
      id: symbolId(s.ticker), ticker: s.ticker, name: s.name,
      exchange: uni.exchange, sectorId: s.sectorId, isIndex: false, status: 'ACTIVE' as const,
    })),
  ]).onConflictDoUpdate({
    target: schema.symbols.id,
    set: { name: sqlExcluded('name'), sectorId: sqlExcluded('sector_id') },
  })
  log(`reference data: ${SECTORS.length} sectors, ${UNIVERSE.length + 1} symbols`)

  // ---- benchmark first: it defines the trading calendar --------------------
  //
  // If the real feed cannot serve the benchmark we fall back to the synthetic
  // provider rather than failing the run. The fallback is loud, is recorded on
  // every observation as source "synthetic", and is surfaced in the UI — a demo
  // that quietly shows made-up data as real would be worse than no demo.
  let indexBars = await provider.dailyBars(BENCHMARK_ID, fromDate, toDate)
  if (indexBars.length === 0 && PROVIDER !== 'synthetic') {
    log(`WARNING: ${provider.source} returned no benchmark data (rate limit or outage).`)
    log('WARNING: falling back to the deterministic synthetic provider.')
    provider = new SyntheticProvider(toDate)
    indexBars = await provider.dailyBars(BENCHMARK_ID, fromDate, toDate)
  }
  if (indexBars.length === 0) {
    throw new Error(`No benchmark data for ${BENCHMARK_ID}. Cannot build a trading calendar.`)
  }
  // Per universe: a global marker would make the NSE dataset claim the US
  // dataset's provider the moment both are ingested.
  await db.insert(schema.symbols).values({
    id: `__meta__:${UNIVERSE_NAME}`, ticker: `__meta__:${UNIVERSE_NAME}`,
    name: `provider:${provider.source}`,
    exchange: uni.exchange, sectorId: null, isIndex: true, status: 'SUSPENDED' as const,
  }).onConflictDoUpdate({
    target: schema.symbols.id, set: { name: dsql.raw(`excluded."name"`) as never },
  })
  await writeDailyBars(BENCHMARK_ID, indexBars)
  const indexIntraday = await provider.intradayBars(BENCHMARK_ID, intradayFrom, toDate)
  if (indexIntraday.length) await writeIntradayBars(BENCHMARK_ID, indexIntraday)
  log(`benchmark: ${indexBars.length} sessions, ${indexIntraday.length} intraday bars`)

  // ---- symbols -------------------------------------------------------------
  const failures: string[] = []
  const allQuarantined: { symbolId: string; date: string; reason: string;
    impliedRatio?: number | undefined; apparentMovePct: number }[] = []
  const gridsForFallback: (number[] | null)[] = []
  let ingested = 0

  await pool(UNIVERSE, CONCURRENCY, async (def) => {
    const id = symbolId(def.ticker)
    try {
      const bars = await provider.dailyBars(id, fromDate, toDate)
      if (bars.length < 80) { failures.push(`${id} (only ${bars.length} bars)`); return }
      await writeDailyBars(id, bars)

      // Intraday powers replay. Both universes are demoable now, so both get it.
      const intraday = await provider.intradayBars(id, intradayFrom, toDate)
      if (intraday.length) await writeIntradayBars(id, intraday)

      const actions = await provider.corporateActions(id, fromDate, toDate)
      if (actions.length) {
        await db.insert(schema.corporateActions).values(actions.map((a) => ({
          id: `${a.symbolId}:${a.exDate}:${a.type}`,
          symbolId: a.symbolId, exDate: a.exDate, type: a.type,
          ratio: a.ratio, notes: a.notes,
        }))).onConflictDoNothing()
      }

      const events = await provider.marketEvents(id, fromDate, toDate)
      if (events.length) {
        await db.insert(schema.marketEvents).values(events.map((e) => ({
          id: `${e.symbolId}:${e.publishedAt.toISOString()}:${hash(e.headline)}`,
          symbolId: e.symbolId, publishedAt: e.publishedAt, type: e.type,
          headline: e.headline, url: e.url, source: e.source,
        }))).onConflictDoNothing()
      }

      const result = computeSymbolStats({
        symbolId: id, bars, indexBars,
        corporateActionDates: new Set(actions.map((a) => a.exDate)),
      })
      if (!result) { failures.push(`${id} (insufficient history for statistics)`); return }

      for (const q of result.quarantined) allQuarantined.push({ symbolId: id, ...q })
      gridsForFallback.push(result.stats.pctlGrid)

      await db.insert(schema.symbolStats).values({
        symbolId: id, asOf: result.stats.asOf,
        beta: result.stats.beta, residMad: result.stats.residMad,
        residMedian: result.stats.residMedian,
        volMedian20: result.stats.volMedian20, volMad20: result.stats.volMad20,
        gapSigma: result.stats.gapSigma,
        high52w: result.stats.high52w, low52w: result.stats.low52w,
        pctlGrid: result.stats.pctlGrid, sampleN: result.stats.sampleN,
        quality: 'FRESH',
      }).onConflictDoUpdate({
        target: [schema.symbolStats.symbolId, schema.symbolStats.asOf],
        set: {
          beta: sqlExcluded('beta'), residMad: sqlExcluded('resid_mad'),
          residMedian: sqlExcluded('resid_median'),
          volMedian20: sqlExcluded('vol_median_20'), volMad20: sqlExcluded('vol_mad_20'),
          gapSigma: sqlExcluded('gap_sigma'),
          high52w: sqlExcluded('high_52w'), low52w: sqlExcluded('low_52w'),
          pctlGrid: sqlExcluded('pctl_grid'), sampleN: sqlExcluded('sample_n'),
        },
      })

      // A symbol whose feed is meant to be dead must not receive a fresh one.
      const staleTicker = (FAULT_SYMBOLS[UNIVERSE_NAME] ?? FAULT_SYMBOLS['nifty50']!).stale
      if (id !== symbolId(staleTicker) || !WITH_FAULTS) {
        await writeLatestObservation(id, bars, provider.source)
      }
      ingested++
      if (ingested % 10 === 0) log(`  ...${ingested}/${UNIVERSE.length} symbols`)
    } catch (err) {
      failures.push(`${id} (${(err as Error).message})`)
    }
  })

  log(`symbols ingested: ${ingested}/${UNIVERSE.length}`)
  if (allQuarantined.length) {
    await db.insert(schema.dataQuarantine).values(allQuarantined.map((q) => ({
      id: `${q.symbolId}:${q.date}`,
      symbolId: q.symbolId, date: q.date, reason: q.reason,
      impliedRatio: q.impliedRatio ?? null,
      apparentMovePct: q.apparentMovePct,
    }))).onConflictDoUpdate({
      target: [schema.dataQuarantine.symbolId, schema.dataQuarantine.date],
      set: { reason: dsql.raw('excluded."reason"') as never },
    })
    log(`quarantined bars (corporate actions / bad ticks): ${allQuarantined.length}`)
    for (const q of allQuarantined.slice(0, 8)) log(`    ${q.symbolId} ${q.date} — ${q.reason}`)
  }
  if (failures.length) log(`skipped: ${failures.join(', ')}`)

  await writeLatestObservation(BENCHMARK_ID, indexBars, provider.source)

  // ---- fallback grid for symbols with thin history -------------------------
  const fallback = buildFallbackGrid(gridsForFallback)
  if (fallback) {
    await db.insert(schema.symbolStats).values({
      symbolId: BENCHMARK_ID, asOf: indexBars[indexBars.length - 1]!.date,
      beta: 1, residMad: null, residMedian: null,
      volMedian20: null, volMad20: null, gapSigma: null,
      high52w: null, low52w: null, pctlGrid: fallback, sampleN: gridsForFallback.length,
      quality: 'FRESH',
    }).onConflictDoUpdate({
      target: [schema.symbolStats.symbolId, schema.symbolStats.asOf],
      set: { pctlGrid: sqlExcluded('pctl_grid') },
    })
    log('peer fallback calibration grid stored on the benchmark row')
  }

  await seedDemoUser(indexBars, UNIVERSE, symbolId)
  if (WITH_FAULTS) await injectFaults(indexBars, UNIVERSE_NAME, symbolId)

  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  await sql.end()
}

/* ------------------------------------------------------------------ writes */

async function writeDailyBars(id: string, bars: readonly DailyBar[]): Promise<void> {
  for (const chunk of chunks(bars, 500)) {
    await db.insert(schema.dailyBars).values(chunk.map((b) => ({
      symbolId: id, date: b.date, open: b.open, high: b.high, low: b.low,
      close: b.close, adjClose: b.adjClose, volume: b.volume,
    }))).onConflictDoUpdate({
      target: [schema.dailyBars.symbolId, schema.dailyBars.date],
      set: {
        open: sqlExcluded('open'), high: sqlExcluded('high'), low: sqlExcluded('low'),
        close: sqlExcluded('close'), adjClose: sqlExcluded('adj_close'),
        volume: sqlExcluded('volume'),
      },
    })
  }
}

async function writeIntradayBars(
  id: string, bars: readonly { ts: Date; open: number; high: number; low: number; close: number; volume: number }[],
): Promise<void> {
  for (const chunk of chunks(bars, 1000)) {
    await db.insert(schema.intradayBars).values(chunk.map((b) => ({
      symbolId: id, ts: b.ts, interval: '5m', open: b.open, high: b.high,
      low: b.low, close: b.close, volume: b.volume,
    }))).onConflictDoNothing()
  }
}

/** The latest known value, with full provenance. Never a bare number. */
async function writeLatestObservation(id: string, bars: readonly DailyBar[], source: string): Promise<void> {
  const last = bars[bars.length - 1]
  if (!last) return
  // The close of the session this price belongs to. Stamping it with another
  // market's close pushes it hours away from `lastSessionCloseAt`, and the
  // quality gate then cannot recognise a closing price as a closing price — it
  // falls through to the wall-clock rule and every symbol goes stale overnight.
  const observedAt = instantAtLocalMinute(last.date, MARKET.closeMinute, MARKET.timeZone)
  await db.insert(schema.observations).values({
    id: `${id}:${source}:${observedAt.toISOString()}`,
    symbolId: id, price: last.close, volume: last.volume,
    observedAt, receivedAt: new Date(), source, quality: 'FRESH',
    raw: { date: last.date, kind: 'session-close' },
  }).onConflictDoNothing()
}

async function seedDemoUser(
  indexBars: readonly DailyBar[],
  UNIVERSE: { ticker: string }[],
  symbolId: (t: string) => string,
): Promise<void> {
  const userId = 'user_demo'
  await db.insert(schema.users).values({
    id: userId, email: DEMO_EMAIL, displayName: 'Demo',
  }).onConflictDoNothing()

  await db.insert(schema.attentionSettings).values({
    userId, budget: 'MEDIUM', maxCards: 3,
  }).onConflictDoNothing()

  const watchlistId = 'wl_demo'
  await db.insert(schema.watchlists).values({
    id: watchlistId, userId, name: 'My watchlist',
  }).onConflictDoNothing()

  // Ensure the injected-fault symbols are actually watched, or the data-quality
  // scenarios exist in the database but never appear in the demo.
  const faults = FAULT_SYMBOLS[UNIVERSE_NAME] ?? FAULT_SYMBOLS['nifty50']!
  const head = UNIVERSE.slice(0, DEMO_WATCHLIST_SIZE)
  const picks = [...head]
  for (const t of [faults.stale, faults.conflict]) {
    if (!picks.some((p) => p.ticker === t)) {
      const found = UNIVERSE.find((u) => u.ticker === t)
      if (found) picks.push(found)
    }
  }
  // Replace, don't append. Seeding a second universe previously left the first
  // one's symbols in the watchlist, so a US deployment would score NSE stocks
  // against the S&P — a mixed watchlist is not a watchlist for either market.
  await db.delete(schema.watchlistItems).where(eq(schema.watchlistItems.watchlistId, watchlistId))
  await db.delete(schema.readCursors).where(eq(schema.readCursors.userId, userId))

  await db.insert(schema.watchlistItems).values(picks.map((s, i) => ({
    id: `${watchlistId}:${symbolId(s.ticker)}`,
    watchlistId, symbolId: symbolId(s.ticker), position: i,
  }))).onConflictDoNothing()

  // Put the cursor mid-session on the last trading day, so "while you were
  // away" spans a real window with real intraday data behind it.
  const lastDate = indexBars[indexBars.length - 1]!.date
  const lastSeenAt = new Date(`${lastDate}T04:44:00.000Z`)   // 10:14 IST
  await db.insert(schema.readCursors).values(picks.map((s) => ({
    userId, symbolId: symbolId(s.ticker),
    lastSeenAt, lastSeenVersion: lastSeenAt.getTime(), lastSeenPrice: null,
  }))).onConflictDoNothing()

  // One personal threshold, so the highest-weighted signal is demonstrable.
  await db.insert(schema.userThresholds).values({
    id: 'thr_demo_1', userId, symbolId: 'HDFCBANK.NS', kind: 'BELOW', value: 1400,
  }).onConflictDoNothing()

  log(`demo user seeded: ${DEMO_EMAIL}, ${picks.length} symbols, cursor at ${lastSeenAt.toISOString()}`)
}

/**
 * Inject data-quality faults.
 *
 * A single real feed cannot produce a genuine cross-provider conflict, so rather
 * than pretend otherwise we inject faults explicitly and label them. Every
 * injected row carries source "fault-injection" and is visible in /api/data-health.
 */
async function injectFaults(
  indexBars: readonly DailyBar[],
  universe: string,
  symbolId: (t: string) => string,
): Promise<void> {
  const picks = FAULT_SYMBOLS[universe] ?? FAULT_SYMBOLS['nifty50']!
  const STALE_FEED_SYMBOL = symbolId(picks.stale)
  const CONFLICT_SYMBOL = symbolId(picks.conflict)
  const lastDate = indexBars[indexBars.length - 1]!.date
  const sessionClose = instantAtLocalMinute(lastDate, MARKET.closeMinute, MARKET.timeZone)

  // 1. A feed that stopped days ago -> STALE -> alerts suppressed.
  //    Anchored to the dataset, so it is stale no matter when you look.
  await db.insert(schema.observations).values({
    id: `${STALE_FEED_SYMBOL}:fault-injection:stale`,
    symbolId: STALE_FEED_SYMBOL, price: null, volume: null,
    observedAt: new Date(sessionClose.getTime() - 3 * 86400_000),
    receivedAt: new Date(), source: 'fault-injection', quality: 'STALE',
    raw: { injected: true, scenario: 'stale-feed' },
  }).onConflictDoNothing()

  // 2. Two sources disagreeing beyond tolerance -> CONFLICTING -> no alert.
  //
  //    A single injected row would decay into "stale" within fifteen minutes of
  //    ingestion, silently turning one demo scenario into a different one. So
  //    the second source is written alongside EVERY recent bar: whenever you
  //    evaluate, both sources are equally fresh and genuinely disagree.
  const recent = await db.select({ ts: schema.intradayBars.ts, close: schema.intradayBars.close })
    .from(schema.intradayBars)
    .where(eq(schema.intradayBars.symbolId, CONFLICT_SYMBOL))
    .orderBy(desc(schema.intradayBars.ts))
    .limit(120)

  if (recent.length > 0) {
    const rows = recent.map((r) => ({
      id: `${CONFLICT_SYMBOL}:fault-injection:${r.ts.toISOString()}`,
      symbolId: CONFLICT_SYMBOL,
      price: Math.round(r.close * 0.972 * 100) / 100,   // 2.8% apart: past tolerance
      volume: null,
      observedAt: r.ts,
      receivedAt: new Date(),
      source: 'fault-injection',
      quality: 'FRESH' as const,
      raw: { injected: true, scenario: 'conflicting-sources' },
    }))
    for (const chunk of chunks(rows, 200)) await db.insert(schema.observations).values(chunk).onConflictDoNothing()

    // The primary source needs a matching observation at each of those instants,
    // or there is nothing for the injected one to conflict WITH.
    const primary = recent.map((r) => ({
      id: `${CONFLICT_SYMBOL}:primary:${r.ts.toISOString()}`,
      symbolId: CONFLICT_SYMBOL, price: r.close, volume: null,
      observedAt: r.ts, receivedAt: new Date(),
      source: 'market-feed', quality: 'FRESH' as const,
      raw: { kind: 'intraday' },
    }))
    for (const chunk of chunks(primary, 200)) await db.insert(schema.observations).values(chunk).onConflictDoNothing()
  }

  log(`injected data-quality faults: ${STALE_FEED_SYMBOL} stale (no live observation), ` +
      `${CONFLICT_SYMBOL} conflicting (${recent.length} instants)`)
}

/* ----------------------------------------------------------------- helpers */

/** Reference the incoming row inside an ON CONFLICT DO UPDATE. */
function sqlExcluded(col: string) {
  return dsql.raw(`excluded."${col}"`) as unknown as never
}

function* chunks<T>(xs: readonly T[], n: number): Generator<T[]> {
  for (let i = 0; i < xs.length; i += n) yield xs.slice(i, i + n) as T[]
}

async function pool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++]!
      await fn(item)
    }
  })
  await Promise.all(workers)
}

function hash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
  return Math.abs(h).toString(36)
}

function log(msg: string): void { console.log(`[ingest] ${msg}`) }

main().catch(async (err) => {
  console.error('[ingest] FAILED:', err)
  await sql.end().catch(() => {})
  process.exit(1)
})
