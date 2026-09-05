/**
 * @since/core — the domain.
 *
 * HARD RULE: this package is pure. No database, no network, no LLM, no clock.
 * Every function takes its inputs explicitly and returns a value.
 *
 * This is not stylistic. It is what lets the offline evaluation harness run the
 * EXACT production scoring code against historical data. If eval and production
 * could drift, the measured Precision@3 in the README would mean nothing.
 * See DECISIONS.md #3.
 */
export const CORE_VERSION = '0.1.0'

export * from './types.js'
export * from './stats/robust.js'
export * from './stats/regression.js'
export * from './market/decompose.js'
export * from './quality/gate.js'
export * from './quality/provenance.js'
export * from './quality/sanity.js'
export * from './signals/index.js'
export * from './scoring/calibrate.js'
export * from './scoring/composite.js'
export * from './scoring/tier.js'
export * from './time/market.js'
export * from './time/markets.js'
export * from './diff/window.js'
export * from './brief/compose.js'
