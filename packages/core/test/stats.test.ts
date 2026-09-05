import { describe, it, expect } from 'vitest'
import { median, mad, quantile, winsorize, logReturn, clip } from '../src/stats/robust.js'
import { fitBeta } from '../src/stats/regression.js'

describe('robust statistics', () => {
  it('median handles odd and even lengths', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })

  it('MAD is unmoved by a single catastrophic outlier — stdev is not', () => {
    const clean = [1, 1.1, 0.9, 1.05, 0.95, 1.02, 0.98, 1.01, 0.99, 1.0]
    const poisoned = [...clean.slice(0, 9), 1000]   // one fat-finger print

    const madClean = mad(clean)
    const madPoisoned = mad(poisoned)

    const sd = (xs: number[]) => {
      const m = xs.reduce((a, b) => a + b, 0) / xs.length
      return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length)
    }

    // This is the whole reason we use MAD: the bad tick must not blind the
    // detector for the next sixty sessions.
    expect(madPoisoned / madClean).toBeLessThan(2)
    expect(sd(poisoned) / sd(clean)).toBeGreaterThan(100)
  })

  it('quantile interpolates and saturates', () => {
    const xs = [0, 1, 2, 3, 4]
    expect(quantile(xs, 0)).toBe(0)
    expect(quantile(xs, 1)).toBe(4)
    expect(quantile(xs, 0.5)).toBe(2)
  })

  it('winsorize clamps rather than drops, preserving length', () => {
    const xs = [1, 1, 1, 1, 1, 1, 1, 1, 1, 500]
    const w = winsorize(xs, 5)
    expect(w).toHaveLength(xs.length)
    expect(Math.max(...w)).toBeLessThan(500)
  })

  it('logReturn rejects non-positive and null inputs', () => {
    expect(logReturn(null, 10)).toBeNull()
    expect(logReturn(0, 10)).toBeNull()
    expect(logReturn(-5, 10)).toBeNull()
    expect(logReturn(100, 110)).toBeCloseTo(Math.log(1.1), 12)
  })

  it('clip returns the low bound for non-finite input', () => {
    expect(clip(NaN, 0, 6)).toBe(0)
    expect(clip(99, 0, 6)).toBe(6)
  })
})

describe('beta estimation', () => {
  it('recovers a known beta from synthetic data', () => {
    const index: number[] = []
    const stock: number[] = []
    let seed = 42
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5 }
    for (let i = 0; i < 200; i++) {
      const r = rand() * 0.02
      index.push(r)
      stock.push(1.4 * r + rand() * 0.002)   // true beta 1.4 plus small idiosyncratic noise
    }
    const fit = fitBeta(stock, index)
    expect(fit).not.toBeNull()
    expect(fit!.beta).toBeGreaterThan(1.25)
    expect(fit!.beta).toBeLessThan(1.55)
  })

  it('refuses to fit with too little history rather than guessing', () => {
    expect(fitBeta([0.1, 0.2], [0.1, 0.2])).toBeNull()
  })
})
