import type { DailyBar, IntradayBar } from '@since/core'
import {
  mulberry32, gaussian,
  type MarketDataProvider, type CorporateActionRecord, type MarketEventRecord,
} from '../provider.js'
import { UNIVERSE, BENCHMARK_ID, symbolId } from '../universe.js'

/**
 * Deterministic synthetic market.
 *
 * This exists for one reason: a five-minute demo cannot wait for the market to
 * do something interesting, and a judge running the project on a Sunday must
 * still see the product work. Every value here is reproducible from a seed, so
 * the evaluation numbers in the README can be regenerated exactly.
 *
 * It is NEVER presented as live. Every observation carries source "synthetic",
 * the provider reports isSimulated, and the UI shows a persistent banner.
 *
 * The generator is not noise. It reproduces the structure the scoring engine is
 * built to exploit — market beta, sector co-movement, volatility clustering,
 * volume/price correlation — and then scripts a small number of situations the
 * product must handle correctly. If the engine could not find these, it would
 * not find anything real either.
 */

const SESSIONS = 420               // ~20 months of trading days
const BARS_PER_SESSION = 75        // 09:15–15:30 IST in 5-minute bars
const SEED = 20260904

/** Situations the demo must be able to show, scripted at known offsets. */
export interface Scenario {
  /** Sessions back from the most recent one. 0 = latest session. */
  offset: number
  symbol: string
  kind: 'IDIOSYNCRATIC_DROP' | 'SECTOR_MOVE' | 'MARKET_SELLOFF' | 'SPLIT' | 'EVENT_MOVE'
  /** Extra log return beyond what beta explains. */
  shock?: number
  /** Minute-of-session at which the move lands, for intraday shape. */
  atMinute?: number
  headline?: string
}

export const SCENARIOS: Scenario[] = [
  // The money shot: the index falls, everything falls with it, and exactly one
  // stock falls for its own reasons.
  { offset: 0, symbol: '__INDEX__', kind: 'MARKET_SELLOFF', shock: -0.021 },
  {
    offset: 0, symbol: 'HDFCBANK', kind: 'IDIOSYNCRATIC_DROP', shock: -0.048, atMinute: 142,
    headline: 'HDFC Bank reports higher slippages in unsecured retail book',
  },
  // An event-linked move, where the agent can align publication time to price.
  {
    offset: 0, symbol: 'TCS', kind: 'EVENT_MOVE', shock: -0.034, atMinute: 95,
    headline: 'TCS Q2 revenue growth guidance trimmed on weak discretionary spend',
  },
  // Four IT names moving together — one story, not four.
  { offset: 0, symbol: 'INFY', kind: 'SECTOR_MOVE', shock: -0.019 },
  { offset: 0, symbol: 'WIPRO', kind: 'SECTOR_MOVE', shock: -0.021 },
  { offset: 0, symbol: 'HCLTECH', kind: 'SECTOR_MOVE', shock: -0.018 },
  { offset: 0, symbol: 'TECHM', kind: 'SECTOR_MOVE', shock: -0.020 },
  // A 1:2 split that must never surface as a -50% crash.
  { offset: 2, symbol: 'TATASTEEL', kind: 'SPLIT' },
  // Idiosyncratic moves a few sessions back, so replay has something real to
  // show. These must be on symbols the demo watchlist actually contains,
  // otherwise time travel lands on an empty brief and looks broken.
  {
    offset: 2, symbol: 'MARUTI', kind: 'IDIOSYNCRATIC_DROP', shock: -0.052, atMinute: 30,
    headline: 'Maruti Suzuki flags weaker entry-level demand',
  },
  {
    offset: 4, symbol: 'ITC', kind: 'EVENT_MOVE', shock: +0.041, atMinute: 55,
    headline: 'ITC hotels demerger record date confirmed',
  },
]

interface SymbolProfile {
  id: string
  ticker: string
  sectorId: string
  beta: number
  idioVol: number
  basePrice: number
  baseVolume: number
}

export class SyntheticProvider implements MarketDataProvider {
  readonly source = 'synthetic'
  readonly isSimulated = true

  private readonly sessions: string[]
  private readonly indexCloses: number[]
  private readonly indexReturns: number[]
  private readonly profiles = new Map<string, SymbolProfile>()
  private readonly closes = new Map<string, number[]>()
  private readonly volumes = new Map<string, number[]>()
  private readonly splits = new Map<string, { index: number; ratio: number }>()

  constructor(private readonly endDate: string) {
    this.sessions = buildSessions(endDate, SESSIONS)
    const { closes, returns } = this.buildIndex()
    this.indexCloses = closes
    this.indexReturns = returns
    this.buildSymbols()
  }

