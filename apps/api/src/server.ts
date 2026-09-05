import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { and, asc, eq, ilike, inArray, or, sql as dsql } from 'drizzle-orm'
import { db, schema, marketQueries as q } from '@since/db'
import {
  BUDGET_LABEL, BUDGET_THRESHOLD, frequencyPhrase, displayPercentile, istDate, logReturn,
  provenanceOf, type DataQuality,
  type AttentionBudget,
} from '@since/core'
import { investigate, type Stage } from '@since/agent'
import { evaluateBrief, calendar, providerInfo, activeMarket, benchmarkId, marketDate } from './services/brief.js'
import type { MarketDef } from '@since/core'

/** The client needs currency and timezone to render prices and times honestly. */
const marketPayload = (m: MarketDef) => ({
  id: m.id, label: m.label, timeZone: m.timeZone,
  currency: m.currency, locale: m.locale, benchmark: m.benchmarkLabel,
})
import { persistChanges, getChange, getInvestigation } from './services/changes.js'
import { randomUUID } from 'node:crypto'
import { badRequest, notFound, unauthorized, send, HttpError } from './errors.js'

const PORT = Number(process.env.PORT ?? 4000)
const DEMO_USER = 'user_demo'
const COOKIE_SECRET = process.env.COOKIE_SECRET ?? 'since-local-dev-secret-change-me'

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] },
})

await app.register(cors, { origin: true, credentials: true })

/**
 * Rate limiting, by cost rather than uniformly.
 *
 * Endpoints are not equally expensive. A watchlist read is a couple of indexed
 * queries; a brief scores an entire watchlist; an investigation calls a model
 * and costs real money. A single global limit would either be too loose to
 * protect the expensive paths or too tight to use the cheap ones, so each
 * category gets its own. See DECISIONS.md #16.
 */
export const LIMITS = {
  /** Default for ordinary reads and writes. */
  global: { max: 300, timeWindow: '1 minute' },
  /** Scores the whole watchlist — the most expensive read path. */
  brief: { max: 60, timeWindow: '1 minute' },
  /** Calls an LLM and spends money. Deliberately strict. */
  investigate: { max: 10, timeWindow: '1 minute' },
  /** Issues a session cookie. */
  session: { max: 20, timeWindow: '1 minute' },
} as const

await app.register(rateLimit, {
  global: true,
  ...LIMITS.global,
  // Behind the Next proxy every request appears to come from the same address,
  // so fall back to the forwarded address when one is present.
  keyGenerator: (req) => {
    const fwd = req.headers['x-forwarded-for']
    const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(',')[0]?.trim()
    return first || req.ip
  },
  // One error shape for the whole API — a limiter that returns a different
  // envelope is a client bug waiting to happen.
  errorResponseBuilder: (_req, ctx) => ({
    statusCode: 429,
    error: {
      code: 'RATE_LIMITED',
      message: `Too many requests. Try again in ${Math.ceil(ctx.ttl / 1000)}s.`,
      detail: { limit: ctx.max, windowMs: ctx.ttl },
    },
  }),
})

// A POST with no body is legitimate (e.g. starting a session). Treat an empty
// JSON payload as `{}` instead of rejecting the request.
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  const text = typeof body === 'string' ? body.trim() : ''
  if (text.length === 0) return done(null, {})
  try { done(null, JSON.parse(text)) } catch (err) { done(err as Error, undefined) }
})
await app.register(cookie, { secret: COOKIE_SECRET, hook: 'onRequest' })

/** Demo-grade session: a signed cookie naming the user. No passwords by design. */
function userIdOf(req: { cookies: Record<string, string | undefined>; unsignCookie: (v: string) => { valid: boolean; value: string | null } }): string {
  const raw = req.cookies['since_session']
  if (!raw) throw unauthorized('No session. POST /api/session/demo first.')
  const un = req.unsignCookie(raw)
  if (!un.valid || !un.value) throw unauthorized('Invalid session cookie.')
  // The seeded user is a template, not an identity. Cookies naming it were
  // handed out before sessions were cloned per visitor, they renew themselves
  // for thirty days, and read cursors only ever move forward — so one click
  // from one stale browser would burn a card out of every future visitor's
  // brief, permanently and invisibly. Refuse it; the caller mints a clone.
  if (un.value === DEMO_USER) throw unauthorized('Stale session. POST /api/session/demo first.')
  return un.value
}

const isoDate = z.string().datetime().optional()
const symbolIdSchema = z.string().regex(/^[A-Za-z0-9^&._-]{1,32}$/, 'Invalid symbol id')

app.setErrorHandler((err, _req, reply) => send(reply, err))

/* --------------------------------------------------------------- session */

/**
 * Give every visitor their own copy of the demo.
 *
 * "What changed since YOU last looked" is a claim about one reader. Handing
 * every visitor the same user made that literally false on a shared link: read
 * cursors are per (user, symbol), so the first person to open a card advanced
 * the cursor for everyone, and the next visitor arrived to a brief with that
 * stock already marked seen. On a link circulated to several reviewers the
 * product quietly emptied itself, one card per click, and the last reader saw
 * the least.
 *
 * Each session therefore gets a user cloned from the seeded template: the same
 * watchlist and the same starting cursors, but its own state to spend. Existing
 * sessions are reused, so a reload does not mint a new one.
 */
