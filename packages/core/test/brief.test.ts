import { describe, it, expect } from 'vitest'
import { composeBrief } from '../src/brief/compose.js'
import { resolveWindow } from '../src/diff/window.js'
import { TradingCalendar } from '../src/time/market.js'
import type { ScoreResult } from '../src/types.js'

const SESSIONS = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14']
const cal = new TradingCalendar(SESSIONS)

const win = resolveWindow({
  lastSeenAt: new Date('2026-08-14T04:44:00Z'),
  at: new Date('2026-08-14T10:12:00Z'),
  calendar: cal,
})

function res(id: string, pctl: number, returnPct: number, over: Partial<ScoreResult> = {}): ScoreResult {
  return {
    symbolId: id, raw: pctl / 20, pctl,
    tier: pctl >= 99 ? 'CRITICAL' : pctl >= 95 ? 'SIGNIFICANT' : pctl >= 90 ? 'WORTH_WATCHING' : 'NORMAL',
    contributions: [], quality: 'FRESH', qualityReason: 'Live',
    returnPct, expectedPct: 0, residualPct: returnPct, residualZ: returnPct / 2,
    degraded: null, ...over,
  }
}

const noSector = () => null
const sectorOf = (id: string) =>
  id.startsWith('BANK') ? { id: 'FIN', name: 'Financials' } : { id: 'IT', name: 'Technology' }

describe('the Brief', () => {
  it('caps output no matter how much the market did', () => {
    const scored = Array.from({ length: 40 }, (_, i) => res(`S${i}.NS`, 99.9, -8))
    const b = composeBrief({
      scored, window: win, budget: 'MEDIUM', cap: 3,
      indexReturn: null, indexSigma: null, sectorOf: noSector,
    })
    expect(b.cards).toHaveLength(3)          // hard cap holds under a crash
    expect(b.attentionCount).toBe(3)
    expect(b.filteredCount).toBe(37)
  })

  it('counts what it deliberately hid — the product\'s proudest number', () => {
    const scored = [res('A.NS', 99, -7), ...Array.from({ length: 27 }, (_, i) => res(`N${i}.NS`, 40, -0.4))]
    const b = composeBrief({
      scored, window: win, budget: 'MEDIUM', cap: 3,
      indexReturn: null, indexSigma: null, sectorOf: noSector,
    })
    expect(b.attentionCount).toBe(1)
    expect(b.filteredCount).toBe(27)
    expect(b.changedCount).toBe(28)
  })

  it('says nothing happened when nothing happened', () => {
    const scored = Array.from({ length: 20 }, (_, i) => res(`N${i}.NS`, 30, -0.2))
    const b = composeBrief({
      scored, window: win, budget: 'MEDIUM', cap: 3,
      indexReturn: null, indexSigma: null, sectorOf: noSector,
    })
    expect(b.cards).toHaveLength(0)
    expect(b.filteredCount).toBe(20)
  })

  it('detects a market-wide regime and names it', () => {
    const scored = Array.from({ length: 20 }, (_, i) => res(`N${i}.NS`, 40, -2.1))
    const b = composeBrief({
      scored, window: win, budget: 'MEDIUM', cap: 3,
      indexReturn: -0.021, indexSigma: 0.005, sectorOf: noSector,
    })
    expect(b.regime).not.toBeNull()
    expect(b.regime!.headline).toMatch(/about the market, not your stocks/)
    expect(b.regime!.breadth).toBeGreaterThan(0.8)
  })

  it('reports exact counts, so the headline arithmetic cannot lie', () => {
    // Regression: the hero once read "28 of your 30 stocks fell with it. Three
    // didn't" — where "three" was the number of CARDS SHOWN, not 30 - 28. Two
    // different quantities spliced into one sentence. The counts must be exact
    // and internally consistent, and callers must never re-derive them from the
    // breadth ratio.
    const scored = [
      ...Array.from({ length: 28 }, (_, i) => res(`D${i}.NS`, 40, -2.1)),
      res('U1.NS', 97, +1.2),
      res('U2.NS', 96, +0.8),
    ]
    const b = composeBrief({
      scored, window: win, budget: 'MEDIUM', cap: 3,
      indexReturn: -0.021, indexSigma: 0.005, sectorOf: noSector,
    })
    expect(b.regime).not.toBeNull()
    expect(b.regime!.withMarket).toBe(28)
    expect(b.regime!.movedTotal).toBe(30)
    // The count that bucked the market is arithmetic, not the card count.
    expect(b.regime!.movedTotal - b.regime!.withMarket).toBe(2)
    expect(b.regime!.breadth).toBeCloseTo(28 / 30, 10)
  })

  it('does not call an ordinary day a regime', () => {
    const scored = Array.from({ length: 20 }, (_, i) => res(`N${i}.NS`, 40, i < 10 ? 0.3 : -0.3))
    const b = composeBrief({
      scored, window: win, budget: 'MEDIUM', cap: 3,
      indexReturn: -0.001, indexSigma: 0.005, sectorOf: noSector,
    })
    expect(b.regime).toBeNull()
  })

  it('collapses same-sector, same-direction moves into one story', () => {
    const scored = [
      res('BANK1.NS', 97, -4), res('BANK2.NS', 96, -3.8),
      res('BANK3.NS', 96, -3.5), res('IT1.NS', 98, +5),
    ]
    const b = composeBrief({
      scored, window: win, budget: 'MEDIUM', cap: 5,
      indexReturn: null, indexSigma: null, sectorOf,
    })
    const grouped = b.cards.find((c) => c.group)
    expect(grouped).toBeDefined()
    expect(grouped!.group!.members).toHaveLength(3)
    expect(grouped!.group!.sectorName).toBe('Financials')
    expect(b.cards).toHaveLength(2)          // one group card + one lone mover
  })

  it('lists suppressed symbols separately and never as attention', () => {
    const scored = [
      res('A.NS', 99, -7, { tier: 'SUPPRESSED', quality: 'STALE', qualityReason: 'Feed stopped' }),
      res('B.NS', 97, -5),
    ]
    const b = composeBrief({
      scored, window: win, budget: 'MEDIUM', cap: 3,
      indexReturn: null, indexSigma: null, sectorOf: noSector,
    })
    expect(b.cards.map((c) => c.symbolId)).toEqual(['B.NS'])
    expect(b.suppressed).toHaveLength(1)
    expect(b.suppressedCount).toBe(1)
  })

  it('ranks deterministically regardless of input order', () => {
    const a = [res('A.NS', 97, -3), res('B.NS', 97, -3), res('C.NS', 99, -5)]
    const opts = {
      window: win, budget: 'MEDIUM' as const, cap: 3,
      indexReturn: null, indexSigma: null, sectorOf: noSector,
    }
    const one = composeBrief({ ...opts, scored: a }).cards.map((c) => c.symbolId)
    const two = composeBrief({ ...opts, scored: [...a].reverse() }).cards.map((c) => c.symbolId)
    expect(one).toEqual(two)
  })
})

