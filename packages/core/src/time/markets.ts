/**
 * Market definitions.
 *
 * Session hours, timezone and currency were hardcoded to the NSE because that
 * was the only market. They are properties of a market, not of the product, and
 * the scoring engine never cared which one it was looking at — so they move
 * here rather than becoming conditionals scattered through the code.
 *
 * Holidays are still NOT listed. The trading calendar is derived from the dates
 * the benchmark actually traded, which works for any exchange without anyone
 * maintaining a list that goes stale. See DECISIONS.md #10.
 */
export interface MarketDef {
  id: 'nifty50' | 'us'
  /** Shown to a reader, e.g. "NSE". */
  label: string
  timeZone: string
  /** Minutes past midnight, in the market's own timezone. */
  openMinute: number
  closeMinute: number
  benchmarkId: string
  benchmarkLabel: string
  currency: 'INR' | 'USD'
  /** Locale used to format money and timestamps for this market. */
  locale: string
}

export const MARKETS: Record<MarketDef['id'], MarketDef> = {
  nifty50: {
    id: 'nifty50',
    label: 'NSE',
    timeZone: 'Asia/Kolkata',
    openMinute: 9 * 60 + 15,     // 09:15 IST
    closeMinute: 15 * 60 + 30,   // 15:30 IST
    benchmarkId: '^NSEI',
    benchmarkLabel: 'NIFTY 50',
    currency: 'INR',
    locale: 'en-IN',
  },
  us: {
    id: 'us',
    label: 'US',
    timeZone: 'America/New_York',
    openMinute: 9 * 60 + 30,     // 09:30 ET
    closeMinute: 16 * 60,        // 16:00 ET
    benchmarkId: 'SPY',
    benchmarkLabel: 'S&P 500 ETF',
    currency: 'USD',
    locale: 'en-US',
  },
}

export const DEFAULT_MARKET: MarketDef['id'] = 'us'

export function marketFor(id: string | undefined | null): MarketDef {
  return MARKETS[(id as MarketDef['id']) in MARKETS ? (id as MarketDef['id']) : DEFAULT_MARKET]
}
