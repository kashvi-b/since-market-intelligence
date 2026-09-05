import type { DataQuality } from '../types.js'

/**
 * What a displayed number actually is.
 *
 * Freshness alone is not enough to label a price honestly. A synthetic close is
 * "fresh" in the sense that it is the newest value we hold — and calling it
 * "Live" would be a lie in the one place the product claims not to tell them.
 * Provenance answers a different question: where did this come from, and is it
 * the real world, a simulation, or a historical instant being replayed?
 */
export type Provenance =
  | 'LIVE'         // real exchange data, current
  | 'SIMULATED'    // deterministic generated data
  | 'REPLAY'       // real data, but a past moment being re-evaluated
  | 'DELAYED'      // real and current, but behind
  | 'STALE'        // too old to reason about
  | 'UNAVAILABLE'  // nothing to show
  | 'CONFLICTING'  // sources disagree beyond tolerance
  | 'SUSPECT'      // failed a sanity check

export const PROVENANCE_LABEL: Record<Provenance, string> = {
  LIVE: 'Live',
  SIMULATED: 'Simulated',
  REPLAY: 'Replay',
  DELAYED: 'Delayed',
  STALE: 'Stale',
  UNAVAILABLE: 'Unavailable',
  CONFLICTING: 'Conflicting sources',
  SUSPECT: 'Quarantined',
}

/**
 * Order matters. A failure of trust outranks where the data came from: a stale
 * simulated price is stale first, because that is what governs whether we are
 * willing to say anything about it.
 */
export function provenanceOf(params: {
  quality: DataQuality
  /** True when the underlying dataset is generated rather than observed. */
  simulated: boolean
  /** True when evaluating a historical instant rather than now. */
  replay: boolean
}): Provenance {
  const { quality, simulated, replay } = params

  if (quality === 'UNAVAILABLE') return 'UNAVAILABLE'
  if (quality === 'CONFLICTING') return 'CONFLICTING'
  if (quality === 'SUSPECT') return 'SUSPECT'
  if (quality === 'STALE') return 'STALE'

  // Trust is intact — now say what the value actually is.
  if (simulated) return 'SIMULATED'
  if (replay) return 'REPLAY'
  return quality === 'DELAYED' ? 'DELAYED' : 'LIVE'
}

/** True when the state means "do not act on this". */
export function provenanceIsDegraded(p: Provenance): boolean {
  return p === 'STALE' || p === 'UNAVAILABLE' || p === 'CONFLICTING' || p === 'SUSPECT'
}