async function cloneDemoUser(): Promise<string> {
  const [template] = await db.select().from(schema.users)
    .where(eq(schema.users.id, DEMO_USER)).limit(1)
  if (!template) throw notFound('Demo user not seeded. Run `npm run ingest`.')

  const suffix = randomUUID().replace(/-/g, '').slice(0, 16)
  const userId = `user_${suffix}`
  const watchlistId = `wl_${suffix}`

  const items = await db.select({
    symbolId: schema.watchlistItems.symbolId, position: schema.watchlistItems.position,
  }).from(schema.watchlistItems)
    .innerJoin(schema.watchlists, eq(schema.watchlists.id, schema.watchlistItems.watchlistId))
    .where(eq(schema.watchlists.userId, DEMO_USER))

  const cursors = await db.select().from(schema.readCursors)
    .where(eq(schema.readCursors.userId, DEMO_USER))

  await db.insert(schema.users).values({
    id: userId, email: `${userId}@since.local`, displayName: template.displayName,
  })
  await db.insert(schema.watchlists).values({ id: watchlistId, userId, name: 'My watchlist' })
  if (items.length > 0) {
    await db.insert(schema.watchlistItems).values(items.map((i, n) => ({
      id: `wi_${suffix}_${n}`, watchlistId, symbolId: i.symbolId, position: i.position,
    })))
  }
  if (cursors.length > 0) {
    await db.insert(schema.readCursors).values(cursors.map((c) => ({
      userId, symbolId: c.symbolId, lastSeenAt: c.lastSeenAt,
      lastSeenVersion: c.lastSeenVersion, lastSeenPrice: c.lastSeenPrice,
      lastSeenObservationId: c.lastSeenObservationId,
    })))
  }
  return userId
}

app.post('/api/session/demo', { config: { rateLimit: LIMITS.session } }, async (req, reply) => {
  // Reuse a session that already exists, so reloading does not mint a user per
  // page view — and so a reader's own progress survives navigation.
  let userId: string | null = null
  const raw = (req as { cookies: Record<string, string | undefined> }).cookies['since_session']
  if (raw) {
    const un = (req as unknown as { unsignCookie: (v: string) => { valid: boolean; value: string | null } })
      .unsignCookie(raw)
    if (un.valid && un.value) {
      // Never re-adopt the template — see userIdOf.
      if (un.value !== DEMO_USER) {
        const [existing] = await db.select().from(schema.users)
          .where(eq(schema.users.id, un.value)).limit(1)
        if (existing) userId = existing.id
      }
    }
  }

  if (userId === null) userId = await cloneDemoUser()

  reply.setCookie('since_session', userId, {
    path: '/', httpOnly: true, sameSite: 'lax', signed: true,
    secure: process.env.NODE_ENV === 'production', maxAge: 60 * 60 * 24 * 30,
  })
  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1)
  if (!user) throw notFound('Session user vanished.')
  return { userId: user.id, email: user.email, displayName: user.displayName }
})

/* --------------------------------------------------------------- symbols */

app.get('/api/symbols/search', async (req) => {
  const { q: term } = z.object({ q: z.string().min(1).max(40) }).parse(req.query)
  const like = `%${term}%`
  const rows = await db.select({
    id: schema.symbols.id, ticker: schema.symbols.ticker,
    name: schema.symbols.name, sectorId: schema.symbols.sectorId,
  }).from(schema.symbols)
    .where(and(
      eq(schema.symbols.isIndex, false),
      eq(schema.symbols.status, 'ACTIVE'),
      or(ilike(schema.symbols.ticker, like), ilike(schema.symbols.name, like)),
      // Both universes share one database. Unfiltered, a US watchlist offered
      // the entire NIFTY 50 — and adding one put an Indian stock, priced in
      // rupees from a synthetic dataset, on the list behind a dollar sign.
      onThisMarket((await activeMarket()).id === 'nifty50'),
    ))
    .orderBy(asc(schema.symbols.ticker)).limit(20)
  return { results: rows }
})

/**
 * Restrict a symbol query to the active market.
 *
 * Market truth is keyed only by symbol, and the NSE tickers carry a `.NS`
 * suffix, so membership is readable from the id. Kept in one place because the
 * search box and the add endpoint must agree: filtering only the search would
 * still let a crafted request add a foreign symbol.
 */
function onThisMarket(isNse: boolean) {
  return isNse
    ? dsql`${schema.symbols.id} LIKE '%.NS'`
    : dsql`${schema.symbols.id} NOT LIKE '%.NS'`
}

/** True when a symbol belongs to the market this deployment is serving. */
function symbolIsOnMarket(symbolId: string, isNse: boolean): boolean {
  return symbolId.endsWith('.NS') === isNse
}

/* ------------------------------------------------------------- watchlist */