describe('diff window', () => {
  it('spans exactly what the user missed', () => {
    expect(win.sessions).toBe(1)
    expect(win.isFirstVisit).toBe(false)
    expect(win.awayLabel).toBe('5h 28m')
  })

  it('counts trading sessions, not calendar days, across a weekend', () => {
    const w = resolveWindow({
      lastSeenAt: new Date('2026-08-10T10:00:00Z'),
      at: new Date('2026-08-14T10:00:00Z'),
      calendar: cal,
    })
    expect(w.sessions).toBe(4)
  })

  it('handles a first visit honestly instead of inventing a baseline', () => {
    const w = resolveWindow({ lastSeenAt: null, at: new Date('2026-08-14T10:00:00Z'), calendar: cal })
    expect(w.isFirstVisit).toBe(true)
    expect(w.awayLabel).toBe('your first look')
  })

  it('travels back to a past moment instead of returning an empty window', () => {
    // Regression: time-travelling to before the cursor collapsed the window to
    // zero width, so replay showed nothing and looked broken.
    const w = resolveWindow({
      lastSeenAt: new Date('2026-08-14T04:44:00Z'),
      at: new Date('2026-08-12T10:00:00Z'),      // two sessions earlier
      calendar: cal,
    })
    expect(w.isReplay).toBe(true)
    expect(w.awayMs).toBeGreaterThan(0)
    expect(w.windowStart.getTime()).toBeLessThan(w.windowEnd.getTime())
    expect(w.sessions).toBeGreaterThanOrEqual(1)
  })

  it('never inverts the window when a device clock runs fast', () => {
    const w = resolveWindow({
      lastSeenAt: new Date('2026-08-14T10:02:00Z'),   // 2 min of skew, not travel
      at: new Date('2026-08-14T10:00:00Z'),
      calendar: cal,
    })
    expect(w.isReplay).toBe(false)
    expect(w.awayMs).toBe(0)
    expect(w.windowStart.getTime()).toBeLessThanOrEqual(w.windowEnd.getTime())
  })
})

describe('trading calendar is derived from data, not hardcoded', () => {
  it('knows sessions from the benchmark bars it was given', () => {
    expect(cal.isSession('2026-08-14')).toBe(true)
    expect(cal.isSession('2026-08-15')).toBe(false)   // absent => not a trading day
  })

  it('is open only inside session hours on a session day', () => {
    expect(cal.isOpen(new Date('2026-08-14T06:00:00Z'))).toBe(true)    // 11:30 IST
    expect(cal.isOpen(new Date('2026-08-14T03:00:00Z'))).toBe(false)   // 08:30 IST
    expect(cal.isOpen(new Date('2026-08-14T12:00:00Z'))).toBe(false)   // 17:30 IST
    expect(cal.isOpen(new Date('2026-08-15T06:00:00Z'))).toBe(false)   // not a session
  })

  it('finds the previous session for a non-trading date', () => {
    expect(cal.sessionOnOrBefore('2026-08-16')).toBe('2026-08-14')
  })
})
