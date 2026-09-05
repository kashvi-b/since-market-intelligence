import { and, asc, desc, eq, gt, gte, inArray, lte, sql } from 'drizzle-orm'
import { db } from '../index.js'
import * as t from '../schema.js'
import { istDate, marketFor, instantAtLocalMinute } from '@since/core'
import type { DailyBar, IntradayBar } from '@since/core'

/**
 * When a daily bar stands in for an observation, it is the close of its own
 * session — so it must carry that exchange's close, not a literal. The exchange
 * is inferred from the symbol, the same inference the brief uses to pick a
 * market, because market truth here is keyed only by symbol.
 */
function closeOf(symbolId: string, date: string): Date {
  const m = marketFor(symbolId.endsWith('.NS') ? 'nifty50' : 'us')
  return instantAtLocalMinute(date, m.closeMinute, m.timeZone)
}

/**
 * Market-truth queries.
 *
 * Shared by the API and the agent so there is exactly one definition of "what
 * was this worth at time T". Point-in-time correctness lives here: every lookup
 * is bounded by `at` so that replay and live are the same code path.
 */

export interface PricePoint {
  price: number
  observedAt: Date
  source: string
  /** '5m' when an intraday bar was used, 'daily' for a session close. */
  granularity: 'intraday' | 'daily'
}

/**
 * The last known price at or before `at`.
 *
 * Prefers an intraday bar (minute-accurate), falls back to the most recent
 * session close. Never looks forward — this is what makes `evaluateBrief(user,
 * historicalTimestamp)` produce exactly what the user would have seen then.
 */
export async function priceAt(symbolId: string, at: Date): Promise<PricePoint | null> {
  const intraday = await db.select({ ts: t.intradayBars.ts, close: t.intradayBars.close })
    .from(t.intradayBars)
    .where(and(eq(t.intradayBars.symbolId, symbolId), lte(t.intradayBars.ts, at)))
    .orderBy(desc(t.intradayBars.ts))
    .limit(1)

  if (intraday[0]) {
    return {
      price: intraday[0].close,
      observedAt: intraday[0].ts,
      source: 'intraday-5m',
      granularity: 'intraday',
    }
  }

  const daily = await db.select({ date: t.dailyBars.date, close: t.dailyBars.close })
    .from(t.dailyBars)
    .where(and(eq(t.dailyBars.symbolId, symbolId), lte(t.dailyBars.date, istDate(at))))
    .orderBy(desc(t.dailyBars.date))
    .limit(1)

  if (!daily[0]) return null
  return {
    price: daily[0].close,
    observedAt: closeOf(symbolId, daily[0].date),
    source: 'daily-close',
    granularity: 'daily',
  }
}

/** Prices for many symbols at one instant, in one round trip per granularity. */
export async function pricesAt(symbolIds: readonly string[], at: Date): Promise<Map<string, PricePoint>> {
  const out = new Map<string, PricePoint>()
  if (symbolIds.length === 0) return out

  const intraday = await db.execute<{ symbol_id: string; ts: Date; close: number }>(sql`
    SELECT DISTINCT ON (symbol_id) symbol_id, ts, close
    FROM intraday_bars
    WHERE symbol_id IN ${sql.raw(`(${symbolIds.map((s) => `'${escape(s)}'`).join(',')})`)}
      AND ts <= ${at.toISOString()}::timestamptz
    ORDER BY symbol_id, ts DESC
  `)
  for (const r of intraday) {
    out.set(r.symbol_id, {
      price: Number(r.close), observedAt: new Date(r.ts),
      source: 'intraday-5m', granularity: 'intraday',
    })
  }

  const missing = symbolIds.filter((s) => !out.has(s))
  if (missing.length > 0) {
    const day = istDate(at)
    const daily = await db.execute<{ symbol_id: string; date: string; close: number }>(sql`
      SELECT DISTINCT ON (symbol_id) symbol_id, date, close
      FROM daily_bars
      WHERE symbol_id IN ${sql.raw(`(${missing.map((s) => `'${escape(s)}'`).join(',')})`)}
        AND date <= ${day}::date
      ORDER BY symbol_id, date DESC
    `)
    for (const r of daily) {
      out.set(r.symbol_id, {
        price: Number(r.close),
        observedAt: closeOf(r.symbol_id, r.date),
        source: 'daily-close', granularity: 'daily',
      })
    }
  }
  return out
}

