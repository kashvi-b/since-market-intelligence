'use client'
import { useEffect, useState } from 'react'
import { api, type Settings } from '@/lib/api'

/**
 * The attention budget.
 *
 * Because the score is a calibrated percentile rather than an arbitrary number,
 * this control is not a vague sensitivity slider — it is a false-positive rate.
 * That means its consequences are measurable, so every claim beside an option is
 * read from the evaluation run rather than written by hand. If the harness has
 * never been run, the numbers are simply absent instead of invented.
 */
export function AttentionBudget({ current, onChange }: { current: string; onChange: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState<string | null>(null)

  useEffect(() => { api.settings().then(setSettings).catch(() => setSettings(null)) }, [])

  if (!settings) return null

  const active = settings.options.find((o) => o.value === current) ?? settings.options[1]
  // Recall is tiny in absolute terms, so the useful comparison is relative:
  // how much more of what mattered does this setting actually catch?
  const base = settings.options.find((o) => o.value === 'LOW')?.measured?.recall ?? 0

  return (
    <section className="mt-10 border-t border-ink-hairline pt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 className="eyebrow">How much should Since interrupt you?</h2>
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="tap text-[0.78rem] text-ink-muted underline decoration-ink-hairline underline-offset-4 hover:text-ink"
        >
          {open ? 'Close' : `Currently: ${active?.title ?? current}`}
        </button>
      </div>

      {!open ? (
        <p className="mt-2 max-w-prose text-[0.8rem] leading-relaxed text-ink-faint">
          {active?.blurb}{' '}
          {active?.measured
            ? <>Measured at about <span className="tnum text-ink-muted">{active.measured.meanPerSession.toFixed(1)}</span> alerts a day.</>
            : null}
        </p>
      ) : (
        <div className="mt-4">
          <div role="radiogroup" aria-label="Attention level" className="space-y-0">
            {settings.options.map((o) => {
              const selected = o.value === current
              const lift = base > 0 && o.measured ? o.measured.recall / base : null
              return (
                <button
                  key={o.value}
                  role="radio"
                  aria-checked={selected}
                  disabled={saving !== null}
                  onClick={async () => {
                    setSaving(o.value)
                    try { await api.saveSettings({ budget: o.value }); onChange(); setOpen(false) }
                    finally { setSaving(null) }
                  }}
                  className={`grid w-full grid-cols-[1.25rem_1fr] items-start gap-3 border-t border-ink-hairline
                    py-4 text-left transition-colors first:border-t-0 disabled:opacity-50
                    ${selected ? '' : 'hover:bg-paper-sunk/60'}`}
                >
                  <span aria-hidden className={`mt-0.5 ${selected ? 'text-signal' : 'text-ink-faint'}`}>
                    {selected ? '●' : '○'}
                  </span>
                  <span className="min-w-0">
                    <span className="flex flex-wrap items-baseline gap-x-3">
                      <span className={`text-[0.95rem] ${selected ? 'text-ink' : 'text-ink-muted'}`}>{o.title}</span>
                      {saving === o.value ? <span className="text-[0.7rem] text-ink-faint">saving…</span> : null}
                    </span>
                    <span className="mt-0.5 block text-[0.8rem] leading-relaxed text-ink-muted">{o.blurb}</span>
                    {o.measured ? (
                      <span className="mt-1.5 block text-[0.72rem] text-ink-faint">
                        <span className="tnum">{o.measured.meanPerSession.toFixed(1)}</span> alerts a day ·{' '}
                        about <span className="tnum">1 in {Math.round(1 / Math.max(o.measured.precision, 0.001))}</span> proved meaningful
                        {lift && lift > 1.05
                          ? <> · catches <span className="tnum">{lift.toFixed(1)}×</span> as much as the quietest setting</>
                          : null}
                      </span>
                    ) : (
                      <span className="mt-1.5 block text-[0.72rem] text-ink-faint">
                        No measurement yet — run <span className="font-mono">npm run eval</span>
                      </span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>

          <p className="mt-4 max-w-prose border-l-2 border-ink-hairline pl-3 text-[0.75rem] leading-relaxed text-ink-faint">
            This changes only how much you want to be told. The market data, the scoring
            engine and every number behind it are identical at all three settings — you are
            choosing where to sit on the trade-off between being interrupted and missing
            something, and these figures are measured, not estimated.
          </p>
        </div>
      )}
    </section>
  )
}