app.get('/api/watchlist', async (req) => {
  const userId = userIdOf(req as never)
  const [wl] = await db.select().from(schema.watchlists)
    .where(eq(schema.watchlists.userId, userId)).limit(1)
  if (!wl) return { watchlistId: null, items: [] }

  const items = await db.select({
    symbolId: schema.watchlistItems.symbolId, position: schema.watchlistItems.position,
    ticker: schema.symbols.ticker, name: schema.symbols.name, sectorId: schema.symbols.sectorId,
  }).from(schema.watchlistItems)
    .innerJoin(schema.symbols, eq(schema.symbols.id, schema.watchlistItems.symbolId))
    .where(eq(schema.watchlistItems.watchlistId, wl.id))
    .orderBy(asc(schema.watchlistItems.position))

  const ids = items.map((i) => i.symbolId)
  const now = new Date()
  const [prices, obs, cursors, thresholds] = await Promise.all([
    q.pricesAt(ids, now),
    q.observationsFor(ids, now),
    db.select().from(schema.readCursors)
      .where(and(eq(schema.readCursors.userId, userId), ids.length ? inArray(schema.readCursors.symbolId, ids) : dsql`false`)),
    db.select().from(schema.userThresholds)
      .where(and(eq(schema.userThresholds.userId, userId), ids.length ? inArray(schema.userThresholds.symbolId, ids) : dsql`false`)),
  ])
  const cursorBy = new Map(cursors.map((c) => [c.symbolId, c]))
  const thresholdBy = new Map(thresholds.map((t) => [t.symbolId, t]))

  const wlMeta = await providerInfo()
  const wlMarket = await activeMarket()
  return {
    watchlistId: wl.id,
    ...wlMeta,
    market: marketPayload(wlMarket),
    items: items.map((i) => ({
      ...i,
      provenance: provenanceOf({
        quality: ((obs.get(i.symbolId) ?? [])[0]?.quality ?? 'FRESH') as DataQuality,
        simulated: wlMeta.simulated, replay: false,
      }),
      price: prices.get(i.symbolId)?.price ?? null,
      observedAt: prices.get(i.symbolId)?.observedAt?.toISOString() ?? null,
      sources: (obs.get(i.symbolId) ?? []).map((o) => o.source),
      lastSeenAt: cursorBy.get(i.symbolId)?.lastSeenAt?.toISOString() ?? null,
      threshold: thresholdBy.get(i.symbolId)
        ? { kind: thresholdBy.get(i.symbolId)!.kind, value: thresholdBy.get(i.symbolId)!.value }
        : null,
    })),
  }
})

app.post('/api/watchlist/items', async (req) => {
  const userId = userIdOf(req as never)
  const { symbolId } = z.object({ symbolId: symbolIdSchema }).parse(req.body)
  const [wl] = await db.select().from(schema.watchlists).where(eq(schema.watchlists.userId, userId)).limit(1)
  if (!wl) throw notFound('No watchlist for this user.')
  const [sym] = await db.select().from(schema.symbols).where(eq(schema.symbols.id, symbolId)).limit(1)
  if (!sym) throw notFound(`Unknown symbol ${symbolId}`)
  if (sym.isIndex) throw badRequest('Indices are benchmarks, not watchable instruments.')
  // Enforced here as well as in search: filtering only the picker would still
  // let a crafted request mix exchanges into one watchlist, where the prices
  // are in different currencies and scored against a different benchmark.
  const market = await activeMarket()
  if (!symbolIsOnMarket(sym.id, market.id === 'nifty50')) {
    throw badRequest(`${sym.ticker} is not listed on ${market.label}.`)
  }

  const positions = await db.select({ max: dsql<number>`coalesce(max(${schema.watchlistItems.position}), -1)` })
    .from(schema.watchlistItems).where(eq(schema.watchlistItems.watchlistId, wl.id))
  const max = positions[0]?.max ?? -1

  // Idempotent: adding a symbol twice is a no-op, not an error.
  await db.insert(schema.watchlistItems).values({
    id: `${wl.id}:${symbolId}`, watchlistId: wl.id, symbolId, position: Number(max) + 1,
  }).onConflictDoNothing()
  return { ok: true, symbolId }
})

app.delete('/api/watchlist/items/:symbolId', async (req) => {
  const userId = userIdOf(req as never)
  const { symbolId } = z.object({ symbolId: symbolIdSchema }).parse(req.params)
  const [wl] = await db.select().from(schema.watchlists).where(eq(schema.watchlists.userId, userId)).limit(1)
  if (!wl) throw notFound('No watchlist for this user.')
  await db.delete(schema.watchlistItems)
    .where(and(eq(schema.watchlistItems.watchlistId, wl.id), eq(schema.watchlistItems.symbolId, symbolId)))
  return { ok: true }
})

