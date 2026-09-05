import { describe, it, expect } from 'vitest'
import { buildPercentileGrid, percentileOf, frequencyPhrase, displayPercentile } from '../src/scoring/calibrate.js'
import { tierFor, visibleUnderBudget, BUDGET_THRESHOLD } from '../src/scoring/tier.js'
import { scoreChange } from '../src/scoring/composite.js'
import type { ScoreInput, SymbolStats, QualityAssessment } from '../src/types.js'

const FRESH: QualityAssessment = { quality: 'FRESH', reason: 'Live', ageMs: 1000, sources: ['test'] }

function stats(over: Partial<SymbolStats> = {}): SymbolStats {
  const grid = buildPercentileGrid(
    Array.from({ length: 250 }, (_, i) => (i / 249) * 4),   // raw scores 0..4
  )
  return {
    symbolId: 'TEST.NS', asOf: '2026-08-14',
    beta: 1.0, residMad: 0.012, residMedian: 0,
    // volMad20 is the MAD of LOG volumes (see signals/index.ts).
    volMedian20: 1_000_000, volMad20: 0.35, gapSigma: 0.008,
    high52w: 2000, low52w: 800, pctlGrid: grid, sampleN: 250,
    ...over,
  }
}

function input(over: Partial<ScoreInput> = {}): ScoreInput {
  return {
    symbolId: 'TEST.NS',
    windowStart: new Date('2026-08-14T04:44:00Z'),
    windowEnd: new Date('2026-08-14T10:00:00Z'),
    priceStart: 1000, priceEnd: 1000,
    indexStart: 20000, indexEnd: 20000,
    volume: 1_000_000, prevClose: 1000, sessionOpen: 1000,
    stats: stats(), quality: FRESH, sessions: 1,
    ...over,
  }
}

describe('percentile calibration gives the score a unit', () => {
  it('is monotonic and saturates at both ends', () => {
    const grid = buildPercentileGrid(Array.from({ length: 100 }, (_, i) => i))
    expect(percentileOf(grid, -10)).toBe(0)
    expect(percentileOf(grid, 1000)).toBe(100)
    expect(percentileOf(grid, 50)!).toBeGreaterThan(percentileOf(grid, 20)!)
  })

  it('refuses to calibrate on too little history rather than inventing a grid', () => {
    expect(buildPercentileGrid([1, 2, 3])).toBeNull()
    expect(percentileOf(null, 5)).toBeNull()
  })

  it('restates a percentile as a frequency a person can reason about', () => {
    expect(frequencyPhrase(97)).toMatch(/days a year/)
    expect(frequencyPhrase(50)).toMatch(/ordinary/)
    expect(frequencyPhrase(99.9)).toMatch(/decade/)
    // Above the grid's resolution we say what we actually know: this is the most
    // extreme value on record. Claiming a frequency there would be invented.
    expect(frequencyPhrase(100)).toBe('the most extreme day in its recorded history')
  })
})

describe('score display never overstates certainty', () => {
  it('renders a saturated percentile as 99+, never 100', () => {
    expect(displayPercentile(100)).toEqual({ text: '99+', saturated: true })
    expect(displayPercentile(99.96)).toEqual({ text: '99+', saturated: true })
    expect(displayPercentile(99.2).text).toBe('99.2')
    expect(displayPercentile(87.4).text).toBe('87')
  })
})

