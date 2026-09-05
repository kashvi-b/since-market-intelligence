/**
 * Since — database schema.
 *
 * The schema is split into three regions, and the split is load-bearing:
 *
 *   MARKET TRUTH  — facts about the market. Shared by every user, computed once
 *                   per symbol. Scales with the number of distinct symbols
 *                   (~2,000 across a whole broker), never with the user count.
 *
 *   USER TRUTH    — facts about one person. Cheap, small, applied at read time.
 *                   Scales with users x watchlist size, but only ever as a join.
 *
 *   DERIVED       — the product of the two: what changed for THIS user, and what
 *                   the agent found out about it.
 *
 * See DECISIONS.md #2 for why this boundary exists and what it buys at scale.
 */
import {
  pgTable, pgEnum, text, integer, bigint, doublePrecision, boolean,
  timestamp, date, jsonb, primaryKey, uniqueIndex, index,
} from 'drizzle-orm/pg-core'

import type { SignalKey } from '@since/core'

/** Mirror of @since/core's SignalContribution, stored verbatim on a change event. */
export interface StoredContribution {
  key: SignalKey
  label: string
  z: number
  weight: number
  points: number
  detail: string
}

/* ------------------------------------------------------------------ enums */

/** How much we trust a price at the moment we are about to reason about it. */
export const dataQuality = pgEnum('data_quality', [
  'FRESH',        // within the freshness budget for this market session
  'DELAYED',      // older than fresh, still inside the usable window
  'STALE',        // too old to reason about — we suppress rather than guess
  'UNAVAILABLE',  // no value at all
  'CONFLICTING',  // sources disagree beyond tolerance
  'SUSPECT',      // fails a sanity check (suspected corporate action / bad tick)
])

/** Attention tier. Derived from a calibrated percentile, not a raw magnitude. */
export const attentionTier = pgEnum('attention_tier', [
  'NORMAL',          // filtered out — the product's most common answer
  'WORTH_WATCHING',  // p >= 90
  'SIGNIFICANT',     // p >= 95
  'CRITICAL',        // p >= 99
  'SUPPRESSED',      // scored high but data quality failed the gate
])

/** The user's own false-positive budget, expressed as a percentile threshold. */
export const attentionBudget = pgEnum('attention_budget', ['LOW', 'MEDIUM', 'HIGH'])

/** Fixed hypothesis set the investigation agent eliminates against. */
export const hypothesisId = pgEnum('hypothesis_id', [
  'MARKET',        // explained by the index move
  'SECTOR',        // explained by a sector/peer move
  'EVENT',         // company-specific event inside the window
  'UNEXPLAINED',   // idiosyncratic, no supporting evidence found
  'DATA_ARTIFACT', // corporate action or bad data, not a real move
])

export const investigationStatus = pgEnum('investigation_status', [
  'PENDING', 'INVESTIGATING', 'COMPLETED', 'INSUFFICIENT_EVIDENCE', 'FAILED',
])

export const evidenceStance = pgEnum('evidence_stance', ['SUPPORTS', 'CONTRADICTS', 'NEUTRAL'])
export const symbolStatus = pgEnum('symbol_status', ['ACTIVE', 'SUSPENDED', 'DELISTED'])
export const corpActionType = pgEnum('corp_action_type', ['SPLIT', 'BONUS', 'DIVIDEND', 'RIGHTS', 'MERGER'])
export const thresholdKind = pgEnum('threshold_kind', ['ABOVE', 'BELOW'])
export const feedbackVerdict = pgEnum('feedback_verdict', ['USEFUL', 'NOT_USEFUL'])

/* ----------------------------------------------------------- market truth */

export const sectors = pgTable('sectors', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Proxy index for the sector, when NSE publishes one (e.g. ^CNXIT). */
  indexTicker: text('index_ticker'),
})

export const symbols = pgTable('symbols', {
  id: text('id').primaryKey(),               // e.g. "HDFCBANK.NS"
  ticker: text('ticker').notNull(),          // e.g. "HDFCBANK"
  name: text('name').notNull(),
  exchange: text('exchange').notNull().default('NSE'),
  sectorId: text('sector_id').references(() => sectors.id),
  currency: text('currency').notNull().default('INR'),
  /** True for ^NSEI and sector indices — benchmarks, not watchable instruments. */
  isIndex: boolean('is_index').notNull().default(false),
  status: symbolStatus('status').notNull().default('ACTIVE'),
  listedOn: date('listed_on'),
  delistedOn: date('delisted_on'),
}, (t) => ({
  tickerIdx: uniqueIndex('symbols_ticker_exchange_idx').on(t.ticker, t.exchange),
  sectorIdx: index('symbols_sector_idx').on(t.sectorId),
}))

