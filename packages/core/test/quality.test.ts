import { describe, it, expect } from 'vitest'
import { assessFreshness, assessConflict, suppresses, combine } from '../src/quality/gate.js'
import { detectSuspectBar, isOutOfOrder, isBadTick } from '../src/quality/sanity.js'

const at = (iso: string) => new Date(iso)

describe('freshness is relative to the market, not the wall clock', () => {
  it('a 2-minute-old price during market hours is fresh', () => {
    const r = assessFreshness({
      observedAt: at('2026-08-14T06:00:00Z'),   // 11:30 IST
      evaluatedAt: at('2026-08-14T06:02:00Z'),
      marketIsOpen: true,
      lastSessionCloseAt: null,
    })
    expect(r.quality).toBe('FRESH')
  })

  it('a 40-minute-old price during market hours is stale — the feed has stopped', () => {
    const r = assessFreshness({
      observedAt: at('2026-08-14T06:00:00Z'),
      evaluatedAt: at('2026-08-14T06:40:00Z'),
      marketIsOpen: true,
      lastSessionCloseAt: null,
    })
    expect(r.quality).toBe('STALE')
    expect(suppresses(r.quality)).toBe(true)
  })

  it('the same age after the close is FRESH, because it is the closing price', () => {
    // 15:30 IST close; evaluated at 21:00 IST. The price is 5.5h old and correct.
    const r = assessFreshness({
      observedAt: at('2026-08-14T10:00:00Z'),
      evaluatedAt: at('2026-08-14T15:30:00Z'),
      marketIsOpen: false,
      lastSessionCloseAt: at('2026-08-14T10:00:00Z'),
    })
    expect(r.quality).toBe('FRESH')
    expect(r.reason).toBe('Closing price')
  })

  it('missing observation is UNAVAILABLE, not zero', () => {
    const r = assessFreshness({
      observedAt: null, evaluatedAt: at('2026-08-14T06:00:00Z'),
      marketIsOpen: true, lastSessionCloseAt: null,
    })
    expect(r.quality).toBe('UNAVAILABLE')
  })

  it('a future-dated tick is SUSPECT, never trusted', () => {
    const r = assessFreshness({
      observedAt: at('2026-08-14T07:00:00Z'),
      evaluatedAt: at('2026-08-14T06:00:00Z'),
      marketIsOpen: true, lastSessionCloseAt: null,
    })
    expect(r.quality).toBe('SUSPECT')
  })
})

describe('conflicting sources', () => {
  it('flags disagreement beyond tolerance and never averages it away', () => {
    const r = assessConflict([
      { source: 'a', price: 181.20, observedAt: at('2026-08-14T06:00:00Z') },
      { source: 'b', price: 175.00, observedAt: at('2026-08-14T05:56:00Z') },
    ])
    expect(r.conflicting).toBe(true)
    expect(r.chosen!.source).toBe('a')     // freshest wins, deterministically
  })

  it('accepts agreement within tolerance', () => {
    const r = assessConflict([
      { source: 'a', price: 181.20, observedAt: at('2026-08-14T06:00:00Z') },
      { source: 'b', price: 180.96, observedAt: at('2026-08-14T05:56:00Z') },
    ])
    expect(r.conflicting).toBe(false)
  })

  it('breaks equal-timestamp ties by source name so the choice is reproducible', () => {
    const ts = at('2026-08-14T06:00:00Z')
    const a = assessConflict([
      { source: 'zeta', price: 100, observedAt: ts },
      { source: 'alpha', price: 100, observedAt: ts },
    ])
    const b = assessConflict([
      { source: 'alpha', price: 100, observedAt: ts },
      { source: 'zeta', price: 100, observedAt: ts },
    ])
    expect(a.chosen!.source).toBe(b.chosen!.source)
  })
})

