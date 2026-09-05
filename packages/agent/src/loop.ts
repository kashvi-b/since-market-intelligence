import type { ScoreResult } from '@since/core'
import {
  resolveProvider, LlmUnavailable,
  type LlmProvider, type LlmMessage, type LlmToolDef, type LlmToolResult,
} from './llm/index.js'
import { TOOLS, TOOL_BY_NAME, type ToolContext } from './tools/index.js'
import {
  findingSchema, conclusionSchema, HYPOTHESES, HYPOTHESIS_LABEL,
  type Conclusion, type Finding, type Stage,
} from './schema.js'
import { lintConclusion, checkNumericGrounding } from './guards.js'
import { deterministicConclusion, AGENT_UNAVAILABLE_NOTE } from './fallback.js'

/**
 * Hard caps. An investigation that cannot finish inside these is a failed one.
 *
 * The budget counts EVIDENCE GATHERING only. `record_finding` and
 * `submit_conclusion` are how the agent finishes, and counting them against the
 * same allowance is self-defeating: a first live run spent seven calls
 * investigating and three recording findings, hit the ceiling, and never reached
 * its conclusion — so a complete investigation was reported as a failure.
 */
export const MAX_TOOL_CALLS = 10
/** Absolute ceiling across all calls, so a loop still cannot run away. */
export const MAX_TOTAL_CALLS = 20
/**
 * Most tool calls a single turn may make.
 *
 * Asking for parallel calls cut the number of turns, but it also let one turn
 * emit 29 copies of the same call — the between-turns ceiling never got a
 * chance to stop it. A cap that is only checked between iterations is not a cap.
 */
export const MAX_CALLS_PER_TURN = 6
/**
 * Generous, because a free-tier provider paces requests rather than refusing
 * them: an investigation that waits out a rate limit is worth more than one
 * that gives up and falls back.
 */
export const DEADLINE_MS = 90_000

/** Bookkeeping rather than evidence: exempt from the investigation budget. */
const TERMINAL_TOOLS = new Set(['record_finding', 'submit_conclusion'])

export interface InvestigationInput {
  symbolId: string
  symbolName: string
  windowStart: Date
  windowEnd: Date
  benchmarkId: string
  score: ScoreResult
  sectorName?: string | null
  volumeMultiple?: number | null
  hasEvent?: boolean
}

/** One step of the investigation, as it actually happened. */
export interface TrailStep {
  seq: number
  tool: string
  label: string
  /** What the tool found, derived from its own output. Never model prose. */
  headline: string
  at: string
  /**
   * Set when this call was narrowed by an earlier result — the visible proof
   * that the path depended on evidence rather than following a fixed script.
   */
  narrowedBy?: string
}

export interface InvestigationResult {
  status: 'COMPLETED' | 'INSUFFICIENT_EVIDENCE' | 'FAILED'
  conclusion: Conclusion
  findings: Finding[]
  toolCalls: { name: string; input: unknown; at: string }[]
  trail: TrailStep[]
  stages: Stage[]
  fallbackUsed: boolean
  note: string | null
  /** Populated when a guard rejected the model's own wording. */
  guardRejections: string[]
}

