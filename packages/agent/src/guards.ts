/**
 * Output guards.
 *
 * The agent is allowed to reason about evidence. It is not allowed to invent
 * numbers, and it is not allowed to give financial advice. Both are enforced
 * mechanically after generation rather than merely requested in the prompt,
 * because a prompt is a hope and a check is a guarantee.
 */

/**
 * Words that turn a description into a prediction or a recommendation.
 *
 * Since is an information product operating on Indian equities. A conclusion
 * that reads as a rating or a call is a compliance problem, not merely a tone
 * problem, so the linter is a hard gate rather than a warning.
 */
const FORBIDDEN = [
  // Causal assertions. An event that precedes a move is an ordering we observed,
  // not a mechanism we established — and a product that states the difference
  // wrongly is wrong in exactly the way markets punish.
  'caused by', 'because of', 'due to the', 'triggered the', 'triggered a',
  'drove the', 'led to the', 'resulted in the',
  'buy', 'sell', 'hold', 'target price', 'price target', 'should invest',
  'will rise', 'will fall', 'will go', 'expect it to', 'we expect', 'poised to',
  'set to rise', 'set to fall', 'recommend', 'undervalued', 'overvalued',
  'bullish', 'bearish', 'rally ahead', 'outlook is',
]

export interface LintResult { ok: boolean; violations: string[] }

export function lintConclusion(text: string): LintResult {
  const lower = text.toLowerCase()
  const violations = FORBIDDEN.filter((w) => lower.includes(w))
  return { ok: violations.length === 0, violations }
}

/**
 * Numeric grounding: every number the agent states must appear in the evidence
 * it gathered. This is the anti-hallucination mechanism that matters, because a
 * plausible wrong number is far more damaging than a vague sentence.
 *
 * Numbers are compared with tolerance so that "2.4x" grounds "2.43", and small
 * integers (1-12, years, percentages of the form "50%") are exempt because they
 * are ordinarily linguistic rather than factual claims.
 */
export function checkNumericGrounding(
  conclusion: string,
  evidenceTexts: readonly string[],
): { ok: boolean; ungrounded: string[] } {
  const claimed = extractNumbers(conclusion)
  const supported = evidenceTexts.flatMap(extractNumbers)
  const ungrounded: string[] = []

  for (const n of claimed) {
    if (Math.abs(n) <= 12 && Number.isInteger(n)) continue      // ordinal / count
    const matched = supported.some((s) => close(n, s))
    if (!matched) ungrounded.push(String(n))
  }
  return { ok: ungrounded.length === 0, ungrounded }
}

function close(a: number, b: number): boolean {
  if (a === b) return true
  const scale = Math.max(Math.abs(a), Math.abs(b), 1)
  return Math.abs(a - b) / scale < 0.06     // 6% — tolerates rounding in prose
}

function extractNumbers(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(/-?\d+(?:,\d{3})*(?:\.\d+)?/g)) {
    const v = Number(m[0].replace(/,/g, ''))
    if (Number.isFinite(v)) out.push(Math.abs(v))
  }
  return out
}
