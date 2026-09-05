import { describe, it, expect } from 'vitest'
import { decompose } from '../src/market/decompose.js'

describe('market-adjusted decomposition', () => {
  it('a stock that moves exactly with the market has ~zero residual', () => {
    // THE central claim of the product: a market-wide fall is not news about
    // your stock. Index -2.5%, beta 1.0 stock -2.5% => nothing happened.
    const d = decompose({
      priceStart: 100, priceEnd: 97.5,
      indexStart: 20000, indexEnd: 19500,
      beta: 1.0, residMad: 0.01, sessions: 1,
    })
    expect(d.residual).not.toBeNull()
    expect(Math.abs(d.residual!)).toBeLessThan(1e-9)
    expect(Math.abs(d.residualZ!)).toBeLessThan(1e-6)
  })

  it('isolates the idiosyncratic part when a stock falls harder than the market', () => {
    // Index -2.5%, beta 1.0, but this stock fell 7%. Only the extra 4.5% is news.
    const d = decompose({
      priceStart: 100, priceEnd: 93,
      indexStart: 20000, indexEnd: 19500,
      beta: 1.0, residMad: 0.01, sessions: 1,
    })
    expect(d.residualPct!).toBeLessThan(-4)
    expect(d.residualPct!).toBeGreaterThan(-5)
    expect(d.residualZ!).toBeLessThan(-4)   // ~4.6 sigma
  })

  it('a high-beta stock falling more than the index can still be unremarkable', () => {
    // beta 2.0, index -2% => -4% is exactly expected. Not news.
    const d = decompose({
      priceStart: 100, priceEnd: 96.04,
      indexStart: 20000, indexEnd: 19600,
      beta: 2.0, residMad: 0.01, sessions: 1,
    })
    expect(Math.abs(d.residualZ!)).toBeLessThan(0.2)
  })

  it('scales sigma by sqrt(sessions) so multi-day windows are not false positives', () => {
    const args = {
      priceStart: 100, priceEnd: 95,
      indexStart: 20000, indexEnd: 20000,
      beta: 1.0, residMad: 0.01,
    }
    const oneDay = decompose({ ...args, sessions: 1 })
    const fourDay = decompose({ ...args, sessions: 4 })
    expect(Math.abs(fourDay.residualZ!)).toBeCloseTo(Math.abs(oneDay.residualZ!) / 2, 6)
  })

  it('falls back to raw return when no benchmark is available', () => {
    const d = decompose({
      priceStart: 100, priceEnd: 95,
      indexStart: null, indexEnd: null,
      beta: null, residMad: 0.01, sessions: 1,
    })
    expect(d.residual).toBeCloseTo(Math.log(0.95), 12)
  })

  it('returns nulls rather than NaN when prices are missing', () => {
    const d = decompose({
      priceStart: null, priceEnd: 95,
      indexStart: 1, indexEnd: 1, beta: 1, residMad: 0.01, sessions: 1,
    })
    expect(d.residual).toBeNull()
    expect(d.residualZ).toBeNull()
  })
})