const SYSTEM = `You are the investigation layer of Since, a market-diff product for Indian equities (NSE).

A DETERMINISTIC engine has already decided that a change is significant. That decision is not yours and is not up for revision. Your job is strictly narrower and more interesting: work out WHY the move happened, by eliminating hypotheses against evidence.

The five candidate hypotheses:
${HYPOTHESES.map((h) => `  ${h} — ${HYPOTHESIS_LABEL[h]}`).join('\n')}

How to investigate:
- Start with get_move_decomposition. It tells you how much of the move the market already explains.
- Call independent tools together in one step rather than one at a time, but AT MOST FOUR AT ONCE and never the same tool twice. Volume, corporate actions, data health and the intraday shape do not depend on each other, so request them together. Only the event search should wait, because where you look depends on what the intraday shape says.
- Every tool answers once. If you have already called something, you have its answer; calling it again tells you nothing and wastes the budget.
- Let each result choose your next call. If get_intraday_shape reports a CONCENTRATED move, search for events in a narrow range around that minute. If it reports CONTINUOUS_DRIFT, a discrete event is unlikely and peer behaviour matters more. Do not run a fixed checklist.
- Call record_finding once for each hypothesis you can actually decide. You do not have to evaluate all five.
- Finish with submit_conclusion.

Rules that are not negotiable:
- Every number you state must have appeared in a tool result. Do not compute new figures and do not round to something you did not see.
- Describe what happened. Never predict what will happen. Never advise buying, selling or holding. Never call anything cheap, expensive, undervalued or overvalued.
- Correlation is not causation, and this is not a style note. Even when an event precedes a move, you observed an ordering, not a mechanism. Write "fell 7.8% after X was published" or "the timing is consistent with X". Do NOT write that something "triggered", "caused", "drove", "led to" or "was due to" a move. Timing that lines up is evidence for a link; it is not proof of one, and stating it as proof is the single easiest way for this product to be wrong in public.
- If nothing explains the move, say so and set insufficient_evidence. That is a useful, correct answer — not a failure.
- Be brief. Two sentences at most.`

/**
 * Run one investigation.
 *
 * The deterministic explanation is computed BEFORE the model is called, so any
 * failure path — no API key, timeout, malformed output, a guard rejection —
 * still returns a complete, useful result. The agent adds nuance; it is never
 * load-bearing.
 */
