/**
 * NSE market time, in Asia/Kolkata.
 *
 * Holidays are NOT hardcoded. A hardcoded list is wrong the moment the exchange
 * publishes a new calendar, and a wrong list silently produces wrong windows.
 * Instead we derive the trading calendar from the data itself: any weekday for
 * which the benchmark has no bar was not a trading day. That is empirical,
 * self-maintaining, and cannot drift from reality. See DECISIONS.md #10.
 */

/** Retained for callers that predate multi-market support. */
export const NSE_TZ = 'Asia/Kolkata'
export const SESSION_OPEN_MIN = 9 * 60 + 15
export const SESSION_CLOSE_MIN = 15 * 60 + 30

const formatters = new Map<string, Intl.DateTimeFormat>()
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timeZone)
  if (cached) return cached
  // Intl.DateTimeFormat construction is expensive and this runs per bar.
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
  formatters.set(timeZone, f)
  return f
}

export interface IstParts { date: string; minutes: number; weekday: number }

/** Wall-clock parts of an instant, in IST. */
export function istParts(at: Date, timeZone: string = NSE_TZ): IstParts {
  const parts = formatterFor(timeZone).formatToParts(at)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00'
  const date = `${get('year')}-${get('month')}-${get('day')}`
  let hour = Number(get('hour'))
  if (hour === 24) hour = 0
  const minutes = hour * 60 + Number(get('minute'))
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
  return { date, minutes, weekday }
}

/** IST calendar date (YYYY-MM-DD) of an instant. */
export function istDate(at: Date, timeZone: string = NSE_TZ): string {
  return istParts(at, timeZone).date
}

/** A trading calendar derived from which dates the benchmark actually traded. */
export class TradingCalendar {
  private readonly sessions: string[]
  private readonly set: Set<string>
  private readonly tz: string
  private readonly openMin: number
  private readonly closeMin: number

  constructor(
    sessionDates: readonly string[],
    market?: { timeZone: string; openMinute: number; closeMinute: number },
  ) {
    this.sessions = [...new Set(sessionDates)].sort()
    this.set = new Set(this.sessions)
    this.tz = market?.timeZone ?? NSE_TZ
    this.openMin = market?.openMinute ?? SESSION_OPEN_MIN
    this.closeMin = market?.closeMinute ?? SESSION_CLOSE_MIN
  }

  isSession(date: string): boolean { return this.set.has(date) }

  /** True while the exchange is open on a real trading day. */
  isOpen(at: Date): boolean {
    const { date, minutes } = istParts(at, this.tz)
    if (!this.isSession(date)) return false
    return minutes >= this.openMin && minutes <= this.closeMin
  }

  /** The most recent session date on or before `date`. */
  sessionOnOrBefore(date: string): string | null {
    let lo = 0
    let hi = this.sessions.length - 1
    let best: string | null = null
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const v = this.sessions[mid]!
      if (v <= date) { best = v; lo = mid + 1 } else { hi = mid - 1 }
    }
    return best
  }

  /** Number of trading sessions in (start, end]. Minimum 1 so sigma never divides by zero. */
  sessionsBetween(start: Date, end: Date): number {
    const a = istDate(start, this.tz)
    const b = istDate(end, this.tz)
    if (b <= a) return 1
    let n = 0
    for (const s of this.sessions) {
      if (s > a && s <= b) n++
      if (s > b) break
    }
    return Math.max(1, n)
  }

  /** Instant of the most recent session close at or before `at`. */
  lastSessionCloseAt(at: Date): Date | null {
    const { date, minutes } = istParts(at, this.tz)
    const candidate = minutes >= this.closeMin && this.isSession(date)
      ? date
      : this.sessionOnOrBefore(prevDate(date))
    if (candidate === null) return null
    return this.closeInstant(candidate)
  }

  /** The calendar date of an instant, in this market's timezone. */
  dateOf(at: Date): string {
    return istDate(at, this.tz)
  }

  /** The instant a given session closed, in UTC. */
  closeInstant(date: string): Date {
    return instantAtLocalMinute(date, this.closeMin, this.tz)
  }

  get allSessions(): readonly string[] { return this.sessions }
}

function prevDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/** Human phrasing for how long the user was away. */
export function humanDuration(ms: number): string {
  if (ms < 60_000) return 'moments'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  const rem = mins % 60
  if (hours < 24) return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const hrem = hours % 24
  if (days < 7) return hrem > 0 ? `${days}d ${hrem}h` : `${days}d`
  return `${days}d`
}

/**
 * The UTC instant whose local time on `date` is `minute` past midnight in `timeZone`.
 *
 * Walked in fifteen-minute steps rather than computed from a fixed offset, so
 * DST is handled and this works for any exchange. Shared deliberately: the same
 * calculation is needed by the session calendar, by the ingest when it stamps
 * an observation with the close it belongs to, and by the demo reset. It was
 * previously open-coded in each, and two of those copies had `10:00Z` — the
 * NSE close — burned in, which silently mis-stamped every US observation by ten
 * hours and made the quality gate treat every closing price as decaying data.
 */
export function instantAtLocalMinute(date: string, minute: number, timeZone: string): Date {
  const base = Date.parse(`${date}T00:00:00.000Z`)
  for (let step = 0; step < 96; step++) {
    const candidate = new Date(base + step * 15 * 60_000)
    const p = istParts(candidate, timeZone)
    if (p.date === date && p.minutes >= minute) return candidate
  }
  return new Date(base + 20 * 3600_000)
}
