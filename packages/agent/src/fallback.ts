import type { ScoreResult } from '@since/core'
import type { Conclusion, Finding } from './schema.js'

/**
 * The deterministic explanation.
 *
 * Computed BEFORE the agent runs, always. If the LLM is unavailable, times out,
 * or returns something that fails validation, this is what the user sees — so a
 * card can never be blank and the product never depends on a third party being
 * up. Losing the agent costs one sentence of nuance, not the feature.
 */
export function deterministicConclusion(params: {
  symbolName: string
  score: ScoreResult
  sectorName?: string | null
  peerMedianResidualPct?: number | null
  volumeMultiple?: number | null
  hasEvent?: boolean
}): { conclusion: Conclusion; findings: Finding[] } {
  const { symbolName, score } = params
  const dir = (score.residualPct ?? 0) < 0 ? 'weaker' : 'stronger'
  const z = Math.abs(score.residualZ ?? 0)

  const parts: string[] = []
  if (score.returnPct !== null) {
    parts.push(`${symbolName} moved ${score.returnPct.toFixed(1)}%`)
  }
  if (score.expectedPct !== null && score.residualPct !== null) {
    parts.push(
      `against a market-implied ${score.expectedPct.toFixed(1)}%, leaving ` +
      `${Math.abs(score.residualPct).toFixed(1)}% ${dir} than the market explains (${z.toFixed(1)}σ)`,
    )
  }
  if (params.volumeMultiple) parts.push(`on ${params.volumeMultiple.toFixed(1)}× usual volume`)

  const primary = params.hasEvent ? 'EVENT'
    : params.peerMedianResidualPct !== null && params.peerMedianResidualPct !== undefined
      && Math.abs(params.peerMedianResidualPct) > 1.5 ? 'SECTOR'
    : z >= 2 ? 'UNEXPLAINED' : 'MARKET'

  return {
    conclusion: {
      primary_hypothesis: primary,
      conclusion: parts.join(', ') + '.',
      confidence: 'MEDIUM',
      insufficient_evidence: primary === 'UNEXPLAINED',
    },
    findings: [{
      hypothesis: primary,
      verdict: primary === 'UNEXPLAINED' ? 'INSUFFICIENT' : 'SUPPORTED',
      reason: 'Derived from the deterministic decomposition without AI investigation.',
      evidence: [{
        type: 'DECOMPOSITION',
        source: 'since-scoring-engine',
        observation: parts.join(', '),
        stance: 'SUPPORTS',
      }],
    }],
  }
}

/** Shown when the agent is unavailable, so the failure is visible and honest. */
export const AGENT_UNAVAILABLE_NOTE =
  'AI investigation unavailable. This change was still detected and explained by the deterministic engine.'