export async function investigate(
  input: InvestigationInput,
  opts: {
    onStage?: (s: Stage) => void
    onTrail?: (step: TrailStep) => void
    /** Override provider selection; omit to resolve from the environment. */
    provider?: LlmProvider | null
  } = {},
): Promise<InvestigationResult> {
  const stages: Stage[] = []
  const onStage = (s: Stage) => { stages.push(s); opts.onStage?.(s) }

  const fallback = deterministicConclusion({
    symbolName: input.symbolName,
    score: input.score,
    sectorName: input.sectorName ?? null,
    volumeMultiple: input.volumeMultiple ?? null,
    hasEvent: input.hasEvent ?? false,
  })

  const provider = opts.provider !== undefined ? opts.provider : resolveProvider()
  if (!provider) {
    // Not a fake trail: these steps describe work the deterministic engine
    // genuinely did. What is missing is the model, and the UI says so.
    return {
      status: 'COMPLETED', ...fallback, toolCalls: [],
      trail: deterministicTrail(input), stages: [],
      fallbackUsed: true, note: AGENT_UNAVAILABLE_NOTE, guardRejections: [],
    }
  }

  const ctx: ToolContext = {
    symbolId: input.symbolId, symbolName: input.symbolName,
    windowStart: input.windowStart, windowEnd: input.windowEnd,
    benchmarkId: input.benchmarkId, onStage,
  }

  const toolCalls: InvestigationResult['toolCalls'] = []
  const trail: TrailStep[] = []
  /**
   * Results of calls already made, keyed by tool and arguments.
   *
   * A model that repeats an identical call is not gathering evidence, it is
   * stuck. Returning the cached answer costs nothing, keeps the transcript
   * honest, and — because repeats do not consume budget — lets the run continue
   * to something useful instead of being killed by its own loop.
   */
  const seen = new Map<string, string>()
  /** Remembers the shape finding, so a later narrowed search can be attributed. */
  let shapeFinding: string | null = null
  const findings: Finding[] = []
  const evidenceTexts: string[] = []
  const guardRejections: string[] = []
  let conclusion: Conclusion | null = null

  const history: LlmMessage[] = [{
    role: 'user',
    text:
      `Investigate this detected change.\n\n` +
      `Symbol: ${input.symbolName} (${input.symbolId})\n` +
      `Window: ${input.windowStart.toISOString()} to ${input.windowEnd.toISOString()}\n` +
      `Move: ${fmt(input.score.returnPct)}%\n` +
      `Market-implied: ${fmt(input.score.expectedPct)}%\n` +
      `Residual: ${fmt(input.score.residualPct)}% (${fmt(input.score.residualZ, 1)} sigma)\n` +
      `Attention percentile: ${input.score.pctl.toFixed(0)} (${input.score.tier})\n` +
      `Sector: ${input.sectorName ?? 'unknown'}\n\n` +
      `Determine which hypothesis best explains it.`,
  }]

  const tools: LlmToolDef[] = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: {
      type: 'object',
      properties: t.input_schema.properties,
      required: t.input_schema.required,
    },
  }))

  const deadline = Date.now() + DEADLINE_MS
  onStage('ANALYZING_MOVEMENT')

  try {
    let evidenceCalls = 0
    let repeats = 0
    let loopingOut = false
    while (!loopingOut
           && evidenceCalls < MAX_TOOL_CALLS
           && toolCalls.length < MAX_TOTAL_CALLS
           && Date.now() < deadline) {
      const response = await provider.turn({ system: SYSTEM, history, tools })

      if (response.stop === 'refusal') {
        return failWith(fallback, stages, toolCalls, trail, 'The model declined to investigate this item.', guardRejections)
      }
      if (response.stop === 'end') break

      const uses = response.toolCalls
      if (uses.length === 0) break

      // Duplicates inside a single turn are over-eager batching, not a stuck
      // loop: the model asked for the same thing twice in one breath, having
      // seen neither answer yet. Collapse them silently. Only a repeat ACROSS
      // turns — asking again after being told — means it is stuck.
      const withinTurn = new Set<string>()
      const deduped = uses.filter((u) => {
        const fp = `${u.name}:${JSON.stringify(u.input)}`
        if (withinTurn.has(fp)) return false
        withinTurn.add(fp)
        return true
      })

      // Truncate rather than refuse: a turn that over-asks still contains useful
      // calls, and the model recovers from a shorter answer better than an error.
      const budgeted = deduped.slice(0, Math.min(
        MAX_CALLS_PER_TURN,
        Math.max(1, MAX_TOTAL_CALLS - toolCalls.length),
      ))
      history.push({ role: 'assistant', text: response.text, toolCalls: budgeted })
      const results: LlmToolResult[] = []

      for (const use of budgeted) {
        const def = TOOL_BY_NAME.get(use.name)
        if (!def) {
          results.push({ id: use.id, name: use.name, content: 'Unknown tool.', isError: true })
          continue
        }
        onStage(def.stage)
        toolCalls.push({ name: use.name, input: use.input, at: new Date().toISOString() })

        // An identical repeat is answered from cache and costs no budget, but it
        // is also a signal: three of them means the model is looping, not working.
        const fingerprint = `${use.name}:${JSON.stringify(use.input)}`
        const cached = seen.get(fingerprint)
        if (cached !== undefined && !TERMINAL_TOOLS.has(use.name)) {
          repeats++
          results.push({ id: use.id, name: use.name, content: cached })
          if (repeats >= 3) loopingOut = true
          continue
        }
        if (!TERMINAL_TOOLS.has(use.name)) evidenceCalls++

        try {
          const out = await def.run(use.input, ctx)
          if (!TERMINAL_TOOLS.has(use.name)) seen.set(fingerprint, JSON.stringify(out))

          const input = use.input
          let narrowedBy: string | undefined
          if (use.name === 'get_intraday_shape') {
            shapeFinding = (out as { shape?: string }).shape ?? null
          }
          // A search confined to less than half the window was narrowed on
          // purpose. Attributing it makes the branch visible rather than claimed.
          if (use.name === 'search_market_events' && typeof input.from === 'string' && typeof input.to === 'string') {
            const span = new Date(input.to).getTime() - new Date(input.from).getTime()
            const full = input.windowMs ?? (ctx.windowEnd.getTime() - ctx.windowStart.getTime())
            if (span > 0 && span < Number(full) * 0.5 && shapeFinding) {
              narrowedBy = `intraday shape came back ${shapeFinding}`
            }
          }

          const step: TrailStep = {
            seq: trail.length + 1,
            tool: use.name,
            label: def.label,
            headline: def.headline ? def.headline(out, input) : 'completed',
            at: new Date().toISOString(),
            ...(narrowedBy ? { narrowedBy } : {}),
          }
          trail.push(step)
          opts.onTrail?.(step)

          if (use.name === 'record_finding') {
            const parsed = findingSchema.safeParse(use.input)
            if (parsed.success) {
              findings.push(parsed.data)
              for (const e of parsed.data.evidence) evidenceTexts.push(e.observation)
            }
          }
          if (use.name === 'submit_conclusion') {
            const parsed = conclusionSchema.safeParse(use.input)
            if (parsed.success) conclusion = parsed.data
          }

          evidenceTexts.push(JSON.stringify(out))
          results.push({ id: use.id, name: use.name, content: JSON.stringify(out) })
        } catch (err) {
          results.push({
            id: use.id, name: use.name, isError: true,
            content: `Tool failed: ${(err as Error).message}`,
          })
        }
      }

      history.push({ role: 'tool', results })
      if (conclusion) break
      if (loopingOut) {
        return failWith(fallback, stages, toolCalls, trail,
          'The investigation repeated itself without making progress.', guardRejections)
      }
    }
  } catch (err) {
    if (err instanceof LlmUnavailable) {
      const detail = err.status ? ` (${err.status})` : ''
      return failWith(fallback, stages, toolCalls, trail, `AI investigation unavailable${detail}.`, guardRejections)
    }
    return failWith(fallback, stages, toolCalls, trail, AGENT_UNAVAILABLE_NOTE, guardRejections)
  }

  if (!conclusion) {
    return failWith(fallback, stages, toolCalls, trail,
      'Investigation did not reach a conclusion within its budget.', guardRejections)
  }

  // ---- guards: a prompt is a hope, a check is a guarantee -------------------
  const lint = lintConclusion(conclusion.conclusion)
  if (!lint.ok) {
    guardRejections.push(`Predictive or advisory language: ${lint.violations.join(', ')}`)
  }
  const grounding = checkNumericGrounding(conclusion.conclusion, evidenceTexts)
  if (!grounding.ok) {
    guardRejections.push(`Ungrounded figures: ${grounding.ungrounded.join(', ')}`)
  }
  if (guardRejections.length > 0) {
    // The model's wording is discarded; its hypothesis and the evidence stand.
    return {
      status: 'COMPLETED',
      conclusion: { ...fallback.conclusion, primary_hypothesis: conclusion.primary_hypothesis },
      findings: findings.length ? findings : fallback.findings,
      toolCalls, trail, stages, fallbackUsed: true,
      note: 'The generated explanation failed an output guard and was replaced with the deterministic one.',
      guardRejections,
    }
  }

  return {
    status: conclusion.insufficient_evidence ? 'INSUFFICIENT_EVIDENCE' : 'COMPLETED',
    conclusion,
    findings,
    toolCalls,
    trail,
    stages,
    fallbackUsed: false,
    note: null,
    guardRejections,
  }
}

