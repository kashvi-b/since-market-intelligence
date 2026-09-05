import type { TradingCalendar } from '../time/market.js'
import { humanDuration, istDate } from '../time/market.js'

export interface DiffWindow {
  windowStart: Date
  windowEnd: Date
  /** Trading sessions spanned. Used to scale the residual sigma. */
  sessions: number
  isFirstVisit: boolean
  awayMs: number
  awayLabel: string
  /** True when `at` precedes the cursor — a deliberate look at a past moment. */
  isReplay: boolean
}

/**
 * A cursor slightly ahead of `at` is clock skew between devices. A cursor well
 * ahead means the user has deliberately travelled back. The two need different
 * handling and this is the line between them.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000

/**
 * Turn a read cursor into the window we diff against.
 *
 * The window is the user's, not the market's. If they last looked at 10:14 this
 * morning the window is 10:14 -> now; if they last looked on Friday it spans the
 * weekend. Everything downstream — sigma scaling, cumulative signals, replay —
 * is expressed in terms of this window rather than "today".
 */
export function resolveWindow(params: {
  lastSeenAt: Date | null
  at: Date
  calendar: TradingCalendar
  /** How far back to look for someone who has never opened the app. */
  firstVisitSessions?: number
}): DiffWindow {
  const { lastSeenAt, at, calendar } = params
  const firstVisitSessions = params.firstVisitSessions ?? 1

  if (lastSeenAt === null) {
    // A first visit has no "before". We show the most recent completed session
    // so the product has something honest to say, and label it as such.
    const sessions = calendar.allSessions
    const idx = Math.max(0, sessions.length - 1 - firstVisitSessions)
    const startDate = sessions[idx] ?? sessions[0]
    // The calendar knows when that session actually closed; a literal here
    // would be the NSE bell, which is the middle of the night in New York.
    const windowStart = startDate ? calendar.closeInstant(startDate) : at
    return {
      windowStart,
      windowEnd: at,
      sessions: Math.max(1, calendar.sessionsBetween(windowStart, at)),
      isFirstVisit: true,
      awayMs: at.getTime() - windowStart.getTime(),
      awayLabel: 'your first look',
      isReplay: false,
    }
  }

  const ahead = lastSeenAt.getTime() - at.getTime()

  // Travelling back past the cursor. Clamping to `at` would produce a zero-width
  // window and an empty brief, which looks like a broken feature rather than a
  // deliberate one. Show the session leading up to that moment instead.
  if (ahead > CLOCK_SKEW_TOLERANCE_MS) {
    const sessions = calendar.allSessions
    const day = calendar.dateOf(at)
    let idx = sessions.findIndex((d) => d >= day)
    if (idx < 0) idx = sessions.length - 1
    const startDate = sessions[Math.max(0, idx - firstVisitSessions)] ?? sessions[0]
    // Same reasoning as the first-visit branch above, which was fixed and this
    // one was not: 04:44Z is mid-morning in Mumbai and 00:44 in New York, hours
    // before any US session, so replay opened on a window with no bars in it.
    const windowStart = startDate ? calendar.closeInstant(startDate) : at
    const awayMs = Math.max(0, at.getTime() - windowStart.getTime())
    return {
      windowStart,
      windowEnd: at,
      sessions: Math.max(1, calendar.sessionsBetween(windowStart, at)),
      isFirstVisit: false,
      awayMs,
      awayLabel: humanDuration(awayMs),
      isReplay: true,
    }
  }

  // Genuine clock skew: clamp so the window can never invert.
  const start = lastSeenAt.getTime() > at.getTime() ? at : lastSeenAt
  const awayMs = Math.max(0, at.getTime() - start.getTime())

  return {
    windowStart: start,
    windowEnd: at,
    sessions: calendar.sessionsBetween(start, at),
    isFirstVisit: false,
    awayMs,
    awayLabel: humanDuration(awayMs),
    isReplay: false,
  }
}
