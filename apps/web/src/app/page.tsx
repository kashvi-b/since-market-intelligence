'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { api, type Brief, type Card } from '@/lib/api'
import { BandBreakout, BandLegend } from '@/components/BandBreakout'
import { AttentionScore, Delta, ProvenanceBadge, TierLabel } from '@/components/Indicators'
import { Skeleton, ErrorState, EmptyState, SimulatedBanner } from '@/components/States'
import { timeIST, dateIST } from '@/components/format'
import { TimeTravel } from '@/components/TimeTravel'
import { Funnel } from '@/components/Funnel'
import { AttentionBudget } from '@/components/AttentionBudget'

export default function BriefPage() {
  const [brief, setBrief] = useState<Brief | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [at, setAt] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (when?: string) => {
    setLoading(true)
    setError(null)
    try {
      await api.session()
      setBrief(await api.brief(when))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(at) }, [load, at])

  if (loading && !brief) return <Skeleton lines={4} />
  if (error) return <ErrorState message={error} onRetry={() => void load(at)} />
  if (!brief) return null

  return (
    <div className={loading ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
      <Hero brief={brief} />
      <Funnel brief={brief} />

      <TimeTravel
        value={at}
        windowStart={brief.window.windowStart}
        market={brief.market}
        onChange={setAt}
      />

      {brief.simulated ? <SimulatedBanner provider={brief.provider} /> : null}

      {brief.cards.length > 0 ? (
        <section className="section" aria-labelledby="attention-heading">
          <div className="flex items-baseline justify-between">
            <h2 id="attention-heading" className="section-label">Deserves your attention</h2>
            <span className="text-[0.7rem] text-ink-faint">
              {brief.budgetLabel} · top {brief.cap}
            </span>
          </div>
          <div className="mt-5 space-y-0">
            {brief.cards.map((card, i) => (
              <ChangeRow key={card.symbolId} card={card} brief={brief} index={i} />
            ))}
          </div>
        </section>
      ) : (
        <NothingHappened brief={brief} />
      )}

      <FilteredNote brief={brief} />
      <AttentionBudget current={brief.budget} onChange={() => void load(at)} />
      <Withheld brief={brief} />
      <SeenControl brief={brief} onDone={() => void load(at)} />
    </div>
  )
}

/* ------------------------------------------------------------------- hero */

function Hero({ brief }: { brief: Brief }) {
  const w = brief.window
  const lede = useMemo(() => buildLede(brief), [brief])

  return (
    <section className="pt-10">
      {w.isFirstVisit ? (
        <p className="eyebrow">Your first look</p>
      ) : (
        <div>
          {/* The read cursor is the product. It gets its own line, not a footnote. */}
          <p className="font-serif text-[0.95rem] leading-none text-ink-muted">
            Since you last looked
          </p>
          <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2.5 text-[0.8rem] text-ink">
            <span className="tnum">{timeIST(w.windowStart, brief.market)}</span>
            <span className="text-ink-faint">·</span>
            <span className="tnum text-ink-muted">{dateIST(w.windowStart, brief.market)}</span>
            <span className="text-ink-faint">·</span>
            <span className="text-ink-muted">away <span className="tnum text-ink">{w.awayLabel}</span></span>
          </p>
        </div>
      )}
      <h1 className="lede mt-4 max-w-[36rem] text-balance">{lede}</h1>
    </section>
  )
}

/**
 * The hero is a sentence, not a stat grid.
 *
 * When the market itself explains everything, that IS the story, and saying so
 * plainly is the most useful thing the product can do.
 */
function buildLede(brief: Brief): string {
  const n = brief.cards.length

  if (brief.regime) {
    const dir = brief.regime.indexReturnPct < 0 ? 'fell' : 'rose'
    const pct = Math.abs(brief.regime.indexReturnPct).toFixed(1)
    const withMarket = brief.regime.withMarket
    const total = brief.regime.movedTotal

    if (n === 0) {
      return `The market ${dir} ${pct}%, and your watchlist ${dir} with it. Nothing moved for reasons of its own.`
    }
    // NOT "n didn't fall" — n is how many deserve attention, which is a different
    // quantity from (total - withMarket), and a stock can fall WITH the market and
    // still be here because it fell further than the market explains.
    return `The market ${dir} ${pct}%, and ${withMarket} of your ${total} stocks ${dir} with it. ` +
      `${cap(word(n))} moved for ${n === 1 ? 'reasons of its own' : 'reasons of their own'}.`
  }

  if (n === 0) {
    return brief.changedCount === 0
      ? 'Nothing moved while you were away.'
      : `${cap(word(brief.changedCount))} things moved. None of them mattered.`
  }
  return `${cap(word(brief.changedCount))} things changed. ${cap(word(n))} deserve${n === 1 ? 's' : ''} your attention.`
}

const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']
const word = (n: number) => WORDS[n] ?? String(n)
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/* -------------------------------------------------------------- change row */

function ChangeRow({ card, brief, index }: { card: Card; brief: Brief; index: number }) {
  const s = card.score
  const name = brief.symbolNames[card.symbolId] ?? card.symbolId
  const sector = brief.sectors[card.symbolId]

  // The residual is the product's whole claim, so it gets its own band. Volume
  // and gap are corroborating detail and sit beneath it.
  const bands = s.contributions
    .filter((c) => c.key === 'residual' || c.key === 'volume' || c.key === 'gap')
    .map((c) => ({
      label: c.label,
      sigmas: c.key === 'residual' ? (s.residualZ ?? c.z) : c.z,
      detail: c.detail,
    }))

  const hasDecomposition = s.expectedPct !== null && s.residualPct !== null

  return (
    <article
      className="rise border-t border-ink-hairline py-8 first:border-t-0 first:pt-0"
      style={{ animationDelay: `${index * 70}ms` }}
    >
      {/* --- identity and headline move ---------------------------------- */}
      <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <TierLabel tier={s.tier} />
          <h3 className="mt-1.5 font-serif text-[1.35rem] leading-tight text-ink">{name}</h3>
          <p className="mt-1 text-[0.72rem] text-ink-faint">
            {card.symbolId.replace('.NS', '')} · {sector?.name ?? 'Uncategorised'}
          </p>
        </div>
        <div className="shrink-0 text-right">
          <div className="figure text-[2rem]">
            <Delta value={s.returnPct} />
          </div>
          <div className="mt-2 flex justify-end">
            <ProvenanceBadge provenance={card.provenance} reason={s.qualityReason} exchange={brief.market?.label} />
          </div>
        </div>
      </header>

      {/* --- how unusual, said as a frequency ----------------------------- */}
      <div className="mt-4">
        <AttentionScore pctl={s.pctl} frequency={card.frequency} scoreText={card.scoreText} />
      </div>

      {card.group ? (
        <p className="mt-4 border-l-2 border-ink-hairline pl-3 text-[0.8rem] leading-relaxed text-ink-muted">
          <span className="text-ink">{card.group.sectorName} moved together.</span>{' '}
          {card.group.members.length} of your holdings in this sector moved for the same reason —
          shown once rather than {card.group.members.length} times.
        </p>
      ) : null}

      {/* --- the decomposition, as a ledger ------------------------------- */}
      {hasDecomposition ? (
        <div className="mt-5 max-w-sm">
          <dl>
            <div className="ledger">
              <dt className="text-[0.8rem] text-ink-muted">Market expected</dt>
              <dd className="tnum text-[0.9rem] text-ink-muted">{s.expectedPct!.toFixed(1)}%</dd>
            </div>
            <div className="ledger">
              <dt className="text-[0.8rem] text-ink-muted">Actual</dt>
              <dd className="tnum text-[0.9rem] text-ink">{s.returnPct?.toFixed(1)}%</dd>
            </div>
            {/* The unexplained part is the reason this card exists at all. */}
            <div className="ledger border-b-0 pt-2.5">
              <dt className="text-[0.8rem] font-medium text-ink">Unexplained</dt>
              <dd className="tnum font-serif text-[1.35rem] leading-none text-signal">
                {s.residualPct! > 0 ? '+' : ''}{s.residualPct!.toFixed(1)}%
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-[0.72rem] leading-relaxed text-ink-faint">
            The market explains the first figure. The last one is what it does not.
          </p>
        </div>
      ) : null}

      {/* --- signature visual --------------------------------------------- */}
      {bands.length > 0 ? (
        <div className="mt-6 space-y-2.5">
          {bands.map((b) => (
            <BandBreakout key={b.label} label={b.label} sigmas={b.sigmas} detail={b.detail} />
          ))}
          <BandLegend />
        </div>
      ) : null}

      {card.changeId ? (
        <div className="mt-6 flex flex-wrap gap-2.5">
          <Link
            href={`/change/${card.changeId}`}
            className="border border-ink px-3.5 py-2 text-[0.78rem] transition-colors hover:bg-ink hover:text-paper"
          >
            Why this?
          </Link>
          <Link
            href={`/change/${card.changeId}#investigation`}
            className="border border-ink-hairline px-3.5 py-2 text-[0.78rem] text-ink-muted transition-colors hover:border-ink hover:text-ink"
          >
            Investigate
          </Link>
          <Link
            href={`/change/${card.changeId}#replay`}
            className="border border-ink-hairline px-3.5 py-2 text-[0.78rem] text-ink-muted transition-colors hover:border-ink hover:text-ink"
          >
            Replay
          </Link>
        </div>
      ) : null}
    </article>
  )
}

/* --------------------------------------------------------------- sections */

function NothingHappened({ brief }: { brief: Brief }) {
  return (
    <section className="section">
      <p className="font-serif text-lg text-ink">Nothing needed you.</p>
      <p className="mt-2 max-w-prose text-[0.88rem] leading-relaxed text-ink-muted">
        {brief.changedCount} of your {brief.totalWatched} stocks moved, and every one of those moves
        is within what that stock ordinarily does — or is explained by the market as a whole.
        Since is deliberately quiet when there is nothing worth saying.
      </p>
    </section>
  )
}

function FilteredNote({ brief }: { brief: Brief }) {
  if (brief.filteredCount === 0) return null
  return (
    <section className="section-tight">
      <p className="text-[0.85rem] text-ink-muted">
        <span className="tnum text-ink">{brief.filteredCount}</span> other movements were reviewed
        and withheld. None of them cleared{' '}
        <span className="tnum">{brief.budgetThreshold}</span>
        <span className="align-super text-[0.6rem]">th</span> percentile for their own stock.
      </p>
    </section>
  )
}

function Withheld({ brief }: { brief: Brief }) {
  if (brief.suppressed.length === 0) return null
  return (
    <section className="section-tight">
      <h2 className="section-label">Withheld — data we don’t trust</h2>
      <ul className="mt-3 space-y-2">
        {brief.suppressed.map((s) => (
          <li key={s.symbolId} className="flex flex-wrap items-baseline gap-x-3 text-[0.82rem]">
            <span className="text-ink">{brief.symbolNames[s.symbolId] ?? s.symbolId}</span>
            <ProvenanceBadge provenance={s.provenance} exchange={brief.market?.label} />
            <span className="text-ink-faint">{s.reason}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 max-w-prose text-[0.78rem] leading-relaxed text-ink-faint">
        These may have moved. We are not telling you they did, because the data behind them did not
        pass its checks — and a confident wrong alert is worse than silence.{' '}
        <Link href="/health" className="tap underline decoration-ink-hairline underline-offset-4 hover:text-ink">
          See what else was excluded
        </Link>
        .
      </p>
    </section>
  )
}

function SeenControl({ brief, onDone }: { brief: Brief; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  if (brief.cards.length === 0 && brief.filteredCount === 0) return null

  return (
    <section className="section-tight">
      <button
        disabled={busy || done}
        onClick={async () => {
          setBusy(true)
          try { await api.markAllSeen(brief.at); setDone(true); onDone() } finally { setBusy(false) }
        }}
        className="tap text-[0.8rem] text-ink-muted underline decoration-ink-hairline underline-offset-4 hover:text-ink disabled:opacity-50"
      >
        {done ? 'Marked as seen' : busy ? 'Marking…' : 'Mark everything as seen'}
      </button>
      <p className="mt-2 max-w-prose text-[0.72rem] leading-relaxed text-ink-faint">
        Opening a card marks only that stock as seen. Reading the brief does not silently clear
        everything else.
      </p>
    </section>
  )
}