function failWith(
  fallback: { conclusion: Conclusion; findings: Finding[] },
  stages: Stage[],
  toolCalls: InvestigationResult['toolCalls'],
  trail: TrailStep[],
  note: string,
  guardRejections: string[],
): InvestigationResult {
  return {
    status: 'COMPLETED', ...fallback, toolCalls, trail, stages,
    fallbackUsed: true, note, guardRejections,
  }
}

/** The steps the scoring engine actually performed, for the no-model path. */
function deterministicTrail(input: InvestigationInput): TrailStep[] {
  const now = new Date().toISOString()
  const s = input.score
  const steps: TrailStep[] = [{
    seq: 1, tool: 'scoring_engine', label: 'Decomposed the move',
    headline: s.residualZ !== null
      ? `${Math.abs(s.residualZ).toFixed(1)}σ unexplained by the market`
      : 'decomposition unavailable',
    at: now,
  }]
  if (input.volumeMultiple) {
    steps.push({
      seq: steps.length + 1, tool: 'scoring_engine', label: 'Inspected volume',
      headline: `${input.volumeMultiple.toFixed(1)}x normal`, at: now,
    })
  }
  steps.push({
    seq: steps.length + 1, tool: 'scoring_engine', label: 'Checked for events',
    headline: input.hasEvent ? 'an event was published in this window' : 'no event on record',
    at: now,
  })
  return steps
}

function fmt(v: number | null, dp = 2): string {
  return v === null ? 'n/a' : v.toFixed(dp)
}
