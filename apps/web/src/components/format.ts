export const pct = (v: number | null | undefined, dp = 1) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(dp)}%`

/**
 * Money, in whatever currency the market actually trades in.
 *
 * Defaults keep every existing call site working; the market the API reports is
 * threaded through where it matters. Printing dollars with a rupee sign would be
 * a small lie of exactly the kind this product exists to avoid.
 */
export interface MarketFormat { currency?: string; locale?: string; timeZone?: string }

export const money = (v: number | null | undefined, m: MarketFormat = {}) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  const currency = m.currency ?? 'INR'
  const locale = m.locale ?? (currency === 'USD' ? 'en-US' : 'en-IN')
  const symbol = currency === 'USD' ? '$' : '₹'
  return `${symbol}${v.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Retained so existing call sites keep working. */
export const rupees = (v: number | null | undefined) => money(v, { currency: 'INR' })

export const sigma = (v: number | null | undefined, dp = 1) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : `${Math.abs(v).toFixed(dp)}σ`

export function ago(iso: string | null | undefined): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'just now'
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** Times are rendered in the market's own timezone, not the reader's. */
export const timeIST = (iso: string, m: MarketFormat = {}) =>
  new Date(iso).toLocaleTimeString(m.locale ?? 'en-IN', {
    timeZone: m.timeZone ?? 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true,
  })

export const dateIST = (iso: string, m: MarketFormat = {}) =>
  new Date(iso).toLocaleDateString(m.locale ?? 'en-IN', {
    timeZone: m.timeZone ?? 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric',
  })
