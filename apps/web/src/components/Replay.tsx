'use client'
import { useMemo, useState } from 'react'
import type { ReplayResponse, MarketInfo } from '@/lib/api'
import { timeIST } from './format'

/**
 * Replay.
 *
 * Reconstructed from stored 5-minute bars — nothing here is scripted. The line
 * is the cumulative residual: the part of the move the market does not explain,
 * accumulating minute by minute. The marker is the moment it crossed the
 * threshold that would have earned your attention.
 */
export function Replay({ data, market }: { data: ReplayResponse | null; market?: MarketInfo }) {
  const [hover, setHover] = useState<number | null>(null)

  const geometry = useMemo(() => {
    if (!data || data.points.length < 2) return null
    const pts = data.points
    const sigmas = pts.map((p) => p.residualSigmas ?? 0)
    const maxAbs = Math.max(2.5, ...sigmas.map(Math.abs))
    const W = 720
    const H = 180
    const x = (i: number) => (i / (pts.length - 1)) * W
    const y = (s: number) => H / 2 - (s / maxAbs) * (H / 2 - 12)
    const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.residualSigmas ?? 0).toFixed(1)}`).join(' ')
    return { pts, W, H, x, y, path, maxAbs }
  }, [data])

  if (!data) return null

  return (
    <section id="replay" className="mt-12 scroll-mt-8 border-t border-ink-hairline pt-8">
      <h2 className="eyebrow">Replay — what happened while you were away</h2>

      {!geometry ? (
        <p className="mt-4 max-w-prose text-[0.85rem] text-ink-muted">
          {data.note ?? 'No intraday data is stored for this window, so there is nothing to replay.'}
        </p>
      ) : (
        <>
          <p className="mt-3 max-w-prose text-[0.82rem] leading-relaxed text-ink-muted">
            The line is the part of the move the market does <span className="text-ink">not</span> explain,
            accumulating through the window. Inside the band is ordinary; leaving it is the story.
          </p>

          <figure className="mt-5">
            <svg
              viewBox={`0 0 ${geometry.W} ${geometry.H}`}
              className="w-full"
              role="img"
              aria-label={`Cumulative market-adjusted move from ${timeIST(data.windowStart, market)} to ${timeIST(data.windowEnd, market)}, ending at ${(geometry.pts[geometry.pts.length - 1]?.residualSigmas ?? 0).toFixed(1)} sigma`}
              onMouseLeave={() => setHover(null)}
            >
              {/* normal band: +/- 1 sigma */}
              <rect
                x={0} y={geometry.y(1)} width={geometry.W} height={geometry.y(-1) - geometry.y(1)}
                className="fill-ink-hairline" opacity={0.5}
              />
              <line x1={0} x2={geometry.W} y1={geometry.y(0)} y2={geometry.y(0)} className="stroke-ink-faint" strokeWidth={0.5} />
              {[2, -2].map((s) => (
                <line key={s} x1={0} x2={geometry.W} y1={geometry.y(s)} y2={geometry.y(s)}
                  className="stroke-ink-hairline" strokeWidth={1} strokeDasharray="3 4" />
              ))}
              <path d={geometry.path} fill="none" className="stroke-ink" strokeWidth={1.5} strokeLinejoin="round" />

              {/* the moment it crossed into attention */}
              {data.attentionCrossedAt ? (() => {
                const i = geometry.pts.findIndex((p) => p.ts === data.attentionCrossedAt)
                if (i < 0) return null
                return (
                  <g>
                    <line x1={geometry.x(i)} x2={geometry.x(i)} y1={0} y2={geometry.H} className="stroke-signal" strokeWidth={1} />
                    <circle cx={geometry.x(i)} cy={geometry.y(geometry.pts[i]!.residualSigmas ?? 0)} r={3.5} className="fill-signal" />
                  </g>
                )
              })() : null}

              {/* hover target */}
              {geometry.pts.map((p, i) => (
                <rect
                  key={p.ts} x={geometry.x(i) - 3} y={0} width={6} height={geometry.H}
                  fill="transparent" onMouseEnter={() => setHover(i)}
                />
              ))}
              {hover !== null ? (
                <circle cx={geometry.x(hover)} cy={geometry.y(geometry.pts[hover]!.residualSigmas ?? 0)} r={3} className="fill-ink" />
              ) : null}
            </svg>
            <figcaption className="mt-2 flex justify-between text-[0.7rem] text-ink-faint">
              <span>{timeIST(data.windowStart, market)}</span>
              {hover !== null ? (
                <span className="tnum text-ink">
                  {timeIST(geometry.pts[hover]!.ts, market)} · {(geometry.pts[hover]!.residualSigmas ?? 0).toFixed(2)}σ ·{' '}
                  {(geometry.pts[hover]!.residualPct ?? 0).toFixed(2)}% unexplained
                </span>
              ) : (
                <span>cumulative market-adjusted move, in σ</span>
              )}
              <span>{timeIST(data.windowEnd, market)}</span>
            </figcaption>
          </figure>

          <ol className="mt-7 space-y-0">
            <TimelineRow time={timeIST(data.windowStart, market)} label="You last looked" />
            {data.events.map((e) => (
              <TimelineRow
                key={e.publishedAt + e.headline}
                time={timeIST(e.publishedAt, market)}
                label={e.headline}
                sub={`${e.type.toLowerCase()} · ${e.source}`}
              />
            ))}
            {data.attentionCrossedAt ? (
              <TimelineRow
                time={timeIST(data.attentionCrossedAt, market)}
                label="Crossed 2σ of unexplained movement"
                accent
              />
            ) : null}
            <TimelineRow time={timeIST(data.windowEnd, market)} label="You returned" />
          </ol>

          {data.events.length > 0 ? (
            <p className="mt-5 max-w-prose text-[0.75rem] leading-relaxed text-ink-faint">
              An event published inside the window is shown with its timestamp so you can judge the
              ordering yourself. Since does not claim it caused the move.
            </p>
          ) : null}
        </>
      )}
    </section>
  )
}

function TimelineRow({ time, label, sub, accent }: { time: string; label: string; sub?: string; accent?: boolean }) {
  return (
    <li className="grid grid-cols-[4.5rem_1fr] gap-4 border-t border-ink-hairline py-3 first:border-t-0">
      <span className="tnum text-[0.75rem] text-ink-faint">{time}</span>
      <span>
        <span className={`text-[0.85rem] ${accent ? 'text-signal' : 'text-ink'}`}>{label}</span>
        {sub ? <span className="mt-0.5 block text-[0.7rem] text-ink-faint">{sub}</span> : null}
      </span>
    </li>
  )
}