/**
 * Daily OHLCV. `close` is as-traded; `adjClose` is corporate-action adjusted.
 * Keeping both is what lets us DETECT a split (their ratios diverge) rather
 * than silently ingesting a -50% move as real. See DECISIONS.md #5.
 */
export const dailyBars = pgTable('daily_bars', {
  symbolId: text('symbol_id').notNull().references(() => symbols.id, { onDelete: 'cascade' }),
  date: date('date').notNull(),
  open: doublePrecision('open').notNull(),
  high: doublePrecision('high').notNull(),
  low: doublePrecision('low').notNull(),
  close: doublePrecision('close').notNull(),
  adjClose: doublePrecision('adj_close').notNull(),
  volume: bigint('volume', { mode: 'number' }).notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.symbolId, t.date] }),
  bySymbolDate: index('daily_bars_symbol_date_idx').on(t.symbolId, t.date.desc()),
}))

/** Intraday bars. Powers replay and the "when inside the window did it move?" tool. */
export const intradayBars = pgTable('intraday_bars', {
  symbolId: text('symbol_id').notNull().references(() => symbols.id, { onDelete: 'cascade' }),
  ts: timestamp('ts', { withTimezone: true }).notNull(),
  interval: text('interval').notNull(),      // '5m' | '15m'
  open: doublePrecision('open').notNull(),
  high: doublePrecision('high').notNull(),
  low: doublePrecision('low').notNull(),
  close: doublePrecision('close').notNull(),
  volume: bigint('volume', { mode: 'number' }).notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.symbolId, t.ts, t.interval] }),
  bySymbolTs: index('intraday_bars_symbol_ts_idx').on(t.symbolId, t.ts.desc()),
}))

export const corporateActions = pgTable('corporate_actions', {
  id: text('id').primaryKey(),
  symbolId: text('symbol_id').notNull().references(() => symbols.id, { onDelete: 'cascade' }),
  exDate: date('ex_date').notNull(),
  type: corpActionType('type').notNull(),
  /** Split 1:2 -> 0.5. Dividend -> absolute amount. */
  ratio: doublePrecision('ratio'),
  notes: text('notes'),
}, (t) => ({
  bySymbolDate: index('corp_actions_symbol_date_idx').on(t.symbolId, t.exDate.desc()),
  dedupe: uniqueIndex('corp_actions_dedupe_idx').on(t.symbolId, t.exDate, t.type),
}))

/**
 * Precomputed rolling statistics, one row per symbol per day.
 * This is the "computed once, read by every user" table — the reason the
 * system scales with symbol count rather than user count.
 */
export const symbolStats = pgTable('symbol_stats', {
  symbolId: text('symbol_id').notNull().references(() => symbols.id, { onDelete: 'cascade' }),
  asOf: date('as_of').notNull(),
  /** OLS slope of this symbol's daily log returns against the index, 60 sessions. */
  beta: doublePrecision('beta'),
  /** Robust scale of the residual: 1.4826 * MAD. Not stdev — see DECISIONS.md #4. */
  residMad: doublePrecision('resid_mad'),
  residMedian: doublePrecision('resid_median'),
  volMedian20: doublePrecision('vol_median_20'),
  volMad20: doublePrecision('vol_mad_20'),
  gapSigma: doublePrecision('gap_sigma'),
  high52w: doublePrecision('high_52w'),
  low52w: doublePrecision('low_52w'),
  /** Empirical CDF of the composite `raw` score over 250 trailing sessions. */
  pctlGrid: jsonb('pctl_grid').$type<number[]>(),
  sampleN: integer('sample_n').notNull().default(0),
  quality: dataQuality('quality').notNull().default('FRESH'),
}, (t) => ({
  pk: primaryKey({ columns: [t.symbolId, t.asOf] }),
  bySymbolAsOf: index('symbol_stats_symbol_asof_idx').on(t.symbolId, t.asOf.desc()),
}))

/**
 * Point-in-time quotes with provenance. Never a bare number:
 * every observation carries where it came from, when the market produced it,
 * when we received it, and how much we trust it.
 *
 * UNIQUE(symbol, source, observed_at) makes ingestion idempotent — a retried
 * or duplicated tick is a no-op rather than a double-count.
 */
