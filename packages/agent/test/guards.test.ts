import { describe, it, expect } from 'vitest'
import { lintConclusion, checkNumericGrounding } from '../src/guards.js'
import { deterministicConclusion, AGENT_UNAVAILABLE_NOTE } from '../src/fallback.js'
import { conclusionSchema, findingSchema } from '../src/schema.js'
import { investigate } from '../src/loop.js'
import { resolveProvider } from '../src/llm/index.js'
import type { ScoreResult } from '@since/core'

const score: ScoreResult = {
  symbolId: 'HDFCBANK.NS', raw: 7.04, pctl: 99.8, tier: 'CRITICAL',
  contributions: [], quality: 'FRESH', qualityReason: 'Live',
  returnPct: -7.84, expectedPct: -3.4, residualPct: -4.6, residualZ: -3.73, degraded: null,
}

describe('compliance linter', () => {
  it('rejects advice and prediction outright', () => {
    for (const bad of [
      'HDFC Bank looks undervalued at these levels.',
      'The stock will rise once results are published.',
      'We recommend investors buy on this dip.',
      'Sentiment is bearish and the outlook is weak.',
    ]) {
      expect(lintConclusion(bad).ok).toBe(false)
    }
  })

  it('rejects causal assertions, not just advice', () => {
    // The timing of an event relative to a move is an ordering we observed, not
    // a mechanism we established. Saying otherwise is the easiest way for this
    // product to be confidently wrong.
    for (const bad of [
      'The results announcement triggered a 7% drop.',
      'The stock fell because of the guidance cut.',
      'Weak demand caused by the festive slowdown drove the decline.',
    ]) {
      expect(lintConclusion(bad).ok).toBe(false)
    }
  })

  it('accepts the honest phrasing of the same observation', () => {
    const good =
      'HDFC Bank fell 7.8% after results were published at 06:00. The move was concentrated ' +
      'in one five-minute bar and was not shared by sector peers.'
    expect(lintConclusion(good).ok).toBe(true)
  })

  it('accepts purely descriptive, past-tense statements', () => {
    const good =
      'HDFC Bank fell 7.8% against a market-implied 3.4%, leaving 4.6% unexplained by the index. ' +
      'Volume was 2.6 times its 20-session median.'
    expect(lintConclusion(good).ok).toBe(true)
  })
})

describe('numeric grounding', () => {
  const evidence = [
    'Stock return -7.84%, market implied -3.40%, residual -4.60%',
    'Volume multiple of normal: 2.6',
  ]

  it('accepts figures that appeared in the evidence, allowing for rounding', () => {
    const r = checkNumericGrounding('It fell 7.8% versus an implied 3.4%, on 2.6x volume.', evidence)
    expect(r.ok).toBe(true)
  })

  it('catches a fabricated figure', () => {
    // 43.2 never appeared anywhere in the tool output.
    const r = checkNumericGrounding('Provisions rose 43.2% year on year.', evidence)
    expect(r.ok).toBe(false)
    expect(r.ungrounded).toContain('43.2')
  })

  it('does not flag ordinary small integers used as words', () => {
    expect(checkNumericGrounding('Across 3 sessions the move persisted.', evidence).ok).toBe(true)
  })
})

describe('schemas', () => {
  it('rejects an unknown hypothesis', () => {
    expect(findingSchema.safeParse({
      hypothesis: 'VIBES', verdict: 'SUPPORTED', reason: 'x', evidence: [],
    }).success).toBe(false)
  })

  it('requires insufficient_evidence to be explicit, never inferred', () => {
    expect(conclusionSchema.safeParse({
      primary_hypothesis: 'EVENT', conclusion: 'Something happened here.', confidence: 'HIGH',
    }).success).toBe(false)
  })
})

describe('deterministic fallback', () => {
  it('produces a complete, guard-clean explanation with no model involved', () => {
    const { conclusion, findings } = deterministicConclusion({ symbolName: 'HDFC Bank', score })
    expect(conclusion.conclusion).toMatch(/-7.8%/)
    expect(lintConclusion(conclusion.conclusion).ok).toBe(true)
    expect(findings).toHaveLength(1)
  })
})

describe('provider selection', () => {
  it('prefers Gemini when both keys are present — its free tier is the point', () => {
    const p = resolveProvider({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' } as NodeJS.ProcessEnv)
    expect(p?.name).toBe('gemini')
  })

  it('falls back to Anthropic when only that key is set', () => {
    expect(resolveProvider({ ANTHROPIC_API_KEY: 'a' } as NodeJS.ProcessEnv)?.name).toBe('anthropic')
  })

  it('honours an explicit override', () => {
    const env = { AGENT_PROVIDER: 'anthropic', GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }
    expect(resolveProvider(env as NodeJS.ProcessEnv)?.name).toBe('anthropic')
  })

  it('returns null with no keys, which is a normal outcome', () => {
    expect(resolveProvider({} as NodeJS.ProcessEnv)).toBeNull()
  })

  it('treats a declared-but-empty key as absent', () => {
    // A fresh .env declares every variable with no value. Passing '' to an SDK
    // surfaces as an auth failure that looks like a broken integration.
    expect(resolveProvider({ GEMINI_API_KEY: '' } as NodeJS.ProcessEnv)).toBeNull()
    expect(resolveProvider({ GEMINI_API_KEY: '   ' } as NodeJS.ProcessEnv)).toBeNull()
    const env = { AGENT_PROVIDER: 'gemini', GEMINI_API_KEY: '' }
    expect(resolveProvider(env as NodeJS.ProcessEnv)).toBeNull()
  })

  it('returns null when a forced provider has no key, rather than silently using the other', () => {
    const env = { AGENT_PROVIDER: 'gemini', ANTHROPIC_API_KEY: 'a' }
    expect(resolveProvider(env as NodeJS.ProcessEnv)).toBeNull()
  })
})

describe('agent availability', () => {
  it('returns a usable result with no provider and makes no network call', async () => {
    const r = await investigate({
      symbolId: 'HDFCBANK.NS', symbolName: 'HDFC Bank',
      windowStart: new Date('2026-09-04T04:44:00Z'), windowEnd: new Date('2026-09-04T10:00:00Z'),
      benchmarkId: '^NSEI', score,
    }, { provider: null })

    expect(r.status).toBe('COMPLETED')
    expect(r.fallbackUsed).toBe(true)
    expect(r.note).toBe(AGENT_UNAVAILABLE_NOTE)
    expect(r.conclusion.conclusion.length).toBeGreaterThan(10)   // never blank
  })
})