app.put('/api/watchlist/items/:symbolId/threshold', async (req) => {
  const userId = userIdOf(req as never)
  const { symbolId } = z.object({ symbolId: symbolIdSchema }).parse(req.params)
  const body = z.object({
    kind: z.enum(['ABOVE', 'BELOW']).nullable(),
    value: z.number().finite().positive().nullable(),
  }).parse(req.body)

  if (body.kind === null || body.value === null) {
    await db.delete(schema.userThresholds).where(and(
      eq(schema.userThresholds.userId, userId), eq(schema.userThresholds.symbolId, symbolId)))
    return { ok: true, threshold: null }
  }
  await db.insert(schema.userThresholds).values({
    id: `thr_${userId}_${symbolId}`, userId, symbolId, kind: body.kind, value: body.value,
  }).onConflictDoUpdate({
    target: schema.userThresholds.id,
    set: { kind: body.kind, value: body.value },
  })
  return { ok: true, threshold: { kind: body.kind, value: body.value } }
})

/* ------------------------------------------------------------------ brief */

app.get('/api/brief', { config: { rateLimit: LIMITS.brief } }, async (req) => {
  const userId = userIdOf(req as never)
  const parsed = z.object({
    at: isoDate,
    budget: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
  }).parse(req.query)

  // `at` is the ONLY difference between live and replay.
  const at = parsed.at ? new Date(parsed.at) : new Date()
  if (Number.isNaN(at.getTime())) throw badRequest('Invalid `at` timestamp')

  const brief = await evaluateBrief({ userId, at, budgetOverride: parsed.budget as AttentionBudget | undefined })

  // Replay is not a mode — it is `at` in the past. But a value fetched for a
  // past instant must never be labelled as current, so the distinction is
  // carried through to every badge. The window itself is the authority.
  const isReplay = brief.window.isReplay || (parsed.at !== undefined && Date.now() - at.getTime() > 5 * 60_000)
  const changeIds = await persistChanges(userId, brief)

  return {
    ...brief,
    window: {
      ...brief.window,
      windowStart: brief.window.windowStart.toISOString(),
      windowEnd: brief.window.windowEnd.toISOString(),
    },
    cards: brief.cards.map((c) => ({
      ...c,
      changeId: changeIds.get(c.symbolId) ?? null,
      scoreText: displayPercentile(c.score.pctl),
      provenance: provenanceOf({ quality: c.score.quality, simulated: brief.simulated, replay: isReplay }),
    })),
    suppressed: brief.suppressed.map((sup) => ({
      ...sup,
      provenance: provenanceOf({ quality: sup.quality, simulated: brief.simulated, replay: isReplay }),
    })),
    isReplay,
    budgetLabel: BUDGET_LABEL[brief.budget],
    budgetThreshold: BUDGET_THRESHOLD[brief.budget],
  }
})

/* ---------------------------------------------------------------- cursors */

app.post('/api/cursor/seen', async (req) => {
  const userId = userIdOf(req as never)
  const { symbolIds, at } = z.object({
    symbolIds: z.array(symbolIdSchema).min(1).max(200),
    at: isoDate,
  }).parse(req.body)
  const seenAt = at ? new Date(at) : new Date()
  return markSeen(userId, symbolIds, seenAt)
})

app.post('/api/cursor/seen-all', async (req) => {
  const userId = userIdOf(req as never)
  const { at } = z.object({ at: isoDate }).parse(req.body ?? {})
  const items = await db.select({ symbolId: schema.watchlistItems.symbolId })
    .from(schema.watchlistItems)
    .innerJoin(schema.watchlists, eq(schema.watchlists.id, schema.watchlistItems.watchlistId))
    .where(eq(schema.watchlists.userId, userId))
  if (items.length === 0) return { updated: 0 }
  return markSeen(userId, items.map((i) => i.symbolId), at ? new Date(at) : new Date())
})

/**
 * The cross-device merge.
 *
 * `GREATEST` makes this idempotent, commutative and associative: a laptop and a
 * phone syncing out of order converge to the same cursor, and a replayed or
 * duplicated request can never move a cursor backwards — i.e. can never
 * un-read something the user has already seen.
 */
async function markSeen(userId: string, symbolIds: readonly string[], seenAt: Date) {
  const version = seenAt.getTime()
  await db.insert(schema.readCursors).values(symbolIds.map((symbolId) => ({
    userId, symbolId, lastSeenAt: seenAt, lastSeenVersion: version,
  }))).onConflictDoUpdate({
    target: [schema.readCursors.userId, schema.readCursors.symbolId],
    set: {
      lastSeenVersion: dsql`GREATEST(${schema.readCursors.lastSeenVersion}, excluded.last_seen_version)`,
      lastSeenAt: dsql`GREATEST(${schema.readCursors.lastSeenAt}, excluded.last_seen_at)`,
    },
  })
  return { updated: symbolIds.length, at: seenAt.toISOString() }
}

/* ---------------------------------------------------------------- changes */

