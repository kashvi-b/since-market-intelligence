'use client'
import { useState } from 'react'
import { dateIST, timeIST } from './format'

/**
 * Time travel.
 *
 * This is not a demo mode. `at` is a parameter of the one evaluation function —
 * live is simply `at = now`. Moving this control re-runs the entire pipeline
 * (windows, scoring, calibration, quality gates) against a historical instant,
 * through exactly the same code path the live brief uses.
 */
export function TimeTravel({
  value, windowStart, market, onChange,
}: {
  value: string | undefined
  windowStart: string
  market?: { timeZone?: string; locale?: string; lastCloseAt?: string | null }
  onChange: (v: string | undefined) => void
}) {
  const [open, setOpen] = useState(false)

  const presets = buildPresets(market?.lastCloseAt ?? null)
  const active = value !== undefined

  return (
    <div className="mt-7">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={`tap text-[0.75rem] underline decoration-ink-hairline underline-offset-4 transition-colors hover:text-ink ${
          active ? 'text-signal' : 'text-ink-faint'
        }`}
      >
        {active
          // Rendered in the exchange's timezone like every other time on the
          // page. Defaulting to IST put "Last close" at 01:30 on the wrong day.
          ? `Viewing ${dateIST(value, market)} at ${timeIST(value, market)} — reset to now`
          : 'Return to an earlier moment'}
      </button>

      {open ? (
        <div className="mt-3 border border-ink-hairline p-4">
          <p className="max-w-prose text-[0.75rem] leading-relaxed text-ink-muted">
            Re-evaluates the whole watchlist as of another instant. Same scoring engine, same
            quality gates, same read cursors — only the clock changes.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => { onChange(undefined); setOpen(false) }}
              className="border border-ink-hairline px-3 py-1.5 text-[0.75rem] hover:border-ink"
            >
              Now
            </button>
            {presets.map((p) => (
              <button
                key={p.label}
                onClick={() => { onChange(p.iso); setOpen(false) }}
                className="border border-ink-hairline px-3 py-1.5 text-[0.75rem] hover:border-ink"
              >
                {p.label}
              </button>
            ))}
          </div>
          <label className="mt-4 block text-[0.72rem] text-ink-faint">
            Or pick an instant
            <input
              type="datetime-local"
              defaultValue={toLocalInput(value ?? windowStart)}
              onChange={(e) => {
                const d = new Date(e.target.value)
                if (!Number.isNaN(d.getTime())) onChange(d.toISOString())
              }}
              className="mt-1 block w-full border border-ink-hairline bg-paper-raised px-2 py-1.5 text-[0.8rem] text-ink"
            />
          </label>
        </div>
      ) : null}
    </div>
  )
}

/**
 * Offsets from the last close the server reported.
 *
 * This used to set 10:00 UTC — the NSE bell — which on a US watchlist is 6am in
 * New York, three and a half hours before the market opens. "Last close" then
 * pointed at an instant with no session behind it. The server already knows
 * when the exchange actually closed, so it says so and this follows.
 */
function buildPresets(lastCloseAt: string | null): { label: string; iso: string }[] {
  const anchor = lastCloseAt ? new Date(lastCloseAt) : null
  if (!anchor || Number.isNaN(anchor.getTime())) return []
  const out: { label: string; iso: string }[] = [
    { label: 'Last close', iso: anchor.toISOString() },
  ]
  for (const back of [1, 3, 7]) {
    const d = new Date(anchor)
    d.setUTCDate(d.getUTCDate() - back)
    out.push({ label: `${back} day${back > 1 ? 's' : ''} ago`, iso: d.toISOString() })
  }
  return out
}

function toLocalInput(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
