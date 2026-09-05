import type { AttentionBudget, AttentionTier, DataQuality } from '../types.js'
import { suppresses } from '../quality/gate.js'

/**
 * Tier is a property of the EVENT. Budget is a filter the USER applies on top.
 * Keeping them separate is what lets the budget mean something concrete:
 * the user is choosing a false-positive rate, not moving a vague slider.
 */
export const TIER_THRESHOLDS = { CRITICAL: 99, SIGNIFICANT: 95, WORTH_WATCHING: 90 } as const

export function tierFor(pctl: number | null, quality: DataQuality): AttentionTier {
  if (suppresses(quality)) return 'SUPPRESSED'
  if (pctl === null) return 'NORMAL'
  if (pctl >= TIER_THRESHOLDS.CRITICAL) return 'CRITICAL'
  if (pctl >= TIER_THRESHOLDS.SIGNIFICANT) return 'SIGNIFICANT'
  if (pctl >= TIER_THRESHOLDS.WORTH_WATCHING) return 'WORTH_WATCHING'
  return 'NORMAL'
}

/** Minimum percentile a change must reach to be shown, per budget. */
export const BUDGET_THRESHOLD: Record<AttentionBudget, number> = {
  LOW: TIER_THRESHOLDS.CRITICAL,        // 1-in-100 days
  MEDIUM: TIER_THRESHOLDS.SIGNIFICANT,  // 1-in-20 days
  HIGH: TIER_THRESHOLDS.WORTH_WATCHING, // 1-in-10 days
}

export const BUDGET_LABEL: Record<AttentionBudget, string> = {
  LOW: 'Only 1-in-100 days',
  MEDIUM: '1-in-20 days',
  HIGH: '1-in-10 days',
}

export function visibleUnderBudget(tier: AttentionTier, pctl: number | null, budget: AttentionBudget): boolean {
  if (tier === 'SUPPRESSED' || tier === 'NORMAL') return false
  if (pctl === null) return false
  return pctl >= BUDGET_THRESHOLD[budget]
}

const ORDER: Record<AttentionTier, number> = {
  CRITICAL: 4, SIGNIFICANT: 3, WORTH_WATCHING: 2, NORMAL: 1, SUPPRESSED: 0,
}
export function tierRank(t: AttentionTier): number { return ORDER[t] }