app.get('/api/changes/:id', async (req) => {
  const userId = userIdOf(req as never)
  const { id } = z.object({ id: z.string().min(3).max(64) }).parse(req.params)
  const change = await getChange(userId, id)
  if (!change) throw notFound('Change not found')

  const [sym] = await db.select().from(schema.symbols).where(eq(schema.symbols.id, change.symbolId)).limit(1)
  const stats = await q.latestStats(change.symbolId, await marketDate(change.windowEnd))
  const inv = await getInvestigation(change.id)

  return {
    change: {
      ...change,
      windowStart: change.windowStart.toISOString(),
      windowEnd: change.windowEnd.toISOString(),
      createdAt: change.createdAt.toISOString(),
    },
    symbol: sym ? { id: sym.id, ticker: sym.ticker, name: sym.name, sectorId: sym.sectorId } : null,
    market: marketPayload(await activeMarket()),
    frequency: frequencyPhrase(change.pctl),
    scoreText: displayPercentile(change.pctl),
    // A change is always a past window, so it is never labelled as current.
    provenance: provenanceOf({
      quality: change.quality, simulated: (await providerInfo()).simulated,
      replay: Date.now() - change.windowEnd.getTime() > 5 * 60_000,
    }),
    stats: stats ? { beta: stats.beta, residMad: stats.residMad, sampleN: stats.sampleN, asOf: stats.asOf } : null,
    investigation: inv
      ? {
          ...inv.investigation,
          startedAt: inv.investigation.startedAt?.toISOString() ?? null,
          completedAt: inv.investigation.completedAt?.toISOString() ?? null,
          evidence: inv.evidence.map((e) => ({ ...e, observedAt: e.observedAt?.toISOString() ?? null })),
        }
      : null,
  }
})

/* ---------------------------------------------------------- investigation */

const running = new Map<string, Promise<unknown>>()
/**
 * Live investigation progress, so the UI can show what is happening as it
 * happens rather than animating a timer. Single local process, so an in-memory
 * map is the honest amount of machinery; a multi-instance deployment would move
 * this to the Redis already described in DECISIONS #9.
 */
const progress = new Map<string, { stage: string | null; trail: unknown[] }>()

app.post('/api/changes/:id/investigate', { config: { rateLimit: LIMITS.investigate } }, async (req) => {
  const userId = userIdOf(req as never)
  const { id } = z.object({ id: z.string().min(3).max(64) }).parse(req.params)
  const change = await getChange(userId, id)
  if (!change) throw notFound('Change not found')

  // Idempotent: a second request returns the first result rather than paying
  // for a duplicate run that could contradict it.
  const existing = await getInvestigation(change.id)
  if (existing) return { status: existing.investigation.status, investigationId: existing.investigation.id, reused: true }
  if (running.has(change.id)) return { status: 'INVESTIGATING', reused: true }

  const [sym] = await db.select().from(schema.symbols).where(eq(schema.symbols.id, change.symbolId)).limit(1)
  const [sector] = sym?.sectorId
    ? await db.select().from(schema.sectors).where(eq(schema.sectors.id, sym.sectorId)).limit(1)
    : [undefined]

  const invId = `inv_${change.id.slice(3)}`
  await db.insert(schema.investigations).values({
    id: invId, changeEventId: change.id, status: 'INVESTIGATING', startedAt: new Date(),
  }).onConflictDoNothing()

  const stages: Stage[] = []
  progress.set(change.id, { stage: 'ANALYZING_MOVEMENT', trail: [] })
  const task = investigate({
    symbolId: change.symbolId,
    symbolName: sym?.name ?? change.symbolId,
    windowStart: change.windowStart,
    windowEnd: change.windowEnd,
    benchmarkId: await benchmarkId(),
    sectorName: sector?.name ?? null,
    volumeMultiple: volumeMultipleOf(change.contributions),
    hasEvent: (change.contributions ?? []).some((c) => c.key === 'event'),
    score: {
      symbolId: change.symbolId, raw: change.raw, pctl: change.pctl, tier: change.tier,
      contributions: change.contributions ?? [], quality: change.quality, qualityReason: '',
      returnPct: change.returnPct, expectedPct: change.expectedPct,
      residualPct: change.residualPct, residualZ: change.residualZ, degraded: null,
    },
  }, {
    onStage: (s) => {
      stages.push(s)
      const p = progress.get(change.id)
      if (p) p.stage = s
    },
    onTrail: (step) => {
      const p = progress.get(change.id)
      if (p) p.trail.push(step)
    },
  })
    .then(async (result) => {
      await db.update(schema.investigations).set({
        status: result.status,
        primaryHypothesis: result.conclusion.primary_hypothesis,
        hypotheses: result.findings,
        conclusion: result.conclusion.conclusion,
        confidence: result.conclusion.confidence,
        toolCalls: result.toolCalls.length,
        toolTrail: result.trail,
        completedAt: new Date(),
        fallbackUsed: result.fallbackUsed,
      }).where(eq(schema.investigations.id, invId))

      const rows = result.findings.flatMap((f, fi) =>
        f.evidence.map((e, ei) => ({
          id: `${invId}_${fi}_${ei}`, investigationId: invId, hypothesis: f.hypothesis,
          type: e.type, source: e.source, observation: e.observation,
          observedAt: e.observed_at ? new Date(e.observed_at) : null,
          stance: e.stance, reliability: null,
        })))
      if (rows.length) await db.insert(schema.evidence).values(rows).onConflictDoNothing()
      return result
    })
    .catch(async (err) => {
      app.log.error({ err }, 'investigation failed')
      await db.update(schema.investigations)
        .set({ status: 'FAILED', completedAt: new Date(), fallbackUsed: true })
        .where(eq(schema.investigations.id, invId))
    })
    .finally(() => {
      running.delete(change.id)
      setTimeout(() => progress.delete(change.id), 60_000)
    })

  running.set(change.id, task)
  return { status: 'INVESTIGATING', investigationId: invId, reused: false }
})