  get sessionDates(): readonly string[] { return this.sessions }

  private buildIndex(): { closes: number[]; returns: number[] } {
    const rand = mulberry32(SEED)
    const closes: number[] = []
    const returns: number[] = []
    let price = 19_400
    let vol = 0.0072

    for (let i = 0; i < this.sessions.length; i++) {
      // Volatility clustering: today's vol is mostly yesterday's.
      vol = 0.90 * vol + 0.10 * 0.0072 + 0.02 * Math.abs(gaussian(rand)) * 0.0072
      let r = 0.0004 + gaussian(rand) * vol

      const selloff = SCENARIOS.find(
        (s) => s.kind === 'MARKET_SELLOFF' && this.sessions.length - 1 - s.offset === i,
      )
      if (selloff?.shock !== undefined) r = selloff.shock

      price *= Math.exp(r)
      returns.push(r)
      closes.push(price)
    }
    return { closes, returns }
  }

  private buildSymbols(): void {
    UNIVERSE.forEach((def, idx) => {
      const rand = mulberry32(SEED + idx * 7919)
      const profile: SymbolProfile = {
        id: symbolId(def.ticker),
        ticker: def.ticker,
        sectorId: def.sectorId,
        beta: 0.55 + rand() * 1.05,                 // 0.55 – 1.60
        idioVol: 0.008 + rand() * 0.010,            // 0.8% – 1.8% daily
        basePrice: 180 + rand() * 3200,
        baseVolume: 400_000 + Math.floor(rand() * 9_000_000),
      }
      this.profiles.set(profile.id, profile)

      // Sector factor: names in the same sector share a common shock, which is
      // what makes the "one story, not four" grouping meaningful.
      const sectorRand = mulberry32(SEED + hash(def.sectorId))

      const closes: number[] = []
      const volumes: number[] = []
      let price = profile.basePrice
      const lastIdx = this.sessions.length - 1

      for (let i = 0; i < this.sessions.length; i++) {
        const sectorShock = gaussian(sectorRand) * 0.004
        let r = profile.beta * this.indexReturns[i]! + sectorShock + gaussian(rand) * profile.idioVol
        let volMult = 1 + Math.abs(gaussian(rand)) * 0.35

        for (const s of SCENARIOS) {
          if (s.symbol !== def.ticker || lastIdx - s.offset !== i) continue
          if (s.kind === 'SPLIT') {
            this.splits.set(profile.id, { index: i, ratio: 0.5 })
          } else if (s.shock !== undefined) {
            r += s.shock
            volMult = 2.2 + Math.abs(gaussian(rand)) * 0.6   // events bring volume
          }
        }

        price *= Math.exp(r)
        closes.push(price)
        volumes.push(Math.max(1000, Math.floor(profile.baseVolume * volMult)))
      }

      this.closes.set(profile.id, closes)
      this.volumes.set(profile.id, volumes)
    })
  }

  async dailyBars(id: string, fromDate: string, toDate: string): Promise<DailyBar[]> {
    const isIndex = id === BENCHMARK_ID
    const closes = isIndex ? this.indexCloses : this.closes.get(id)
    if (!closes) return []
    const volumes = isIndex ? null : this.volumes.get(id)
    const split = this.splits.get(id)
    const rand = mulberry32(SEED + hash(id) + 13)

    const out: DailyBar[] = []
    for (let i = 0; i < this.sessions.length; i++) {
      const date = this.sessions[i]!
      if (date < fromDate || date > toDate) continue

      const adjClose = closes[i]!
      // As-traded price: before the split ex-date the raw price is 1/ratio the
      // adjusted price. This is exactly how a real feed looks, and it is what
      // makes the split detectable rather than guessable.
      const preSplit = split !== undefined && i < split.index
      const close = preSplit ? adjClose / split.ratio : adjClose

      const prev = i > 0 ? (split && i - 1 < split.index ? closes[i - 1]! / split.ratio : closes[i - 1]!) : close
      const gap = 1 + gaussian(rand) * 0.0025
      const open = prev * gap
      const high = Math.max(open, close) * (1 + Math.abs(gaussian(rand)) * 0.004)
      const low = Math.min(open, close) * (1 - Math.abs(gaussian(rand)) * 0.004)

      out.push({
        date,
        open: round2(open), high: round2(high), low: round2(low),
        close: round2(close), adjClose: round2(adjClose),
        volume: volumes ? volumes[i]! : 0,
      })
    }
    return out
  }

