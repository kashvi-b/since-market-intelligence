import { createHash } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import { db, schema } from '@since/db'
import type { BriefResult } from './brief.js'

/**
 * Persist the changes a brief surfaced.
 *
 * `dedupeKey` is a hash of (user, symbol, window end bucketed to 5 minutes,
 * tier), so re-rendering the same brief — a refresh, a second device, a retry —
 * reuses the same change event rather than creating a duplicate the user would
 * be alerted about twice.
 */
export async function persistChanges(userId: string, brief: BriefResult): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  const rows = brief.cards.map((card) => {
    const s = card.score
    const bucket = Math.floor(new Date(brief.at).getTime() / 300_000)
    const dedupeKey = createHash('sha256')
      .update(`${userId}|${s.symbolId}|${bucket}|${s.tier}`)
      .digest('hex')
      .slice(0, 32)
    const id = `ce_${dedupeKey}`
    ids.set(s.symbolId, id)
    return {
      id, userId, symbolId: s.symbolId,
      windowStart: brief.window.windowStart, windowEnd: new Date(brief.at),
      raw: s.raw, pctl: s.pctl, tier: s.tier,
      contributions: s.contributions,
      returnPct: s.returnPct, expectedPct: s.expectedPct,
      residualPct: s.residualPct, residualZ: s.residualZ,
      quality: s.quality, dedupeKey,
    }
  })
  if (rows.length === 0) return ids

  await db.insert(schema.changeEvents).values(rows).onConflictDoNothing({
    target: schema.changeEvents.dedupeKey,
  })
  return ids
}

export async function getChange(userId: string, changeId: string) {
  const rows = await db.select().from(schema.changeEvents)
    .where(and(eq(schema.changeEvents.id, changeId), eq(schema.changeEvents.userId, userId)))
    .limit(1)
  return rows[0] ?? null
}

export async function getInvestigation(changeEventId: string) {
  const rows = await db.select().from(schema.investigations)
    .where(eq(schema.investigations.changeEventId, changeEventId)).limit(1)
  if (!rows[0]) return null
  const ev = await db.select().from(schema.evidence)
    .where(eq(schema.evidence.investigationId, rows[0].id))
  return { investigation: rows[0], evidence: ev }
}

export async function latestChangeFor(userId: string, symbolId: string) {
  const rows = await db.select().from(schema.changeEvents)
    .where(and(eq(schema.changeEvents.userId, userId), eq(schema.changeEvents.symbolId, symbolId)))
    .orderBy(desc(schema.changeEvents.createdAt)).limit(1)
  return rows[0] ?? null
}