/** Identifiers are internal (`TICKER.NS`), but never interpolate unvalidated text. */
function escape(id: string): string {
  if (!/^[A-Za-z0-9^&._-]{1,32}$/.test(id)) throw new Error(`Unsafe symbol id: ${id}`)
  return id
}

export async function dailyBarsBetween(symbolId: string, from: string, to: string): Promise<DailyBar[]> {
  const rows = await db.select().from(t.dailyBars)
    .where(and(eq(t.dailyBars.symbolId, symbolId), gte(t.dailyBars.date, from), lte(t.dailyBars.date, to)))
    .orderBy(asc(t.dailyBars.date))
  return rows.map((r) => ({
    date: r.date, open: r.open, high: r.high, low: r.low,
    close: r.close, adjClose: r.adjClose, volume: Number(r.volume),
  }))
}

export async function intradayBetween(symbolId: string, from: Date, to: Date): Promise<IntradayBar[]> {
  const rows = await db.select().from(t.intradayBars)
    .where(and(eq(t.intradayBars.symbolId, symbolId), gt(t.intradayBars.ts, from), lte(t.intradayBars.ts, to)))
    .orderBy(asc(t.intradayBars.ts))
  return rows.map((r) => ({
    ts: r.ts, open: r.open, high: r.high, low: r.low, close: r.close, volume: Number(r.volume),
  }))
}

export async function latestStats(symbolId: string, asOf?: string) {
  const rows = await db.select().from(t.symbolStats)
    .where(asOf
      ? and(eq(t.symbolStats.symbolId, symbolId), lte(t.symbolStats.asOf, asOf))
      : eq(t.symbolStats.symbolId, symbolId))
    .orderBy(desc(t.symbolStats.asOf))
    .limit(1)
  return rows[0] ?? null
}

/**
 * Rolling statistics for scoring, preferring the newest row at or before `asOf`.
 *
 * Ingestion stores one row per symbol, computed from the full history, so a
 * replay to a past date finds nothing under a strict `asOf <= date` filter and
 * every symbol scores as uncalibrated — which looked like replay being broken.
 *
 * So we fall back to the nearest available row and mark it. That introduces
 * lookahead into REPLAY DISPLAY only. It does not touch the evaluation harness,
 * which computes its own point-in-time statistics and never reads this table —
 * the measured Precision@3 stays causal. See README "Limitations".
 */
export async function statsFor(symbolIds: readonly string[], asOf?: string) {
  if (symbolIds.length === 0) return new Map<string, typeof t.symbolStats.$inferSelect>()
  const rows = await db.select().from(t.symbolStats)
    .where(inArray(t.symbolStats.symbolId, [...symbolIds]))
    .orderBy(desc(t.symbolStats.asOf))

  const out = new Map<string, typeof t.symbolStats.$inferSelect>()
  if (asOf) {
    for (const r of rows) if (r.asOf <= asOf && !out.has(r.symbolId)) out.set(r.symbolId, r)
  }
  // Anything still missing gets the nearest row we hold.
  for (const r of rows) if (!out.has(r.symbolId)) out.set(r.symbolId, r)
  return out
}

/** Trading calendar, derived from the benchmark's own bars. */
export async function sessionDates(benchmarkId = '^NSEI'): Promise<string[]> {
  const rows = await db.select({ date: t.dailyBars.date }).from(t.dailyBars)
    .where(eq(t.dailyBars.symbolId, benchmarkId))
    .orderBy(asc(t.dailyBars.date))
  return rows.map((r) => r.date)
}

export async function observationsFor(symbolIds: readonly string[], at: Date) {
  if (symbolIds.length === 0) return new Map<string, (typeof t.observations.$inferSelect)[]>()
  const rows = await db.select().from(t.observations)
    .where(and(inArray(t.observations.symbolId, [...symbolIds]), lte(t.observations.observedAt, at)))
    .orderBy(desc(t.observations.observedAt))
  const out = new Map<string, (typeof t.observations.$inferSelect)[]>()
  for (const r of rows) {
    const list = out.get(r.symbolId)
    // Keep only the newest observation per source, so conflict detection sees
    // one candidate per provider rather than a provider's own history.
    if (!list) out.set(r.symbolId, [r])
    else if (!list.some((x) => x.source === r.source)) list.push(r)
  }
  return out
}