describe('tier and budget are separate concerns', () => {
  it('tier reflects the event; budget filters what the user sees', () => {
    expect(tierFor(99.5, 'FRESH')).toBe('CRITICAL')
    expect(tierFor(96, 'FRESH')).toBe('SIGNIFICANT')
    expect(tierFor(91, 'FRESH')).toBe('WORTH_WATCHING')
    expect(tierFor(50, 'FRESH')).toBe('NORMAL')

    // A p96 event is visible on MEDIUM but not on LOW.
    expect(visibleUnderBudget('SIGNIFICANT', 96, 'MEDIUM')).toBe(true)
    expect(visibleUnderBudget('SIGNIFICANT', 96, 'LOW')).toBe(false)
    expect(visibleUnderBudget('WORTH_WATCHING', 91, 'HIGH')).toBe(true)
  })

  it('budget thresholds are false-positive rates, not vibes', () => {
    expect(BUDGET_THRESHOLD.LOW).toBe(99)      // ~1-in-100 sessions
    expect(BUDGET_THRESHOLD.MEDIUM).toBe(95)   // ~1-in-20
    expect(BUDGET_THRESHOLD.HIGH).toBe(90)     // ~1-in-10
  })

  it('bad data can never be shown, at any budget', () => {
    expect(tierFor(99.9, 'STALE')).toBe('SUPPRESSED')
    expect(visibleUnderBudget('SUPPRESSED', 99.9, 'HIGH')).toBe(false)
  })
})

describe('scoreChange', () => {
  it('an ordinary volume day contributes essentially nothing', () => {
    // Volume exactly at the 20-day median must not register as an anomaly.
    const r = scoreChange(input({ volume: 1_000_000 }))
    expect(r.contributions.find((c) => c.key === 'volume')?.z ?? 0).toBeLessThan(0.01)
  })

  it('a quiet day scores near zero and stays NORMAL', () => {
    const r = scoreChange(input())
    expect(r.raw).toBeLessThan(0.5)
    expect(r.tier).toBe('NORMAL')
  })

  it('a large idiosyncratic move produces a high percentile and explainable contributions', () => {
    const r = scoreChange(input({ priceEnd: 930, volume: 2_400_000 }))
    expect(r.residualZ!).toBeLessThan(-4)
    expect(r.pctl).toBeGreaterThan(95)
    expect(r.contributions.map((c) => c.key)).toContain('residual')
    const vol = r.contributions.find((c) => c.key === 'volume')
    expect(vol).toBeDefined()
    // ln(2.4) / 0.35 ~= 2.5 sigma — informative, and nowhere near the clip.
    expect(vol!.z).toBeGreaterThan(2)
    expect(vol!.z).toBeLessThan(3)
    expect(vol!.detail).toBe('2.4× the usual volume')
    // Contributions must reconstruct the raw score exactly — the WHY panel is
    // a decomposition, not a separate story.
    const sum = r.contributions.reduce((s, c) => s + c.points, 0)
    expect(sum).toBeCloseTo(r.raw, 10)
  })

  it('a market-wide fall produces no attention at all', () => {
    // Stock -2.5%, index -2.5%, beta 1. Everything red, nothing to say.
    const r = scoreChange(input({ priceEnd: 975, indexEnd: 19500 }))
    expect(r.tier).toBe('NORMAL')
    expect(r.raw).toBeLessThan(0.5)
  })

  it('stale data is suppressed and produces no score to rank on', () => {
    const r = scoreChange(input({
      priceEnd: 900,
      quality: { quality: 'STALE', reason: 'Feed stopped', ageMs: 9e6, sources: ['a'] },
    }))
    expect(r.tier).toBe('SUPPRESSED')
    expect(r.raw).toBe(0)
    expect(r.contributions).toHaveLength(0)
    expect(r.degraded).toMatch(/Suppressed/)
  })

  it('a crossed user threshold is weighted above our own statistics', () => {
    const r = scoreChange(input({
      priceStart: 1450, priceEnd: 1390,
      userThreshold: { kind: 'BELOW', value: 1400 },
    }))
    const t = r.contributions.find((c) => c.key === 'userThreshold')
    expect(t).toBeDefined()
    expect(t!.points).toBe(2.0)
  })

  it('marks limited baseline instead of silently pretending to be calibrated', () => {
    const r = scoreChange(input({ priceEnd: 930, stats: stats({ pctlGrid: null }) }))
    expect(r.degraded).toMatch(/Limited baseline/)
  })

  it('is deterministic — identical inputs give byte-identical output', () => {
    const i = input({ priceEnd: 930, volume: 2_400_000 })
    expect(JSON.stringify(scoreChange(i))).toBe(JSON.stringify(scoreChange(i)))
  })
})
