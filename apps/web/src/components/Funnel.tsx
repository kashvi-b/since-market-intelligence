import type { Brief } from '@/lib/api'

/**
 * The funnel: market → watchlist → withheld → attention.
 *
 * The hero says what happened in a sentence; this says it in numbers, so a
 * reader who skips prose still understands the product in one glance. Every
 * value comes from the brief the API already returns — nothing here is derived
 * from an assumption or padded to make the story tidier.
 */
export function Funnel({ brief }: { brief: Brief }) {
  const regime = brief.regime
  // With a regime we can say how many moved WITH the market, which is the
  // product's whole point. Without one that number does not exist, so we show
  // what does rather than inventing it.
  const second = regime
    ? { label: 'Market-driven', value: regime.withMarket, hint: `of ${regime.movedTotal} that moved` }
    : { label: 'Moved', value: brief.changedCount, hint: 'any movement at all' }

  interface Cell { label: string; value: number; hint: string; accent?: boolean }
  const cells: Cell[] = [
    { label: 'Watched', value: brief.totalWatched, hint: 'in your watchlist' },
    second,
    { label: 'Withheld', value: brief.filteredCount, hint: 'ordinary for that stock' },
    { label: 'Attention', value: brief.attentionCount, hint: 'unusual, shown to you', accent: true },
  ]

  return (
    <section aria-label="Summary" className="mt-8">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-y border-ink-hairline py-5 sm:grid-cols-4 sm:gap-x-4">
        {cells.map((c, i) => (
          <div
            key={c.label}
            className={i > 0 ? 'sm:border-l sm:border-ink-hairline sm:pl-4' : ''}
          >
            <dd className={`figure text-[1.75rem] ${c.accent ? 'text-signal' : ''}`}>{c.value}</dd>
            <dt className="section-label mt-1.5 block">{c.label}</dt>
            <p className="mt-0.5 text-[0.7rem] leading-snug text-ink-faint">{c.hint}</p>
          </div>
        ))}
      </dl>
      {brief.suppressedCount > 0 ? (
        <p className="mt-2.5 text-[0.72rem] text-ink-faint">
          <span aria-hidden>⚠ </span>
          <span className="tnum text-ink-muted">{brief.suppressedCount}</span> more withheld because
          the data behind them could not be trusted — see{' '}
          <a href="/health" className="tap underline decoration-ink-hairline underline-offset-4 hover:text-ink">Data</a>.
        </p>
      ) : null}
    </section>
  )
}
