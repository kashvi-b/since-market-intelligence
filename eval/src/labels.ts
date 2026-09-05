/**
 * What counts as "a change that deserved attention"?
 *
 * There is no ground truth for this, so we need a documented proxy — and the
 * honest thing is to test more than one, because a metric that only holds under
 * the label you happened to choose is not evidence of anything.
 *
 * The intuition behind all three: a move deserved your attention if it was the
 * start of a genuine repricing rather than noise that reverted by lunchtime.
 * Every label is computed from data STRICTLY AFTER the decision date, so no
 * ranker can see it.
 */
export interface LabelDef {
  id: string
  description: string
  /** Sessions after the decision date over which follow-through is measured. */
  horizon: number
  /** Residual sigmas the follow-through must exceed. */
  sigmas: number
}

export const LABELS: LabelDef[] = [
  {
    id: 'followthrough-1.5s-2d',
    description: 'Market-adjusted move over the next 2 sessions exceeded 1.5σ of the symbol\'s own residual scale',
    horizon: 2,
    sigmas: 1.5,
  },
  {
    id: 'followthrough-2.0s-3d',
    description: 'Market-adjusted move over the next 3 sessions exceeded 2.0σ',
    horizon: 3,
    sigmas: 2.0,
  },
  {
    id: 'followthrough-1.0s-1d',
    description: 'Market-adjusted move on the next session alone exceeded 1.0σ',
    horizon: 1,
    sigmas: 1.0,
  },
]

/** True when the forward residual move clears the label's bar. */
export function isMeaningful(
  forwardResiduals: readonly number[],
  residSigma: number,
  label: LabelDef,
): boolean {
  if (forwardResiduals.length < label.horizon || residSigma <= 0) return false
  const cumulative = forwardResiduals
    .slice(0, label.horizon)
    .reduce((a, b) => a + b, 0)
  const scaled = residSigma * Math.sqrt(label.horizon)
  return Math.abs(cumulative) > label.sigmas * scaled
}