  async intradayBars(id: string, fromDate: string, toDate: string): Promise<IntradayBar[]> {
    const isIndex = id === BENCHMARK_ID
    const closes = isIndex ? this.indexCloses : this.closes.get(id)
    if (!closes) return []
    const volumes = isIndex ? null : this.volumes.get(id)
    const rand = mulberry32(SEED + hash(id) + 77)
    const lastIdx = this.sessions.length - 1

    const out: IntradayBar[] = []
    for (let i = 0; i < this.sessions.length; i++) {
      const date = this.sessions[i]!
      if (date < fromDate || date > toDate) continue

      const prevClose = i > 0 ? closes[i - 1]! : closes[i]!
      const dayClose = closes[i]!
      const totalMove = Math.log(dayClose / prevClose)

      // Does a scripted event concentrate the move into one bar today?
      const scripted = SCENARIOS.find(
        (s) => s.symbol === tickerOf(id) && lastIdx - s.offset === i && s.atMinute !== undefined,
      )
      const shockBar = scripted ? Math.floor(scripted.atMinute! / 5) : -1

      let price = prevClose
      const dayVolume = volumes ? volumes[i]! : 0

      for (let b = 0; b < BARS_PER_SESSION; b++) {
        let r: number
        if (shockBar >= 0) {
          // 87% of the day's move lands in the shock bar; the rest is drift.
          // This is what gives get_intraday_shape something real to discover.
          r = b === shockBar ? totalMove * 0.87 : (totalMove * 0.13) / (BARS_PER_SESSION - 1)
        } else {
          r = totalMove / BARS_PER_SESSION + gaussian(rand) * 0.0009
        }
        const open = price
        price *= Math.exp(r)
        const barVol = Math.floor(
          (dayVolume / BARS_PER_SESSION) * (b === shockBar ? 9 : 1) * (0.6 + rand() * 0.8),
        )
        out.push({
          ts: sessionInstant(date, b),
          open: round2(open),
          high: round2(Math.max(open, price) * (1 + rand() * 0.0008)),
          low: round2(Math.min(open, price) * (1 - rand() * 0.0008)),
          close: round2(price),
          volume: barVol,
        })
      }
    }
    return out
  }

  async corporateActions(id: string, fromDate: string, toDate: string): Promise<CorporateActionRecord[]> {
    const split = this.splits.get(id)
    if (!split) return []
    const exDate = this.sessions[split.index]
    if (!exDate || exDate < fromDate || exDate > toDate) return []
    return [{
      symbolId: id, exDate, type: 'SPLIT', ratio: split.ratio,
      notes: 'Stock split 1:2',
    }]
  }

  async marketEvents(id: string, fromDate: string, toDate: string): Promise<MarketEventRecord[]> {
    const ticker = tickerOf(id)
    const lastIdx = this.sessions.length - 1
    const out: MarketEventRecord[] = []
    for (const s of SCENARIOS) {
      if (s.symbol !== ticker || !s.headline) continue
      const date = this.sessions[lastIdx - s.offset]
      if (!date || date < fromDate || date > toDate) continue
      // Published two minutes BEFORE the move, so temporal alignment is a real
      // check the agent can perform rather than an assumption it can make.
      const bar = Math.max(0, Math.floor((s.atMinute ?? 60) / 5) - 1)
      out.push({
        symbolId: id,
        publishedAt: sessionInstant(date, bar),
        type: s.kind === 'EVENT_MOVE' ? 'RESULTS' : 'NEWS',
        headline: s.headline,
        url: null,
        source: 'synthetic-wire',
      })
    }
    return out
  }
}

/* ---------------------------------------------------------------- helpers */

/** Weekday sessions ending at `endDate`, with a few holidays removed. */
function buildSessions(endDate: string, count: number): string[] {
  const holidays = new Set(['01-26', '03-25', '08-15', '10-02', '12-25'])  // MM-DD
  const out: string[] = []
  const d = new Date(`${endDate}T00:00:00Z`)
  while (out.length < count) {
    const day = d.getUTCDay()
    const iso = d.toISOString().slice(0, 10)
    if (day !== 0 && day !== 6 && !holidays.has(iso.slice(5))) out.push(iso)
    d.setUTCDate(d.getUTCDate() - 1)
  }
  return out.reverse()
}

/** Instant of the Nth 5-minute bar of a session. 09:15 IST == 03:45 UTC. */
function sessionInstant(date: string, barIndex: number): Date {
  const base = Date.parse(`${date}T03:45:00.000Z`)
  return new Date(base + barIndex * 5 * 60_000)
}

function tickerOf(id: string): string { return id.replace(/\.NS$/, '') }
function round2(x: number): number { return Math.round(x * 100) / 100 }
function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0
  return Math.abs(h)
}
