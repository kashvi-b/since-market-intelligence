import type { QuarantineRow } from '@/lib/api'
import { dateIST } from './format'

/**
 * Integrity — bars excluded from every statistic.
 *
 * Detecting a corporate action is only half the work; the other half is being
 * able to show that it happened. Without this section the split handling exists
 * only in an ingest log, which is indistinguishable from not handling it at all.
 */
export function Integrity({ rows }: { rows: QuarantineRow[] }) {
  if (rows.length === 0) {
    return (
      <section className="mt-10 border-t border-ink-hairline pt-6">
        <h2 className="eyebrow">Integrity</h2>
        <p className="mt-2 max-w-prose text-[0.82rem] leading-relaxed text-ink-muted">
          Nothing quarantined. Every bar in the dataset passed its sanity checks: raw and
          adjusted closes agree, and no move is large enough to be implausible without a
          corresponding market move.
        </p>
      </section>
    )
  }

  return (
    <section className="mt-10 border-t border-ink-hairline pt-6">
      <h2 className="eyebrow">Integrity — excluded from every statistic</h2>
      <p className="mt-2 max-w-prose text-[0.82rem] leading-relaxed text-ink-muted">
        A stock split halves the price without anything happening to the company. Left
        untouched it is the loudest false alert a watchlist can produce — and then the
        outlier distorts the volatility estimate for months, quietly blinding the detector.
      </p>

      <ul className="mt-5 space-y-5">
        {rows.map((r) => (
          <li key={`${r.symbolId}-${r.date}`} className="border-l-2 border-signal pl-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-0.5">
              <span className="text-[0.95rem] text-ink">{r.name}</span>
              <span className="text-[0.72rem] text-ink-faint">{dateIST(`${r.date}T00:00:00Z`)}</span>
            </div>

            <div className="mt-1.5 flex flex-wrap items-baseline gap-x-5 gap-y-1">
              {r.impliedRatio ? (
                <span className="text-[0.82rem] text-ink-muted">
                  <span className="tnum text-ink">{ratioLabel(r.impliedRatio)}</span> split detected
                </span>
              ) : null}
              {r.wouldHaveShown ? (
                <span className="text-[0.82rem] text-ink-muted">
                  Would have shown as{' '}
                  <span className="tnum text-signal">{r.wouldHaveShown}</span>
                </span>
              ) : null}
            </div>

            <p className="mt-1.5 text-[0.75rem] leading-relaxed text-ink-faint">{r.reason}</p>
          </li>
        ))}
      </ul>

      <p className="mt-5 max-w-prose text-[0.75rem] leading-relaxed text-ink-faint">
        Detected from the data itself, not a hardcoded list: on an ordinary day the raw and
        corporate-action-adjusted closes move together, and across a split they diverge by
        exactly the split ratio. That divergence is a fact in the feed, so the check works on
        any symbol without knowing in advance that anything happened.
      </p>
    </section>
  )
}

/** 0.5 -> "1:2", 0.333 -> "1:3", 2 -> "2:1". */
function ratioLabel(ratio: number): string {
  if (ratio > 0 && ratio < 1) {
    const inv = Math.round(1 / ratio)
    if (Math.abs(1 / ratio - inv) < 0.05) return `1:${inv}`
  }
  if (ratio >= 1) {
    const n = Math.round(ratio)
    if (Math.abs(ratio - n) < 0.05) return `${n}:1`
  }
  return ratio.toFixed(2)
}