app.get('/api/changes/:id/investigation', async (req) => {
  const userId = userIdOf(req as never)
  const { id } = z.object({ id: z.string().min(3).max(64) }).parse(req.params)
  const change = await getChange(userId, id)
  if (!change) throw notFound('Change not found')
  const live = progress.get(change.id) ?? null
  const inv = await getInvestigation(change.id)
  if (!inv) {
    return {
      status: live ? 'INVESTIGATING' : 'PENDING',
      stage: live?.stage ?? null,
      trail: live?.trail ?? [],
      investigation: null, evidence: [],
    }
  }
  const done = ['COMPLETED', 'INSUFFICIENT_EVIDENCE', 'FAILED'].includes(inv.investigation.status)
  return {
    status: inv.investigation.status,
    stage: done ? null : (live?.stage ?? null),
    // Live trail while running; the persisted one once finished, so a reload
    // shows the same investigation rather than an empty panel.
    trail: done ? (inv.investigation.toolTrail ?? []) : (live?.trail ?? []),
    investigation: {
      ...inv.investigation,
      startedAt: inv.investigation.startedAt?.toISOString() ?? null,
      completedAt: inv.investigation.completedAt?.toISOString() ?? null,
    },
    evidence: inv.evidence.map((e) => ({ ...e, observedAt: e.observedAt?.toISOString() ?? null })),
  }
})

/* ----------------------------------------------------------------- replay */

app.get('/api/changes/:id/replay', async (req) => {
  const userId = userIdOf(req as never)
  const { id } = z.object({ id: z.string().min(3).max(64) }).parse(req.params)
  const change = await getChange(userId, id)
  if (!change) throw notFound('Change not found')

  const [bars, idxBars, events] = await Promise.all([
    q.intradayBetween(change.symbolId, change.windowStart, change.windowEnd),
    q.intradayBetween(await benchmarkId(), change.windowStart, change.windowEnd),
    q.eventsBetween(change.symbolId, change.windowStart, change.windowEnd),
  ])
  const stats = await q.latestStats(change.symbolId, await marketDate(change.windowEnd))
  const beta = stats?.beta ?? 1
  const sigma = stats?.residMad ?? null
  const idxByTs = new Map(idxBars.map((b) => [b.ts.getTime(), b]))

  const first = bars[0]
  const idxFirst = idxBars[0]
  // Residual is recomputed cumulatively from the window start, so the timeline
  // shows the moment the move stopped being explainable by the market.
  const points = bars.map((b) => {
    const r = first ? logReturn(first.open, b.close) : null
    const ib = idxByTs.get(b.ts.getTime())
    const ir = idxFirst && ib ? logReturn(idxFirst.open, ib.close) : null
    const resid = r !== null && ir !== null ? r - beta * ir : r
    return {
      ts: b.ts.toISOString(), close: b.close, volume: b.volume,
      returnPct: r !== null ? (Math.exp(r) - 1) * 100 : null,
      residualPct: resid !== null ? (Math.exp(resid) - 1) * 100 : null,
      residualSigmas: resid !== null && sigma ? resid / sigma : null,
    }
  })

  const crossing = points.find((p) => p.residualSigmas !== null && Math.abs(p.residualSigmas) >= 2)
  return {
    windowStart: change.windowStart.toISOString(),
    windowEnd: change.windowEnd.toISOString(),
    symbolId: change.symbolId,
    points,
    events: events.map((e) => ({
      publishedAt: e.publishedAt.toISOString(), type: e.type, headline: e.headline, source: e.source,
    })),
    attentionCrossedAt: crossing?.ts ?? null,
    note: points.length === 0 ? 'No intraday data stored for this window.' : null,
  }
})

/* ------------------------------------------------------------ data health */

