import { z } from 'zod'
import { marketQueries as q } from '@since/db'
import {
  fitBeta, mad, median, logReturn, istDate,
  type IntradayBar,
} from '@since/core'
import { findingSchema, conclusionSchema, type Stage } from '../schema.js'

/**
 * Agent tools.
 *
 * Each returns typed, timestamped facts and nothing else — no prose, no
 * judgement. The agent's job is to choose WHICH of these to call based on what
 * the previous ones returned; the tools themselves have no opinions.
 *
 * `get_intraday_shape` is the one that makes the investigation genuinely
 * branching: if it reports that one 5-minute bar carried most of the move, the
 * sensible next step is a narrow event search around that minute. If it reports
 * continuous drift, events are unlikely and peer comparison matters more. The
 * agent decides which, and different inputs produce different tool sequences.
 */

export interface ToolContext {
  symbolId: string
  symbolName: string
  windowStart: Date
  windowEnd: Date
  benchmarkId: string
  onStage: (stage: Stage) => void
}

export interface ToolDef {
  name: string
  description: string
  input_schema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false }
  stage: Stage
  run: (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>
  /** Short label for what this call DID, and what it found. Shown in the trail. */
  label: string
  /**
   * One line describing the finding, derived from the tool's own output.
   *
   * This is what makes the investigation legible: a reader can see that the
   * intraday shape came back CONCENTRATED and that the event search was
   * consequently narrowed, rather than being told that reasoning happened.
   */
  headline?: (out: unknown, input: Record<string, unknown>) => string
}

const noArgs = { type: 'object' as const, properties: {}, required: [], additionalProperties: false as const }

