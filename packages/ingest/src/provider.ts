import type { DailyBar, IntradayBar } from '@since/core'

export interface CorporateActionRecord {
  symbolId: string
  exDate: string
  type: 'SPLIT' | 'BONUS' | 'DIVIDEND' | 'RIGHTS' | 'MERGER'
  ratio: number | null
  notes: string | null
}

export interface MarketEventRecord {
  symbolId: string
  publishedAt: Date
  type: string
  headline: string
  url: string | null
  source: string
}

/**
 * The single seam through which market data enters the system.
 *
 * Two implementations ship: a real one that reads Yahoo Finance, and a
 * deterministic synthetic one. Both write into the same tables in the same
 * shape, so nothing downstream — scoring, agent, replay, evaluation — can tell
 * which produced the data. That is the point: the demo cannot be a special path.
 */
export interface MarketDataProvider {
  /** Short identifier stored on every observation, e.g. "yahoo" or "synthetic". */
  readonly source: string
  /** True when the data does not describe the real world. Surfaced in the UI. */
  readonly isSimulated: boolean

  dailyBars(symbolId: string, fromDate: string, toDate: string): Promise<DailyBar[]>
  intradayBars(symbolId: string, fromDate: string, toDate: string): Promise<IntradayBar[]>
  corporateActions(symbolId: string, fromDate: string, toDate: string): Promise<CorporateActionRecord[]>
  marketEvents(symbolId: string, fromDate: string, toDate: string): Promise<MarketEventRecord[]>
}

/** Deterministic PRNG. Seeded so every synthetic run reproduces exactly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Box-Muller normal from a uniform generator. */
export function gaussian(rand: () => number): number {
  let u = 0
  let v = 0
  while (u === 0) u = rand()
  while (v === 0) v = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}