export async function eventsBetween(symbolId: string, from: Date, to: Date) {
  return db.select().from(t.marketEvents)
    .where(and(
      eq(t.marketEvents.symbolId, symbolId),
      gt(t.marketEvents.publishedAt, from),
      lte(t.marketEvents.publishedAt, to),
    ))
    .orderBy(asc(t.marketEvents.publishedAt))
}

export async function corporateActionsBetween(symbolId: string, from: string, to: string) {
  return db.select().from(t.corporateActions)
    .where(and(
      eq(t.corporateActions.symbolId, symbolId),
      gte(t.corporateActions.exDate, from),
      lte(t.corporateActions.exDate, to),
    ))
    .orderBy(asc(t.corporateActions.exDate))
}

export async function symbolsWithSectors(ids?: readonly string[]) {
  const rows = ids && ids.length
    ? await db.select().from(t.symbols).where(inArray(t.symbols.id, [...ids]))
    : await db.select().from(t.symbols)
  return rows
}

export async function peersOf(symbolId: string): Promise<string[]> {
  const me = await db.select({ sectorId: t.symbols.sectorId }).from(t.symbols)
    .where(eq(t.symbols.id, symbolId)).limit(1)
  const sectorId = me[0]?.sectorId
  if (!sectorId) return []
  const rows = await db.select({ id: t.symbols.id }).from(t.symbols)
    .where(and(eq(t.symbols.sectorId, sectorId), eq(t.symbols.isIndex, false)))
  return rows.map((r) => r.id).filter((id) => id !== symbolId)
}

/* ------------------------------------------------------------------ batch */
/*
 * Batch loaders.
 *
 * The per-symbol versions above are fine for one investigation, but a brief
 * scores an entire watchlist and calling them in a loop is an N+1 that made the
 * endpoint take nine seconds. These do the same work in a fixed number of
 * queries regardless of watchlist size.
 */

export async function dailyBarsBatch(
  symbolIds: readonly string[], from: string, to: string,
): Promise<Map<string, DailyBar[]>> {
  const out = new Map<string, DailyBar[]>()
  if (symbolIds.length === 0) return out
  const rows = await db.select().from(t.dailyBars)
    .where(and(
      inArray(t.dailyBars.symbolId, [...symbolIds]),
      gte(t.dailyBars.date, from),
      lte(t.dailyBars.date, to),
    ))
    .orderBy(asc(t.dailyBars.symbolId), asc(t.dailyBars.date))
  for (const r of rows) {
    const bar: DailyBar = {
      date: r.date, open: r.open, high: r.high, low: r.low,
      close: r.close, adjClose: r.adjClose, volume: Number(r.volume),
    }
    const list = out.get(r.symbolId)
    if (list) list.push(bar)
    else out.set(r.symbolId, [bar])
  }
  return out
}

export async function eventsBatch(
  symbolIds: readonly string[], from: Date, to: Date,
): Promise<Map<string, (typeof t.marketEvents.$inferSelect)[]>> {
  const out = new Map<string, (typeof t.marketEvents.$inferSelect)[]>()
  if (symbolIds.length === 0) return out
  const rows = await db.select().from(t.marketEvents)
    .where(and(
      inArray(t.marketEvents.symbolId, [...symbolIds]),
      gt(t.marketEvents.publishedAt, from),
      lte(t.marketEvents.publishedAt, to),
    ))
    .orderBy(asc(t.marketEvents.publishedAt))
  for (const r of rows) {
    if (!r.symbolId) continue
    const list = out.get(r.symbolId)
    if (list) list.push(r)
    else out.set(r.symbolId, [r])
  }
  return out
}

export async function corporateActionsBatch(
  symbolIds: readonly string[], from: string, to: string,
): Promise<Map<string, (typeof t.corporateActions.$inferSelect)[]>> {
  const out = new Map<string, (typeof t.corporateActions.$inferSelect)[]>()
  if (symbolIds.length === 0) return out
  const rows = await db.select().from(t.corporateActions)
    .where(and(
      inArray(t.corporateActions.symbolId, [...symbolIds]),
      gte(t.corporateActions.exDate, from),
      lte(t.corporateActions.exDate, to),
    ))
  for (const r of rows) {
    const list = out.get(r.symbolId)
    if (list) list.push(r)
    else out.set(r.symbolId, [r])
  }
  return out
}
