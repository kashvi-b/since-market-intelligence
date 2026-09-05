/**
 * The signature visual: normal range as a band, today as a marker outside it.
 *
 * Not a chart. A chart shows a series; this shows a claim — "here is what
 * ordinary looks like for this stock, and here is today" — which a reader
 * understands before reading a single number. Everything is CSS and a couple of
 * divs, so it costs nothing to render and scales to any width.
 */
export function BandBreakout({
  label, sigmas, detail, max = 4,
}: {
  label: string
  /** Signed magnitude in robust sigmas. */
  sigmas: number
  detail?: string
  max?: number
}) {
  const clamped = Math.max(-max, Math.min(max, sigmas))
  const toPct = (s: number) => ((s + max) / (2 * max)) * 100
  const markerAt = toPct(clamped)
  const outside = Math.abs(sigmas) > 2
  const saturated = Math.abs(sigmas) >= max

  return (
    <div className="grid grid-cols-[6.5rem_1fr] items-center gap-x-3 gap-y-1 sm:grid-cols-[9rem_1fr] sm:gap-x-4">
      <div className="text-[0.72rem] leading-tight text-ink-muted sm:text-[0.75rem]">{label}</div>
      <div>
        <div
          className="relative h-5"
          role="img"
          aria-label={
            `${label}: ${Math.abs(sigmas).toFixed(1)} sigma ${sigmas < 0 ? 'below' : 'above'} normal, ` +
            `${outside ? 'outside' : 'within'} the normal range`
          }
        >
          <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-ink-hairline" />
          {/* ±2σ: unusual but not remarkable */}
          <div
            className="absolute top-1/2 h-3 -translate-y-1/2 rounded-[2px] bg-paper-sunk"
            style={{ left: `${toPct(-2)}%`, width: `${toPct(2) - toPct(-2)}%` }}
          />
          {/* ±1σ: the normal range */}
          <div
            className="absolute top-1/2 h-3 -translate-y-1/2 rounded-[2px] bg-ink-hairline"
            style={{ left: `${toPct(-1)}%`, width: `${toPct(1) - toPct(-1)}%` }}
          />
          <div className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-ink-faint" style={{ left: '50%' }} />

          {/* Today. A caret as well as colour, so the state is never colour-only. */}
          <div
            className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${markerAt}%` }}
          >
            <div className={`h-4 w-[3px] rounded-full ${outside ? 'bg-signal' : 'bg-ink-muted'}`} />
          </div>
          {/* An off-scale value is marked as clipped rather than silently pinned. */}
          {saturated ? (
            <span
              aria-hidden
              className="absolute top-1/2 -translate-y-1/2 text-[0.6rem] text-signal"
              style={{ [sigmas < 0 ? 'left' : 'right']: '-0.55rem' }}
            >
              {sigmas < 0 ? '◂' : '▸'}
            </span>
          ) : null}
        </div>
        {detail ? (
          <div className="mt-1 text-[0.7rem] leading-snug text-ink-faint">{detail}</div>
        ) : null}
      </div>
    </div>
  )
}

/** Legend, shown once per group of bands rather than on every row. */
export function BandLegend() {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-x-3 sm:grid-cols-[9rem_1fr] sm:gap-x-4">
      <div />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.65rem] text-ink-faint">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-4 rounded-[2px] bg-ink-hairline" /> normal range
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-3 w-[3px] rounded-full bg-signal" /> today
        </span>
      </div>
    </div>
  )
}
