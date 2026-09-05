import type { DailyBar, IntradayBar } from '@since/core'
import type { MarketDataProvider, CorporateActionRecord, MarketEventRecord } from '../provider.js'
import { Throttle, withRetry } from '../throttle.js'

/**
 * Real NSE data via Twelve Data.
 *
 * Exists because Yahoo rate-limited entire Indian mobile carrier ranges, NSE's
 * own site blocks non-browser traffic at the edge, and the remaining free
 * sources sit behind bot challenges. Twelve Data is reachable, covers NSE, and
 * asks only for a free key.
 *
 * Documented limits of the free tier, which shape the code:
 *   - 8 requests/minute, 800/day. The throttle is set to 8s between calls, so a
 *     51-symbol universe takes roughly 7 minutes rather than getting banned.
 *   - No intraday history beyond a short window, so replay depth is thinner
 *     than with a paid feed. Ingestion asks for what it can get and carries on.
 *   - No corporate actions endpoint on the free tier. That is not fatal: the
 *     raw-vs-adjusted divergence check in @since/core is the real defence and
 *     does not depend on the provider telling us.
 */
export class TwelveDataProvider implements MarketDataProvider {
  readonly source = 'twelvedata'
  readonly isSimulated = false

  private readonly throttle: Throttle
  private readonly base = 'https://api.twelvedata.com'

  /** Exchange timezone. Twelve Data returns intraday stamps in local time. */
  private readonly timeZone: string

  constructor(private readonly apiKey: string, opts: { minGapMs?: number; timeZone?: string } = {}) {
    if (!apiKey) throw new Error('TWELVEDATA_API_KEY is required for the twelvedata provider')
    this.timeZone = opts.timeZone ?? 'America/New_York'
    // Free tier is 8 req/min. 8s spacing keeps us just inside it.
    this.throttle = new Throttle(opts.minGapMs ?? 8000)
  }

  async dailyBars(symbolId: string, fromDate: string, toDate: string): Promise<DailyBar[]> {
    const rows = await this.series(symbolId, '1day', fromDate, toDate)
    return rows.map((r) => ({
      date: r.datetime.slice(0, 10),
      open: r.open, high: r.high, low: r.low, close: r.close,
      // The free tier returns unadjusted closes only. Setting adjClose = close
      // makes the divergence check inert rather than wrong — a split would then
      // be caught by the implausible-move rule instead. Documented, not hidden.
      adjClose: r.close,
      volume: r.volume,
    }))
  }

  async intradayBars(symbolId: string, fromDate: string, toDate: string): Promise<IntradayBar[]> {
    const rows = await this.series(symbolId, '5min', fromDate, toDate)
    return rows.map((r) => ({
      ts: zonedToUtc(r.datetime, this.timeZone),
      open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume,
    }))
  }

  /** Not on the free tier. Returning nothing is correct; inventing rows is not. */
  async corporateActions(): Promise<CorporateActionRecord[]> { return [] }
  async marketEvents(): Promise<MarketEventRecord[]> { return [] }

  private async series(
    symbolId: string, interval: '1day' | '5min', fromDate: string, toDate: string,
  ): Promise<{ datetime: string; open: number; high: number; low: number; close: number; volume: number }[]> {
    const { symbol, exchange } = mapSymbol(symbolId)
    const url = new URL('/time_series', this.base)
    url.searchParams.set('symbol', symbol)
    if (exchange) url.searchParams.set('exchange', exchange)
    url.searchParams.set('interval', interval)
    url.searchParams.set('start_date', fromDate)
    url.searchParams.set('end_date', toDate)
    url.searchParams.set('outputsize', '5000')
    url.searchParams.set('order', 'ASC')
    url.searchParams.set('apikey', this.apiKey)

    try {
      const body = await withRetry(
        () => this.throttle.run(async () => {
          const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
          const json = await res.json() as TwelveDataResponse
          // Errors arrive as HTTP 200 with a status field, so checking res.ok
          // alone would silently treat a rate-limit message as empty history.
          if (json.status === 'error' || json.code) {
            const msg = `${json.code ?? ''} ${json.message ?? 'unknown error'}`.trim()
            throw new Error(msg.includes('429') || /limit/i.test(msg) ? `429 ${msg}` : msg)
          }
          return json
        }),
        { attempts: 3, baseMs: 12_000, label: `${symbol} ${interval}` },
      )

      return (body.values ?? [])
        .map((v) => ({
          datetime: v.datetime,
          open: num(v.open), high: num(v.high), low: num(v.low), close: num(v.close),
          volume: Math.round(num(v.volume)),
        }))
        .filter((v) => [v.open, v.high, v.low, v.close].every(Number.isFinite))
    } catch (err) {
      console.log(`[ingest]   ${symbol} ${interval}: ${(err as Error).message.slice(0, 110)}`)
      return []
    }
  }
}

interface TwelveDataResponse {
  status?: string
  code?: number
  message?: string
  values?: { datetime: string; open: string; high: string; low: string; close: string; volume: string }[]
}

/**
 * Our ids are Yahoo-shaped (`TICKER.NS`, `^NSEI`). Twelve Data wants a bare
 * ticker plus an exchange, and names the index differently.
 */
export function mapSymbol(symbolId: string): { symbol: string; exchange: string | null } {
  if (symbolId === '^NSEI') return { symbol: 'NIFTY 50', exchange: 'NSE' }
  if (symbolId === '^NSEBANK') return { symbol: 'NIFTY BANK', exchange: 'NSE' }
  // NSE ids carry a .NS suffix; anything else is a US ticker, which the free
  // tier serves without an exchange qualifier.
  if (symbolId.endsWith('.NS')) return { symbol: symbolId.slice(0, -3), exchange: 'NSE' }
  return { symbol: symbolId, exchange: null }
}

/**
 * Interpret an exchange-local timestamp in a given zone, as UTC.
 *
 * Twelve Data returns intraday stamps in the exchange's own local time with no
 * offset. A hardcoded +05:30 was fine while the only market was the NSE and
 * silently shifted every US bar by nine and a half hours — into the small hours
 * of the wrong day, where the scoring engine found no session at all.
 *
 * Formatting the instant back out in the target zone recovers the true offset,
 * which means DST is handled without a table.
 */
export function zonedToUtc(local: string, timeZone: string): Date {
  const iso = local.replace(' ', 'T') + (local.length <= 16 ? ':00' : '')
  const asIfUtc = Date.parse(`${iso}Z`)
  if (Number.isNaN(asIfUtc)) return new Date(local)

  // What local time does that instant actually show in the zone?
  const shown = new Date(asIfUtc).toLocaleString('sv-SE', { timeZone })
  const shownMs = Date.parse(`${shown.replace(' ', 'T')}Z`)
  if (Number.isNaN(shownMs)) return new Date(asIfUtc)

  return new Date(asIfUtc + (asIfUtc - shownMs))
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : NaN
}