describe('corporate actions and bad ticks', () => {
  it('a 1:2 split is detected as an artefact, not a 50% crash', () => {
    // Raw close halves; adjusted close does not. That divergence IS the split.
    const r = detectSuspectBar({
      close: 500, prevClose: 1000,
      adjClose: 500, prevAdjClose: 500,
      indexReturn: 0.001,
    })
    expect(r.suspect).toBe(true)
    expect(r.reason).toMatch(/corporate action/i)
    expect(r.impliedRatio).toBeCloseTo(0.5, 2)
  })

  it('an ordinary -3% day is not suspect', () => {
    const r = detectSuspectBar({
      close: 970, prevClose: 1000,
      adjClose: 970, prevAdjClose: 1000,
      indexReturn: -0.01,
    })
    expect(r.suspect).toBe(false)
  })

  it('an implausible move unexplained by the market is quarantined', () => {
    const r = detectSuspectBar({
      close: 400, prevClose: 1000,
      adjClose: 400, prevAdjClose: 1000,
      indexReturn: 0.002,
    })
    expect(r.suspect).toBe(true)
    expect(r.reason).toMatch(/implausible/i)
  })

  it('non-positive prices are rejected outright', () => {
    expect(detectSuspectBar({ close: 0, prevClose: 10, adjClose: 0, prevAdjClose: 10 }).suspect).toBe(true)
  })

  it('out-of-order ticks are identified so they cannot overwrite newer data', () => {
    const latest = at('2026-08-14T06:05:00Z')
    expect(isOutOfOrder(at('2026-08-14T06:00:00Z'), latest)).toBe(true)
    expect(isOutOfOrder(at('2026-08-14T06:10:00Z'), latest)).toBe(false)
    expect(isOutOfOrder(at('2026-08-14T06:00:00Z'), null)).toBe(false)
  })

  it('a tick far outside the recent band is rejected before it reaches the statistics', () => {
    expect(isBadTick(5000, 1000, 10)).toBe(true)
    expect(isBadTick(1005, 1000, 10)).toBe(false)
  })
})

describe('quality precedence', () => {
  it('SUSPECT beats CONFLICTING beats staleness — actively wrong is worse than merely old', () => {
    const stale = { quality: 'STALE' as const, reason: 'old', ageMs: 1 }
    const r = combine(stale, { conflicting: true, reason: 'c' }, { suspect: true, reason: 'split' }, ['a'])
    expect(r.quality).toBe('SUSPECT')
    const r2 = combine(stale, { conflicting: true, reason: 'c' }, { suspect: false, reason: '' }, ['a'])
    expect(r2.quality).toBe('CONFLICTING')
  })
})

/**
 * A closing price must not rot while the market is shut.
 *
 * The gate already reasoned in market time, but the ingest stamped every
 * observation with the NSE close (10:00Z) regardless of exchange. For US
 * symbols that sat ten hours before the real close, so `sinceClose` never fell
 * inside the closing-price window and every price fell through to the
 * wall-clock rule instead — DELAYED for 36 hours, then STALE. Left over a
 * weekend the entire watchlist self-suppressed and the product showed nothing
 * at all, which is the most expensive way possible to be quietly wrong.
 */
describe('a closing price while the market is shut', () => {
  const close = new Date('2026-09-04T20:00:00.000Z')   // 16:00 America/New_York

  const at = (hoursLater: number) => assessFreshness({
    observedAt: close,
    evaluatedAt: new Date(close.getTime() + hoursLater * 3600_000),
    marketIsOpen: false,
    lastSessionCloseAt: close,
  })

  it('is FRESH immediately after the bell', () => {
    expect(at(0.5).quality).toBe('FRESH')
  })

  it('is still FRESH the next morning', () => {
    expect(at(14).quality).toBe('FRESH')
  })

  it('is still FRESH across a whole weekend', () => {
    // The case that mattered: a Friday close read on Monday morning.
    expect(at(62).quality).toBe('FRESH')
    expect(at(62).reason).toBe('Closing price')
  })

  it('still goes STALE when the observation misses the close', () => {
    // Ten hours early — exactly the old NSE-stamped bug. This must NOT be
    // treated as a closing price, or the gate would stop catching dead feeds.
    const early = assessFreshness({
      observedAt: new Date(close.getTime() - 10 * 3600_000),
      evaluatedAt: new Date(close.getTime() + 62 * 3600_000),
      marketIsOpen: false,
      lastSessionCloseAt: close,
    })
    expect(early.quality).toBe('STALE')
  })
})