export const observations = pgTable('observations', {
  id: text('id').primaryKey(),
  symbolId: text('symbol_id').notNull().references(() => symbols.id, { onDelete: 'cascade' }),
  price: doublePrecision('price'),
  volume: bigint('volume', { mode: 'number' }),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  source: text('source').notNull(),
  quality: dataQuality('quality').notNull(),
  raw: jsonb('raw'),
}, (t) => ({
  dedupe: uniqueIndex('observations_dedupe_idx').on(t.symbolId, t.source, t.observedAt),
  bySymbolObserved: index('observations_symbol_observed_idx').on(t.symbolId, t.observedAt.desc()),
}))

export const marketEvents = pgTable('market_events', {
  id: text('id').primaryKey(),
  symbolId: text('symbol_id').references(() => symbols.id, { onDelete: 'cascade' }),
  /** Publication time. Compared against when the move actually started. */
  publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
  type: text('type').notNull(),          // 'RESULTS' | 'ANNOUNCEMENT' | 'NEWS' | ...
  headline: text('headline').notNull(),
  url: text('url'),
  source: text('source').notNull(),
}, (t) => ({
  bySymbolPublished: index('market_events_symbol_published_idx').on(t.symbolId, t.publishedAt.desc()),
  dedupe: uniqueIndex('market_events_dedupe_idx').on(t.symbolId, t.publishedAt, t.headline),
}))

/**
 * Bars excluded from every statistic, and why.
 *
 * Detecting a corporate action is worthless if the only evidence is a line in an
 * ingest log nobody reads. Persisting it makes the system's integrity work
 * visible — and lets the UI explain what would have gone wrong without it.
 */
export const dataQuarantine = pgTable('data_quarantine', {
  id: text('id').primaryKey(),
  symbolId: text('symbol_id').notNull().references(() => symbols.id, { onDelete: 'cascade' }),
  date: date('date').notNull(),
  /** What the check concluded, in the words the detector used. */
  reason: text('reason').notNull(),
  /** Corporate-action ratio implied by the raw/adjusted divergence, when known. */
  impliedRatio: doublePrecision('implied_ratio'),
  /** The move that would have been reported had the bar not been quarantined. */
  apparentMovePct: doublePrecision('apparent_move_pct'),
  detectedAt: timestamp('detected_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  dedupe: uniqueIndex('data_quarantine_dedupe_idx').on(t.symbolId, t.date),
  bySymbol: index('data_quarantine_symbol_idx').on(t.symbolId, t.date.desc()),
}))

/* ------------------------------------------------------------- user truth */

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  emailIdx: uniqueIndex('users_email_idx').on(t.email),
}))

export const watchlists = pgTable('watchlists', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull().default('My watchlist'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byUser: index('watchlists_user_idx').on(t.userId),
}))

export const watchlistItems = pgTable('watchlist_items', {
  id: text('id').primaryKey(),
  watchlistId: text('watchlist_id').notNull().references(() => watchlists.id, { onDelete: 'cascade' }),
  symbolId: text('symbol_id').notNull().references(() => symbols.id, { onDelete: 'cascade' }),
  position: integer('position').notNull().default(0),
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  dedupe: uniqueIndex('watchlist_items_dedupe_idx').on(t.watchlistId, t.symbolId),
}))

/**
 * THE READ CURSOR. Per (user, symbol) — not per watchlist.
 *
 * Per-symbol is the whole point: glancing at the app must not mark every symbol
 * seen. Opening HDFCBANK marks HDFCBANK read and leaves TCS unread, exactly like
 * an inbox.
 *
 * Cross-device sync is a max-merge on `lastSeenVersion` (a monotonic clock),
 * written with a single `GREATEST(...)` upsert. That makes the merge idempotent,
 * commutative and associative — a grow-only register, the simplest CRDT there is,
 * with no library. Out-of-order device sync can never un-read something.
 * See DECISIONS.md #6.
 */
export const readCursors = pgTable('read_cursors', {
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  symbolId: text('symbol_id').notNull().references(() => symbols.id, { onDelete: 'cascade' }),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  lastSeenVersion: bigint('last_seen_version', { mode: 'number' }).notNull(),
  /** Snapshot of what they actually saw — the left-hand side of the diff. */
  lastSeenPrice: doublePrecision('last_seen_price'),
  lastSeenObservationId: text('last_seen_observation_id'),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.symbolId] }),
}))

