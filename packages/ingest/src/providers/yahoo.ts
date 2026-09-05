import yahooFinance from 'yahoo-finance2'
import type { DailyBar, IntradayBar } from '@since/core'
import type { MarketDataProvider, CorporateActionRecord, MarketEventRecord } from '../provider.js'
import { Throttle, withRetry } from '../throttle.js'

yahooFinance.suppressNotices(['yahooSurvey', 'ripHistorical'])

/**
 * Real NSE market data via Yahoo Finance.
 *
 * Documented limitations, because they shape the architecture rather than being
 * hidden by it:
 *   - Unofficial endpoint. It can rate-limit or change shape without notice, so
 *     ingestion is a ONE-SHOT CLI that writes to Postgres. Nothing on the request
 *     path ever calls Yahoo; a demo cannot be broken by their availability.
 *   - Intraday history is capped at roughly 60 days for 5-minute bars.
 *   - It is a single source, so genuine cross-provider conflict cannot be
 *     observed from real data. Conflict handling is exercised by injected faults
 *     instead, and labelled as such.
 *   - Corporate actions are best-effort; the raw/adjusted close divergence check
 *     in @since/core is the real defence and does not depend on this feed.
 */
export class YahooProvider implements MarketDataProvider {
  readonly source = 'yahoo'
  readonly isSimulated = false

  private readonly throttle: Throttle
  /** Per-symbol memo: one chart call serves bars, actions and events. */
  private readonly cache = new Map<string, Promise<ChartResult | null>>()

  constructor(private readonly opts: { timeoutMs?: number; minGapMs?: number } = {}) {
    this.throttle = new Throttle(opts.minGapMs ?? 900)
  }

  async dailyBars(symbolId: string, fromDate: string, toDate: string): Promise<DailyBar[]> {
    const res = await this.chart(symbolId, fromDate, toDate, '1d')
    if (!res) return []
    const out: DailyBar[] = []
    for (const q of res.quotes ?? []) {
      const date = toIsoDate(q.date)
      if (!date) continue
      const close = num(q.close)
      const adj = num((q as { adjclose?: number | null }).adjclose) ?? close
      const open = num(q.open)
      const high = num(q.high)
      const low = num(q.low)
      // A bar missing any price is dropped rather than filled. A filled bar is a
      // lie that ends up inside a volatility estimate.
      if (close === null || adj === null || open === null || high === null || low === null) continue
      out.push({ date, open, high, low, close, adjClose: adj, volume: num(q.volume) ?? 0 })
    }
    return out
  }

  async intradayBars(symbolId: string, fromDate: string, toDate: string): Promise<IntradayBar[]> {
    const res = await this.chart(symbolId, fromDate, toDate, '5m')
    if (!res) return []
    const out: IntradayBar[] = []
    for (const q of res.quotes ?? []) {
      const ts = q.date instanceof Date ? q.date : new Date(q.date as string)
      if (Number.isNaN(ts.getTime())) continue
      const close = num(q.close)
      const open = num(q.open)
      const high = num(q.high)
      const low = num(q.low)
      if (close === null || open === null || high === null || low === null) continue
      out.push({ ts, open, high, low, close, volume: num(q.volume) ?? 0 })
    }
    return out
  }

  async corporateActions(symbolId: string, fromDate: string, toDate: string): Promise<CorporateActionRecord[]> {
    const res = await this.chart(symbolId, fromDate, toDate, '1d')
    const events = res?.events
    if (!events) return []
    const out: CorporateActionRecord[] = []

    for (const s of Object.values(events.splits ?? {}) as YahooSplit[]) {
      const date = toIsoDate(s.date)
      if (!date) continue
      const denom = num(s.denominator) ?? 1
      const numer = num(s.numerator) ?? 1
      out.push({
        symbolId, exDate: date, type: 'SPLIT',
        ratio: denom !== 0 ? numer / denom : null,
        notes: s.splitRatio ?? null,
      })
    }
    for (const d of Object.values(events.dividends ?? {}) as YahooDividend[]) {
      const date = toIsoDate(d.date)
      if (!date) continue
      out.push({
        symbolId, exDate: date, type: 'DIVIDEND',
        ratio: num(d.amount), notes: null,
      })
    }
    return out
  }

  /**
   * Yahoo exposes no reliable per-symbol news feed through this endpoint, so
   * corporate actions are promoted to events and nothing is invented. When the
   * agent finds no event it must say so — that path is real, not decorative.
   */
  async marketEvents(symbolId: string, fromDate: string, toDate: string): Promise<MarketEventRecord[]> {
    const actions = await this.corporateActions(symbolId, fromDate, toDate)
    return actions.map((a) => ({
      symbolId,
      publishedAt: new Date(`${a.exDate}T03:45:00.000Z`),
      type: a.type,
      headline: a.type === 'SPLIT'
        ? `Stock split${a.notes ? ` (${a.notes})` : ''} effective ${a.exDate}`
        : `Dividend ex-date ${a.exDate}${a.ratio ? ` — ₹${a.ratio}` : ''}`,
      url: null,
      source: 'yahoo-corporate-actions',
    }))
  }

  private async chart(
    symbolId: string, fromDate: string, toDate: string, interval: '1d' | '5m',
  ): Promise<ChartResult | null> {
    const key = `${symbolId}|${fromDate}|${toDate}|${interval}`
    const existing = this.cache.get(key)
    if (existing) return existing

    const p = withRetry(
      () => this.throttle.run(() => withTimeout(
        yahooFinance.chart(symbolId, {
          period1: fromDate, period2: toDate, interval, events: 'div|split',
        }) as Promise<ChartResult>,
        this.opts.timeoutMs ?? 25_000,
      )),
      { attempts: 4, baseMs: 2500, label: symbolId },
    ).catch((err: unknown) => {
      // A failed symbol must not fail the run. The caller records the gap and
      // the product degrades for that symbol only.
      console.log(`[ingest]   ${symbolId} ${interval}: ${(err as Error).message.slice(0, 90)}`)
      return null
    })

    this.cache.set(key, p)
    return p
  }
}

type ChartResult = Awaited<ReturnType<typeof yahooFinance.chart>>

interface YahooSplit { date?: unknown; numerator?: unknown; denominator?: unknown; splitRatio?: string | null }
interface YahooDividend { date?: unknown; amount?: unknown }

function num(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.round(v * 10000) / 10000
}

function toIsoDate(v: unknown): string | null {
  const d = v instanceof Date ? v : typeof v === 'string' || typeof v === 'number' ? new Date(v) : null
  if (!d || Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error('provider timeout')), ms)),
  ])
}