app.get('/api/data-health', async (req) => {
  const userId = userIdOf(req as never)
  const items = await db.select({ symbolId: schema.watchlistItems.symbolId })
    .from(schema.watchlistItems)
    .innerJoin(schema.watchlists, eq(schema.watchlists.id, schema.watchlistItems.watchlistId))
    .where(eq(schema.watchlists.userId, userId))
  const ids = items.map((i) => i.symbolId)
  const now = new Date()
  const cal = await calendar()
  const obs = await q.observationsFor(ids, now)
  const meta = await providerInfo()

  const { assessQuality } = await import('./services/brief.js')
  const rows = []
  for (const id of ids) {
    const list = obs.get(id) ?? []
    const quality = await assessQuality({
      symbolId: id, at: now, observations: list,
      marketOpen: cal.isOpen(now), lastClose: cal.lastSessionCloseAt(now),
      priceEnd: list[0]?.price ?? null, observedAt: list[0]?.observedAt ?? null,
    })
    rows.push({
      symbolId: id, quality: quality.quality, reason: quality.reason,
      provenance: provenanceOf({ quality: quality.quality, simulated: meta.simulated, replay: false }),
      ageMs: quality.ageMs, sources: quality.sources,
      values: list.map((o) => ({ source: o.source, price: o.price, observedAt: o.observedAt.toISOString() })),
    })
  }
  // Bars excluded from every statistic. This is the integrity work the system
  // does silently at ingest; showing it is the only way anyone knows it happened.
  //
  // Scoped to the watchlist. Both universes can share a database, and an
  // unscoped query put an Indian steel company's stock split on the integrity
  // panel of a US large-cap watchlist — real evidence, of the wrong market.
  const quarantined = await db.select({
    symbolId: schema.dataQuarantine.symbolId,
    date: schema.dataQuarantine.date,
    reason: schema.dataQuarantine.reason,
    impliedRatio: schema.dataQuarantine.impliedRatio,
    apparentMovePct: schema.dataQuarantine.apparentMovePct,
  }).from(schema.dataQuarantine)
    .where(inArray(schema.dataQuarantine.symbolId, ids))
    .orderBy(dsql`${schema.dataQuarantine.date} desc`)
    .limit(20)

  const names = await q.symbolsWithSectors(quarantined.map((x) => x.symbolId))
  const nameBy = new Map(names.map((n) => [n.id, n.name]))

  return {
    // Without this the Data page has no currency and falls back to rupees, so
    // the page whose entire subject is "we do not show you numbers we cannot
    // stand behind" priced US equities in ₹.
    market: marketPayload(await activeMarket()),
    ...meta, marketOpen: cal.isOpen(now), at: now.toISOString(), symbols: rows,
    quarantined: quarantined.map((x) => ({
      ...x,
      name: nameBy.get(x.symbolId) ?? x.symbolId,
      /** Stated plainly, because the counterfactual is the whole point. */
      wouldHaveShown: x.apparentMovePct !== null
        ? `${x.apparentMovePct > 0 ? '+' : ''}${x.apparentMovePct.toFixed(1)}%`
        : null,
    })),
  }
})

/* --------------------------------------------------------------- settings */

const BUDGET_COPY = {
  LOW: { title: 'Only the rarest', blurb: 'Interrupt me only when something is genuinely unusual.' },
  MEDIUM: { title: 'Balanced', blurb: 'The default. Enough to stay informed, quiet enough to trust.' },
  HIGH: { title: 'More sensitive', blurb: 'Show me more, and I will accept more noise to get it.' },
} as const

app.get('/api/settings', async (req) => {
  const userId = userIdOf(req as never)
  const [s] = await db.select().from(schema.attentionSettings)
    .where(eq(schema.attentionSettings.userId, userId)).limit(1)
  const budget = s?.budget ?? 'MEDIUM'
  const measured = budgetStats()
  return {
    budget, maxCards: s?.maxCards ?? 3,
    budgetLabel: BUDGET_LABEL[budget], budgetThreshold: BUDGET_THRESHOLD[budget],
    options: (['LOW', 'MEDIUM', 'HIGH'] as const).map((b) => ({
      value: b,
      label: BUDGET_LABEL[b],
      threshold: BUDGET_THRESHOLD[b],
      title: BUDGET_COPY[b].title,
      blurb: BUDGET_COPY[b].blurb,
      measured: measured[b],
    })),
    measuredFrom: (evalReport() as { dataset?: unknown } | null)?.dataset ?? null,
  }
})

app.patch('/api/settings', async (req) => {
  const userId = userIdOf(req as never)
  const body = z.object({
    budget: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional(),
    maxCards: z.number().int().min(1).max(10).optional(),
  }).parse(req.body)
  await db.insert(schema.attentionSettings).values({
    userId, budget: body.budget ?? 'MEDIUM', maxCards: body.maxCards ?? 3,
  }).onConflictDoUpdate({
    target: schema.attentionSettings.userId,
    set: {
      ...(body.budget ? { budget: body.budget } : {}),
      ...(body.maxCards ? { maxCards: body.maxCards } : {}),
    },
  })
  return { ok: true }
})

app.post('/api/changes/:id/feedback', async (req) => {
  const userId = userIdOf(req as never)
  const { id } = z.object({ id: z.string().min(3).max(64) }).parse(req.params)
  const { verdict } = z.object({ verdict: z.enum(['USEFUL', 'NOT_USEFUL']) }).parse(req.body)
  const change = await getChange(userId, id)
  if (!change) throw notFound('Change not found')
  await db.insert(schema.attentionFeedback).values({
    id: `fb_${userId}_${id}`, userId, changeEventId: id, verdict,
  }).onConflictDoUpdate({
    target: [schema.attentionFeedback.userId, schema.attentionFeedback.changeEventId],
    set: { verdict },
  })
  return { ok: true }
})

/* ------------------------------------------------------- eval + debug ---- */