export const TOOLS: ToolDef[] = [
  {
    name: 'get_move_decomposition',
    description:
      'Split the move over the investigation window into the part the broad market explains (beta x index return) and the residual it does not. Returns beta, both returns, the residual and how many robust sigmas it represents. Start here.',
    input_schema: noArgs,
    stage: 'COMPARING_MARKET',
    label: 'Decomposed the move',
    headline: (o) => {
      const r = o as { beta: number | null; residual_sigmas: number | null; index_return_pct: number | null }
      if (r.residual_sigmas === null) return 'could not decompose - missing prices'
      return `beta ${r.beta?.toFixed(2) ?? 'n/a'} - ${Math.abs(r.residual_sigmas).toFixed(1)}σ unexplained by the market`
    },
    async run(_i, ctx) {
      const [start, end, iStart, iEnd] = await Promise.all([
        q.priceAt(ctx.symbolId, ctx.windowStart), q.priceAt(ctx.symbolId, ctx.windowEnd),
        q.priceAt(ctx.benchmarkId, ctx.windowStart), q.priceAt(ctx.benchmarkId, ctx.windowEnd),
      ])
      const stats = await q.latestStats(ctx.symbolId, istDate(ctx.windowEnd))
      const r = logReturn(start?.price ?? null, end?.price ?? null)
      const ir = logReturn(iStart?.price ?? null, iEnd?.price ?? null)
      const beta = stats?.beta ?? null
      const expected = beta !== null && ir !== null ? beta * ir : null
      const residual = r !== null && expected !== null ? r - expected : null
      const sigma = stats?.residMad ?? null
      return {
        symbol: ctx.symbolId,
        window: { from: ctx.windowStart.toISOString(), to: ctx.windowEnd.toISOString() },
        stock_return_pct: pct(r), index_return_pct: pct(ir), beta,
        market_implied_pct: pct(expected), residual_pct: pct(residual),
        residual_sigmas: residual !== null && sigma ? round(residual / sigma, 2) : null,
        interpretation_note:
          'A residual near zero means the move is fully explained by the market and is not news about this company.',
      }
    },
  },
  {
    name: 'get_peer_comparison',
    description:
      'Compare this symbol against every other stock in its sector over the same window. Returns each peer\'s market-adjusted residual and the sector median. Use this to test whether a sector-wide move explains what happened.',
    input_schema: noArgs,
    stage: 'CHECKING_SECTOR',
    label: 'Compared sector peers',
    headline: (o) => {
      const r = o as { peers?: unknown[]; sector_median_residual_pct: number | null }
      if (!r.peers?.length) return 'no sector peers on record'
      return `${r.peers.length} peers - sector median residual ${r.sector_median_residual_pct?.toFixed(2) ?? 'n/a'}%`
    },
    async run(_i, ctx) {
      const peers = await q.peersOf(ctx.symbolId)
      if (peers.length === 0) return { peers: [], note: 'No sector peers on record for this symbol.' }
      const [iStart, iEnd] = await Promise.all([
        q.priceAt(ctx.benchmarkId, ctx.windowStart), q.priceAt(ctx.benchmarkId, ctx.windowEnd),
      ])
      const ir = logReturn(iStart?.price ?? null, iEnd?.price ?? null)
      const rows: { symbol: string; residual_pct: number | null }[] = []
      for (const p of peers.slice(0, 12)) {
        const [a, b] = await Promise.all([q.priceAt(p, ctx.windowStart), q.priceAt(p, ctx.windowEnd)])
        const stats = await q.latestStats(p, istDate(ctx.windowEnd))
        const r = logReturn(a?.price ?? null, b?.price ?? null)
        const beta = stats?.beta ?? 1
        rows.push({ symbol: p, residual_pct: r !== null && ir !== null ? pct(r - beta * ir) : null })
      }
      const vals = rows.map((r) => r.residual_pct).filter((v): v is number => v !== null)
      return {
        peers: rows,
        sector_median_residual_pct: vals.length ? round(median(vals), 2) : null,
        peers_moving_same_direction: vals.filter((v) => v < 0).length,
        note: 'If the sector median residual is close to this symbol\'s residual, the move is a sector story, not a company one.',
      }
    },
  },
  {
    name: 'get_volume_profile',
    description:
      'Traded volume for the session against its 20-session baseline. Returns the multiple of normal volume and the log-space anomaly score. Unusual volume corroborates that something happened; ordinary volume argues against it.',
    input_schema: noArgs,
    stage: 'INSPECTING_VOLUME',
    label: 'Inspected volume',
    headline: (o) => {
      const r = o as { multiple_of_normal?: number; anomaly_sigmas?: number | null }
      if (r.multiple_of_normal === undefined) return 'insufficient volume history'
      return `${r.multiple_of_normal.toFixed(1)}x normal (${r.anomaly_sigmas?.toFixed(1) ?? '?'}σ)`
    },
    async run(_i, ctx) {
      const to = istDate(ctx.windowEnd)
      const from = new Date(ctx.windowEnd.getTime() - 40 * 86400_000).toISOString().slice(0, 10)
      const bars = await q.dailyBarsBetween(ctx.symbolId, from, to)
      const today = bars[bars.length - 1]
      const trailing = bars.slice(-21, -1).map((b) => b.volume).filter((v) => v > 0)
      if (!today || trailing.length < 5) return { note: 'Insufficient volume history.' }
      const med = median(trailing)
      const logMad = mad(trailing.map((v) => Math.log(v)))
      return {
        session: today.date,
        volume: today.volume,
        median_volume_20d: Math.round(med),
        multiple_of_normal: round(today.volume / med, 2),
        anomaly_sigmas: logMad > 0 ? round(Math.log(today.volume / med) / logMad, 2) : null,
      }
    },
  },
  {
    name: 'get_intraday_shape',
    description:
      'How the move was distributed WITHIN the window, using 5-minute bars. Returns the single largest bar, what share of the total move it carried, and whether the move was concentrated in one moment or spread as continuous drift. A concentrated move points at a discrete event at a specific minute; drift points at sector or flow effects.',
    input_schema: noArgs,
    stage: 'READING_INTRADAY_SHAPE',
    label: 'Read the intraday shape',
    headline: (o) => {
      const r = o as { shape?: string; share_of_move_in_largest_bar?: number; largest_bar?: { at: string } }
      if (!r.shape) return 'no intraday data for this window'
      if (r.shape === 'CONCENTRATED') {
        const pctShare = Math.round((r.share_of_move_in_largest_bar ?? 0) * 100)
        const at = r.largest_bar?.at?.slice(11, 16) ?? '?'
        return `CONCENTRATED - ${pctShare}% of the move in one bar at ${at} UTC`
      }
      return r.shape === 'MIXED' ? 'MIXED - partly concentrated' : 'CONTINUOUS DRIFT - no single trigger'
    },
    async run(_i, ctx) {
      const bars: IntradayBar[] = await q.intradayBetween(ctx.symbolId, ctx.windowStart, ctx.windowEnd)
      if (bars.length < 3) return { note: 'No intraday data for this window.', bars: bars.length }
      const first = bars[0]!
      const last = bars[bars.length - 1]!
      const total = Math.log(last.close / first.open)
      let biggest = bars[0]!
      let biggestMove = 0
      for (const b of bars) {
        const m = Math.abs(Math.log(b.close / b.open))
        if (m > biggestMove) { biggestMove = m; biggest = b }
      }
      const share = total !== 0 ? Math.abs(Math.log(biggest.close / biggest.open) / total) : 0
      return {
        bars_examined: bars.length,
        window_move_pct: pct(total),
        largest_bar: {
          at: biggest.ts.toISOString(),
          move_pct: pct(Math.log(biggest.close / biggest.open)),
          volume: biggest.volume,
        },
        share_of_move_in_largest_bar: round(share, 3),
        shape: share > 0.5 ? 'CONCENTRATED' : share > 0.25 ? 'MIXED' : 'CONTINUOUS_DRIFT',
        note: 'CONCENTRATED means one moment carried the move — search for events around largest_bar.at. CONTINUOUS_DRIFT means no single trigger.',
      }
    },
  },
  {
    name: 'search_market_events',
    description:
      'Recorded company events and announcements published inside a time range. Pass a narrow range when the intraday shape identified a specific moment. Returns publication timestamps so you can check whether the event PRECEDED the move — publication after the move cannot have caused it.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO 8601 start of the search range' },
        to: { type: 'string', description: 'ISO 8601 end of the search range' },
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    stage: 'INVESTIGATING_EVENTS',
    label: 'Searched for events',
    headline: (o, i) => {
      const r = o as { count: number }
      const from = typeof i.from === 'string' ? i.from.slice(11, 16) : '?'
      const to = typeof i.to === 'string' ? i.to.slice(11, 16) : '?'
      return r.count === 0
        ? `nothing published in ${from}-${to} UTC - supports UNEXPLAINED`
        : `${r.count} event(s) in ${from}-${to} UTC`
    },
    async run(input, ctx) {
      const parsed = z.object({ from: z.string(), to: z.string() }).safeParse(input)
      const from = parsed.success ? safeDate(parsed.data.from, ctx.windowStart) : ctx.windowStart
      const to = parsed.success ? safeDate(parsed.data.to, ctx.windowEnd) : ctx.windowEnd
      const events = await q.eventsBetween(ctx.symbolId, from, to)
      return {
        searched: { from: from.toISOString(), to: to.toISOString() },
        count: events.length,
        events: events.map((e) => ({
          published_at: e.publishedAt.toISOString(),
          type: e.type, headline: e.headline, source: e.source,
        })),
        note: events.length === 0
          ? 'No events on record. This is a real finding — it supports UNEXPLAINED, not EVENT.'
          : 'Compare published_at against when the move actually happened before claiming a link.',
      }
    },
  },
  {
    name: 'check_corporate_actions',
    description:
      'Splits, bonuses and dividends with ex-dates near the window. A corporate action makes the raw price move an artefact rather than news — check this before concluding anything about a very large move.',
    input_schema: noArgs,
    stage: 'CHECKING_CORPORATE_ACTIONS',
    label: 'Checked corporate actions',
    headline: (o) => {
      const r = o as { count: number }
      return r.count === 0 ? 'none on record - not a data artefact' : `${r.count} action(s) near this window`
    },
    async run(_i, ctx) {
      const to = istDate(ctx.windowEnd)
      const from = new Date(ctx.windowStart.getTime() - 10 * 86400_000).toISOString().slice(0, 10)
      const actions = await q.corporateActionsBetween(ctx.symbolId, from, to)
      return {
        count: actions.length,
        actions: actions.map((a) => ({ ex_date: a.exDate, type: a.type, ratio: a.ratio, notes: a.notes })),
        note: actions.length > 0
          ? 'A corporate action in range means DATA_ARTIFACT should be considered seriously.'
          : 'No corporate actions on record for this window.',
      }
    },
  },
  {
    name: 'get_data_health',
    description:
      'Provenance and freshness of the prices behind this investigation: sources, observation timestamps, and whether they agree. Use it before asserting anything numeric with confidence.',
    input_schema: noArgs,
    stage: 'VERIFYING_DATA_HEALTH',
    label: 'Verified data health',
    headline: (o) => {
      const r = o as { distinct_sources: number; observations?: unknown[] }
      return `${r.distinct_sources} source(s), ${r.observations?.length ?? 0} observation(s)`
    },
    async run(_i, ctx) {
      const obs = await q.observationsFor([ctx.symbolId], ctx.windowEnd)
      const list = obs.get(ctx.symbolId) ?? []
      return {
        observations: list.map((o) => ({
          source: o.source, price: o.price,
          observed_at: o.observedAt.toISOString(), quality: o.quality,
        })),
        distinct_sources: new Set(list.map((o) => o.source)).size,
      }
    },
  },
  {
    name: 'record_finding',
    description:
      'Record your verdict on ONE hypothesis, with the evidence supporting it. Call this once per hypothesis you evaluate. Verdicts: SUPPORTED, REJECTED, or INSUFFICIENT when the data cannot decide. INSUFFICIENT is a legitimate and useful answer.',
    input_schema: {
      type: 'object',
      properties: {
        hypothesis: { type: 'string', enum: ['MARKET', 'SECTOR', 'EVENT', 'UNEXPLAINED', 'DATA_ARTIFACT'] },
        verdict: { type: 'string', enum: ['SUPPORTED', 'REJECTED', 'INSUFFICIENT'] },
        reason: { type: 'string', description: 'One sentence, grounded in a tool result you actually received.' },
        evidence: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string' }, source: { type: 'string' },
              observation: { type: 'string' },
              observed_at: { type: 'string' },
              stance: { type: 'string', enum: ['SUPPORTS', 'CONTRADICTS', 'NEUTRAL'] },
            },
            required: ['type', 'source', 'observation', 'stance'],
            additionalProperties: false,
          },
        },
      },
      required: ['hypothesis', 'verdict', 'reason', 'evidence'],
      additionalProperties: false,
    },
    stage: 'RECORDING_FINDING',
    label: 'Recorded a finding',
    headline: (_o, i) => `${String(i.hypothesis)} - ${String(i.verdict).toLowerCase()}`,
    async run(input) {
      const parsed = findingSchema.safeParse(input)
      if (!parsed.success) return { accepted: false, error: parsed.error.issues.map((i) => i.message).join('; ') }
      return { accepted: true, hypothesis: parsed.data.hypothesis, verdict: parsed.data.verdict }
    },
  },
  {
    name: 'submit_conclusion',
    description:
      'Finish the investigation. State which hypothesis is best supported and give a one-or-two sentence explanation. RULES: describe only what the evidence shows; never predict future prices; never advise buying, selling or holding; every number you state must have appeared in a tool result. Set insufficient_evidence when nothing explains the move.',
    input_schema: {
      type: 'object',
      properties: {
        primary_hypothesis: { type: 'string', enum: ['MARKET', 'SECTOR', 'EVENT', 'UNEXPLAINED', 'DATA_ARTIFACT'] },
        conclusion: { type: 'string', description: 'Descriptive, past-tense, at most two sentences.' },
        confidence: { type: 'string', enum: ['HIGH', 'MEDIUM', 'LOW'] },
        insufficient_evidence: { type: 'boolean' },
      },
      required: ['primary_hypothesis', 'conclusion', 'confidence', 'insufficient_evidence'],
      additionalProperties: false,
    },
    stage: 'FORMING_CONCLUSION',
    label: 'Formed a conclusion',
    headline: (_o, i) => `${String(i.primary_hypothesis)} - confidence ${String(i.confidence).toLowerCase()}`,
    async run(input) {
      const parsed = conclusionSchema.safeParse(input)
      if (!parsed.success) return { accepted: false, error: parsed.error.issues.map((i) => i.message).join('; ') }
      return { accepted: true }
    },
  },
]

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

function pct(logRet: number | null): number | null {
  if (logRet === null || !Number.isFinite(logRet)) return null
  return round((Math.exp(logRet) - 1) * 100, 2)
}
function round(x: number, dp = 2): number {
  const f = 10 ** dp
  return Math.round(x * f) / f
}
function safeDate(v: string, fallback: Date): Date {
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? fallback : d
}
