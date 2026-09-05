/**
 * Reset the demo to its opening state.
 *
 * Reading the brief advances read cursors — correctly, that is the whole point —
 * which means the demo is not repeatable without this. Rewinds every cursor to
 * the open of an earlier session and clears derived state.
 *
 *   npm run demo:reset          # default: two sessions back
 *   npm run demo:reset -- 4     # four sessions back
 */
import { sql, db, schema } from '@since/db'
import { desc, eq, inArray } from 'drizzle-orm'
import { marketFor, istParts, instantAtLocalMinute } from '@since/core'

const USER = 'user_demo'

// Which market is seeded decides the benchmark and the session clock.
const [watched] = await db.select({ symbolId: schema.watchlistItems.symbolId })
  .from(schema.watchlistItems).limit(1)
const market = marketFor(watched?.symbolId?.endsWith('.NS') ? 'nifty50' : 'us')

/**
 * How far back "you last looked" is.
 *
 * Not the most recent session. Anchoring there leaves a window of a few hours
 * on one partial session, and a few hours of a quiet day is genuinely below the
 * attention budget — the brief then correctly shows nothing, which is right and
 * demonstrates nothing. Two sessions back is both the realistic case for
 * someone who checks a watchlist a couple of times a week and long enough for
 * real moves to clear the threshold on their own merits.
 *
 * The threshold is never lowered to fill the page: what shows up here cleared
 * the same p95 bar as in production.
 */
const SESSIONS_BACK = Number(process.argv[2] ?? 2)

const sessions = await db.select({ date: schema.dailyBars.date })
  .from(schema.dailyBars)
  .where(eq(schema.dailyBars.symbolId, market.benchmarkId))
  .orderBy(desc(schema.dailyBars.date))
  .limit(SESSIONS_BACK + 1)

const anchor = sessions[SESSIONS_BACK] ?? sessions[sessions.length - 1]
if (!anchor) {
  console.error('[demo] no market data. Run `npm run ingest` first.')
  process.exit(1)
}

// The open, so the window covers whole sessions rather than starting halfway
// through one — a partial first session makes "3 sessions away" a lie.
const lastSeenAt = instantAtLocalMinute(anchor.date, market.openMinute, market.timeZone)

const items = await db.select({ symbolId: schema.watchlistItems.symbolId })
  .from(schema.watchlistItems)
  .innerJoin(schema.watchlists, eq(schema.watchlists.id, schema.watchlistItems.watchlistId))
  .where(eq(schema.watchlists.userId, USER))

await db.delete(schema.readCursors).where(eq(schema.readCursors.userId, USER))
if (items.length > 0) {
  await db.insert(schema.readCursors).values(items.map((i) => ({
    userId: USER, symbolId: i.symbolId,
    lastSeenAt, lastSeenVersion: lastSeenAt.getTime(), lastSeenPrice: null,
  })))
}

// Derived state is rebuilt on the next brief; investigations cascade with it.
await db.delete(schema.changeEvents).where(eq(schema.changeEvents.userId, USER))

const local = istParts(lastSeenAt, market.timeZone)
const hh = String(Math.floor(local.minutes / 60)).padStart(2, '0')
const mm = String(local.minutes % 60).padStart(2, '0')
console.log(`[demo] reset ${items.length} cursors to ${hh}:${mm} ${market.label} time on ${anchor.date} ` +
  `(${SESSIONS_BACK} session${SESSIONS_BACK === 1 ? '' : 's'} back)`)
console.log('[demo] cleared change events and investigations')
await sql.end()