/**
 * Measured performance of each attention budget, read from the evaluation run.
 *
 * The UI shows these next to the choices. They are read from disk rather than
 * written into the code, so the setting can never advertise a number the
 * harness did not produce.
 */
/**
 * The evaluation to quote.
 *
 * Two runs exist. The product universe is NSE, but free NSE feeds are gated
 * behind paid plans, so that dataset is generated. The US run uses real market
 * data from the same harness and the same scoring code — so it is the one that
 * supports a claim about markets, and it is what the app quotes when present.
 */
function evalReport(prefer: 'real' | 'product' = 'real'): Record<string, unknown> | null {
  const files = prefer === 'real' ? ['results.us.json', 'results.json'] : ['results.json']
  for (const f of files) {
    try {
      return JSON.parse(readFileSync(new URL(`../../../eval/out/${f}`, import.meta.url), 'utf8'))
    } catch { /* try the next */ }
  }
  return null
}

/** Both runs, so the page can show the real one and disclose the other. */
function allEvalReports(): { real: unknown | null; product: unknown | null } {
  const read = (f: string) => {
    try { return JSON.parse(readFileSync(new URL(`../../../eval/out/${f}`, import.meta.url), 'utf8')) }
    catch { return null }
  }
  return { real: read('results.us.json'), product: read('results.json') }
}

function budgetStats(): Record<string, { meanPerSession: number; precision: number; recall: number } | null> {
  const r = evalReport() as { alertVolume?: Record<string, {
    meanAlertsPerSessionPer50Symbols: number; precision: number; recall: number }> } | null
  const out: Record<string, { meanPerSession: number; precision: number; recall: number } | null> = {}
  for (const b of ['LOW', 'MEDIUM', 'HIGH']) {
    const v = r?.alertVolume?.[b]
    out[b] = v
      ? { meanPerSession: v.meanAlertsPerSessionPer50Symbols, precision: v.precision, recall: v.recall }
      : null
  }
  return out
}

app.get('/api/eval', async () => {
  const both = allEvalReports()
  const primary = both.real ?? both.product
  if (!primary) throw notFound('No evaluation results yet. Run `npm run eval`.')
  return { ...(primary as object), companion: both.real ? both.product : null }
})

/**
 * Full scoring breakdown for one symbol at one instant.
 * Exposed deliberately: if the attention score cannot be inspected, it cannot
 * be trusted.
 */
app.get('/debug/why', { config: { rateLimit: LIMITS.brief } }, async (req) => {
  const userId = userIdOf(req as never)
  const { symbol, at } = z.object({ symbol: symbolIdSchema, at: isoDate }).parse(req.query)
  const when = at ? new Date(at) : new Date()
  const brief = await evaluateBrief({ userId, at: when, budgetOverride: 'HIGH', capOverride: 50 })
  const score = brief.cards.find((c) => c.symbolId === symbol)?.score
    ?? (await evaluateBrief({ userId, at: when })).cards.find((c) => c.symbolId === symbol)?.score
  const stats = await q.latestStats(symbol, await marketDate(when))

  return {
    symbol, at: when.toISOString(),
    window: {
      start: brief.window.windowStart.toISOString(),
      end: brief.at, sessions: brief.window.sessions,
    },
    score: score ?? null,
    scoredButNotShown: !brief.cards.some((c) => c.symbolId === symbol),
    statistics: stats
      ? {
          asOf: stats.asOf, beta: stats.beta, residMad: stats.residMad,
          volMedian20: stats.volMedian20, volMad20LogSpace: stats.volMad20,
          gapSigma: stats.gapSigma, high52w: stats.high52w, low52w: stats.low52w,
          sampleN: stats.sampleN, calibrationGridPoints: stats.pctlGrid?.length ?? 0,
        }
      : null,
    regime: brief.regime,
    note: 'raw = sum of weighted clipped z-scores. pctl = empirical percentile of raw against this symbol\'s own history.',
  }
})

/** Recover the volume multiple the WHY panel showed, for the fallback wording. */
function volumeMultipleOf(contributions: { key: string; detail: string }[] | null): number | null {
  const v = (contributions ?? []).find((c) => c.key === 'volume')
  const m = v?.detail.match(/([\d.]+)×/)
  return m ? Number(m[1]) : null
}

async function health() {
  const meta = await providerInfo()
  const counted = await db.select({ count: dsql<number>`count(*)` }).from(schema.dailyBars)
  return { ok: true, ...meta, dailyBars: Number(counted[0]?.count ?? 0) }
}

// Two paths, deliberately. The launcher polls /health on loopback before it
// exposes the web server, and that must not depend on Next being up. Anything
// outside the box arrives through Next's /api proxy instead, so the keep-warm
// ping and any external uptime check need the prefixed one to exist.
app.get('/health', health)
app.get('/api/health', health)

try {
  await app.listen({ port: PORT, host: '127.0.0.1' })
  app.log.info(`Since API on http://127.0.0.1:${PORT}`)
} catch (err) {
  app.log.error(err)
  process.exit(1)
}

export { app, HttpError }