export const userThresholds = pgTable('user_thresholds', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  symbolId: text('symbol_id').notNull().references(() => symbols.id, { onDelete: 'cascade' }),
  kind: thresholdKind('kind').notNull(),
  value: doublePrecision('value').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  byUserSymbol: index('user_thresholds_user_symbol_idx').on(t.userId, t.symbolId),
}))

export const attentionSettings = pgTable('attention_settings', {
  userId: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  budget: attentionBudget('budget').notNull().default('MEDIUM'),
  /** Hard cap on cards. The product refuses to show more, even in a crash. */
  maxCards: integer('max_cards').notNull().default(3),
})

/* ----------------------------------------------------------------- derived */

/**
 * One detected change, for one user, over one window.
 * `dedupeKey` = hash(user, symbol, windowEnd bucket, tier) so a repeated
 * evaluation of the same window is idempotent and never double-alerts.
 */
export const changeEvents = pgTable('change_events', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  symbolId: text('symbol_id').notNull().references(() => symbols.id, { onDelete: 'cascade' }),
  windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
  windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
  /** Sum of weighted, clipped z-scores. The thing the WHY panel decomposes. */
  raw: doublePrecision('raw').notNull(),
  /** Calibrated percentile of `raw` against this symbol's own history. 0-100. */
  pctl: doublePrecision('pctl').notNull(),
  tier: attentionTier('tier').notNull(),
  /** Full per-signal contributions, so WHY is reproducible from stored data alone. */
  contributions: jsonb('contributions').$type<StoredContribution[]>().notNull(),
  returnPct: doublePrecision('return_pct'),
  /** The decomposition, stored so the explanation never has to be recomputed. */
  expectedPct: doublePrecision('expected_pct'),
  residualPct: doublePrecision('residual_pct'),
  residualZ: doublePrecision('residual_z'),
  quality: dataQuality('quality').notNull(),
  dedupeKey: text('dedupe_key').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  dedupe: uniqueIndex('change_events_dedupe_idx').on(t.dedupeKey),
  byUserCreated: index('change_events_user_created_idx').on(t.userId, t.createdAt.desc()),
}))

/**
 * An agent investigation. UNIQUE on changeEventId — asking twice returns the
 * first result rather than burning tokens and risking a contradictory answer.
 */
export const investigations = pgTable('investigations', {
  id: text('id').primaryKey(),
  changeEventId: text('change_event_id').notNull().references(() => changeEvents.id, { onDelete: 'cascade' }),
  status: investigationStatus('status').notNull().default('PENDING'),
  /** Which hypothesis survived elimination. */
  primaryHypothesis: hypothesisId('primary_hypothesis'),
  /** Verdict per hypothesis: supported | rejected | insufficient, with reasons. */
  hypotheses: jsonb('hypotheses').$type<unknown[]>(),
  /** Ordered record of what the investigation did and what each step found. */
  toolTrail: jsonb('tool_trail').$type<unknown[]>(),
  conclusion: text('conclusion'),
  confidence: text('confidence'),          // 'HIGH' | 'MEDIUM' | 'LOW'
  toolCalls: integer('tool_calls').notNull().default(0),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  /** Populated when the LLM is unavailable or its output fails validation. */
  fallbackUsed: boolean('fallback_used').notNull().default(false),
}, (t) => ({
  oneA: uniqueIndex('investigations_change_event_idx').on(t.changeEventId),
}))

export const evidence = pgTable('evidence', {
  id: text('id').primaryKey(),
  investigationId: text('investigation_id').notNull().references(() => investigations.id, { onDelete: 'cascade' }),
  hypothesis: hypothesisId('hypothesis'),
  type: text('type').notNull(),            // 'DECOMPOSITION' | 'PEER' | 'VOLUME' | 'EVENT' | ...
  source: text('source').notNull(),
  observation: text('observation').notNull(),
  observedAt: timestamp('observed_at', { withTimezone: true }),
  stance: evidenceStance('stance').notNull(),
  reliability: doublePrecision('reliability'),
}, (t) => ({
  byInvestigation: index('evidence_investigation_idx').on(t.investigationId),
}))

export const attentionFeedback = pgTable('attention_feedback', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  changeEventId: text('change_event_id').notNull().references(() => changeEvents.id, { onDelete: 'cascade' }),
  verdict: feedbackVerdict('verdict').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  dedupe: uniqueIndex('attention_feedback_dedupe_idx').on(t.userId, t.changeEventId),
}))
