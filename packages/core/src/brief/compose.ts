import type { AttentionBudget, ScoreResult, DataQuality } from '../types.js'
import type { DiffWindow } from '../diff/window.js'
import { visibleUnderBudget } from '../scoring/tier.js'
import { frequencyPhrase } from '../scoring/calibrate.js'

export interface MarketRegime {
  active: boolean
  indexReturnPct: number
  /** Share of the watchlist moving the same way as the index, 0..1. */
  breadth: number
  /** Exact count moving with the index. Never re-derive this from breadth. */
  withMarket: number
  /** Exact count of symbols that moved at all. */
  movedTotal: number
  headline: string
}

export interface BriefCard {
  symbolId: string
  score: ScoreResult
  /** "about 7 days a year" — the score restated as a frequency. */
  frequency: string
  /** Set when this card stands for a group of symbols moving together. */
  group?: { sectorId: string; sectorName: string; members: string[] }
}

export interface SuppressedEntry {
  symbolId: string
  quality: DataQuality
  reason: string
}

export interface Brief {
  window: DiffWindow
  totalWatched: number
  /** Symbols whose price moved at all over the window. */
  changedCount: number
  /** Symbols that cleared the budget and are shown. */
  attentionCount: number
  /** Moved, scored, and deliberately not shown. The product's proudest number. */
  filteredCount: number
  suppressedCount: number
  regime: MarketRegime | null
  cards: BriefCard[]
  suppressed: SuppressedEntry[]
  budget: AttentionBudget
  cap: number
}

export interface ComposeParams {
  scored: readonly ScoreResult[]
  window: DiffWindow
  budget: AttentionBudget
  cap: number
  /** Benchmark log return over the window, for regime detection. */
  indexReturn: number | null
  /** Typical benchmark move for a window of this length. */
  indexSigma: number | null
  sectorOf: (symbolId: string) => { id: string; name: string } | null
  nameOf?: (symbolId: string) => string
}

/** Below this the index move is not a regime, just a day. */
export const REGIME_SIGMA = 2
/** Share of the watchlist that must move together for it to be a regime. */
export const REGIME_BREADTH = 0.8
/** Same-sector candidates needed before we collapse them into one card. */
export const GROUP_MIN = 3

/**
 * Assemble the Brief.
 *
 * Three things happen here that do not happen in a normal watchlist:
 * we cap the output at `cap` no matter what the market did, we collapse
 * same-sector moves into one story instead of repeating it, and we count what
 * we deliberately hid so the user can see the system working.
 */
export function composeBrief(p: ComposeParams): Brief {
  const { scored, window, budget, cap } = p

  const changed = scored.filter((s) => s.returnPct !== null && Math.abs(s.returnPct) > 0.01)
  const suppressed: SuppressedEntry[] = scored
    .filter((s) => s.tier === 'SUPPRESSED')
    .map((s) => ({ symbolId: s.symbolId, quality: s.quality, reason: s.qualityReason }))

  const regime = detectRegime(scored, p.indexReturn, p.indexSigma)

  const candidates = scored
    .filter((s) => visibleUnderBudget(s.tier, s.pctl, budget))
    .sort(byRank)

  const cards = groupBySector(candidates, p.sectorOf).slice(0, cap)

  const shownSymbols = new Set<string>()
  for (const c of cards) {
    shownSymbols.add(c.symbolId)
    for (const m of c.group?.members ?? []) shownSymbols.add(m)
  }

  return {
    window,
    totalWatched: scored.length,
    changedCount: changed.length,
    attentionCount: cards.length,
    filteredCount: changed.filter(
      (s) => s.tier !== 'SUPPRESSED' && !shownSymbols.has(s.symbolId),
    ).length,
    suppressedCount: suppressed.length,
    regime,
    cards,
    suppressed,
    budget,
    cap,
  }
}

/** Deterministic ordering: percentile, then raw, then id. Never depends on input order. */
function byRank(a: ScoreResult, b: ScoreResult): number {
  if (b.pctl !== a.pctl) return b.pctl - a.pctl
  if (b.raw !== a.raw) return b.raw - a.raw
  return a.symbolId.localeCompare(b.symbolId)
}

function detectRegime(
  scored: readonly ScoreResult[],
  indexReturn: number | null,
  indexSigma: number | null,
): MarketRegime | null {
  if (indexReturn === null || indexSigma === null || indexSigma <= 0) return null
  const z = indexReturn / indexSigma
  const moved = scored.filter((s) => s.returnPct !== null)
  if (moved.length === 0) return null

  const sameWay = moved.filter((s) => Math.sign(s.returnPct!) === Math.sign(indexReturn)).length
  const breadth = sameWay / moved.length
  const indexReturnPct = (Math.exp(indexReturn) - 1) * 100

  if (Math.abs(z) < REGIME_SIGMA || breadth < REGIME_BREADTH) return null

  const dir = indexReturn < 0 ? 'fell' : 'rose'
  return {
    active: true,
    indexReturnPct,
    breadth,
    withMarket: sameWay,
    movedTotal: moved.length,
    headline:
      `The market ${dir} ${Math.abs(indexReturnPct).toFixed(1)}%, and ${sameWay} of your ` +
      `${moved.length} stocks ${dir} with it. This is about the market, not your stocks.`,
  }
}

/**
 * Collapse same-sector, same-direction moves into a single card.
 * Four semiconductor stocks up together is one story, not four.
 */
function groupBySector(
  candidates: readonly ScoreResult[],
  sectorOf: ComposeParams['sectorOf'],
): BriefCard[] {
  const bySector = new Map<string, ScoreResult[]>()
  for (const c of candidates) {
    const sector = sectorOf(c.symbolId)
    if (!sector) continue
    const sign = Math.sign(c.residualPct ?? c.returnPct ?? 0)
    const key = `${sector.id}:${sign}`
    const list = bySector.get(key)
    if (list) list.push(c)
    else bySector.set(key, [c])
  }

  const grouped = new Set<string>()
  const cards: BriefCard[] = []

  for (const [, members] of bySector) {
    if (members.length < GROUP_MIN) continue
    const sorted = [...members].sort(byRank)
    const lead = sorted[0]!
    const sector = sectorOf(lead.symbolId)!
    for (const m of sorted) grouped.add(m.symbolId)
    cards.push({
      symbolId: lead.symbolId,
      score: lead,
      frequency: frequencyPhrase(lead.pctl),
      group: {
        sectorId: sector.id,
        sectorName: sector.name,
        members: sorted.map((m) => m.symbolId),
      },
    })
  }

  for (const c of candidates) {
    if (grouped.has(c.symbolId)) continue
    cards.push({ symbolId: c.symbolId, score: c, frequency: frequencyPhrase(c.pctl) })
  }

  return cards.sort((a, b) => byRank(a.score, b.score))
}
