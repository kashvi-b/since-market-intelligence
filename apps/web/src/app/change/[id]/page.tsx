'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import {
  api, type ChangeDetail, type InvestigationResponse, type ReplayResponse,
} from '@/lib/api'
import { BandBreakout, BandLegend } from '@/components/BandBreakout'
import { AttentionScore, Delta, ProvenanceBadge, TierLabel } from '@/components/Indicators'
import { Skeleton, ErrorState } from '@/components/States'
import { Investigation } from '@/components/Investigation'
import { Replay } from '@/components/Replay'
import { dateIST, timeIST } from '@/components/format'

export default function ChangePage() {
  // useParams rather than unwrapping the params promise: this is a client
  // component, and the hook is the idiom that works in both render passes.
  const routeParams = useParams<{ id: string }>()
  const id = routeParams?.id ?? ''
  const [detail, setDetail] = useState<ChangeDetail | null>(null)
  const [inv, setInv] = useState<InvestigationResponse | null>(null)
  const [replay, setReplay] = useState<ReplayResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      await api.session()
      const d = await api.change(id)
      setDetail(d)
      // Opening a change marks THIS symbol seen — and only this one.
      void api.markSeen([d.change.symbolId])
      const [i, r] = await Promise.all([
        api.investigation(id).catch(() => null),
        api.replay(id).catch(() => null),
      ])
      setInv(i)
      setReplay(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [id])

  useEffect(() => { void load() }, [load])

  if (error) return <ErrorState message={error} onRetry={() => void load()} />
  if (!detail) return <Skeleton lines={5} />

  const c = detail.change
  const name = detail.symbol?.name ?? c.symbolId
  const contributions = Array.isArray(c.contributions) ? c.contributions : []
  const residual = contributions.find((x) => x.key === 'residual')

  return (
    <div>
      <div className="pt-10">
        <Link href="/" className="tap text-[0.75rem] text-ink-faint hover:text-ink">← Brief</Link>
      </div>

      <header className="mt-6">
        <TierLabel tier={c.tier} />
        <h1 className="lede mt-2">{name}</h1>
        <p className="mt-2 text-[0.78rem] text-ink-faint">
          {c.symbolId.replace('.NS', '')} · {dateIST(c.windowEnd, detail.market)} · window {timeIST(c.windowStart, detail.market)} → {timeIST(c.windowEnd, detail.market)}
        </p>
        <div className="mt-5 flex flex-wrap items-end justify-between gap-4">
          <div className="font-serif text-4xl leading-none">
            <Delta value={c.returnPct} />
          </div>
          <ProvenanceBadge provenance={detail.provenance} reason={String(c.quality)} />
        </div>
      </header>

      {/* ---------------------------------------------------------- why -- */}
      <section className="section" aria-labelledby="why">
        <h2 id="why" className="section-label">Why this got your attention</h2>

        <div className="mt-5">
          <AttentionScore pctl={c.pctl} frequency={detail.frequency} scoreText={detail.scoreText} />
        </div>

        <table className="mt-6 w-full text-[0.85rem]">
          <caption className="sr-only">Signal contributions to the composite score</caption>
          <thead>
            <tr className="border-b border-ink-hairline text-left text-[0.68rem] uppercase tracking-[0.1em] text-ink-faint">
              <th scope="col" className="pb-2 font-medium">Signal</th>
              <th scope="col" className="pb-2 text-right font-medium">σ</th>
              <th scope="col" className="pb-2 text-right font-medium">Weight</th>
              <th scope="col" className="pb-2 text-right font-medium">Points</th>
            </tr>
          </thead>
          <tbody>
            {contributions.map((x) => (
              <tr key={x.key} className="border-b border-ink-hairline/60">
                <td className="py-2.5">
                  <div className="text-ink">{x.label}</div>
                  <div className="text-[0.72rem] text-ink-faint">{x.detail}</div>
                </td>
                <td className="tnum py-2.5 text-right text-ink-muted">{x.z.toFixed(2)}</td>
                <td className="tnum py-2.5 text-right text-ink-faint">×{x.weight}</td>
                <td className="tnum py-2.5 text-right text-ink">{x.points.toFixed(2)}</td>
              </tr>
            ))}
            <tr>
              <td className="pt-3 text-[0.8rem] text-ink-muted">Composite (raw)</td>
              <td /><td />
              <td className="tnum pt-3 text-right font-medium text-ink">{c.raw.toFixed(2)}</td>
            </tr>
          </tbody>
        </table>

        <p className="mt-4 max-w-prose text-[0.8rem] leading-relaxed text-ink-muted">
          The raw composite is a sum of weighted, clipped z-scores — it is not the score you see.
          It is then converted to a percentile against this stock’s own history, which is what makes{' '}
          <span className="tnum text-ink">{detail.scoreText?.text ?? Math.round(c.pctl)}</span> mean
          something: {detail.frequency}.
        </p>

        {contributions.length > 0 ? (
          <div className="mt-6 space-y-2">
            {contributions
              .filter((x) => ['residual', 'volume', 'gap'].includes(x.key))
              .map((x) => (
                <BandBreakout
                  key={x.key}
                  label={x.label}
                  sigmas={x.key === 'residual' && c.returnPct !== null && c.returnPct < 0 ? -x.z : x.z}
                  detail={x.detail}
                />
              ))}
            <BandLegend />
          </div>
        ) : null}

        <TechnicalDetails detail={detail} />
      </section>

      {/* ------------------------------------------------- investigation -- */}
      <Investigation
        changeId={id}
        subject={name}
        movePct={c.returnPct}
        initial={inv}
        onStart={async () => { await api.investigate(id) }}
        poll={() => api.investigation(id)}
      />

      {/* -------------------------------------------------------- replay -- */}
      <Replay data={replay} market={detail.market} />

      <Feedback changeId={id} />
    </div>
  )
}

function TechnicalDetails({ detail }: { detail: ChangeDetail }) {
  const s = detail.stats
  return (
    <details className="group mt-6 border-t border-ink-hairline pt-4">
      <summary className="cursor-pointer list-none text-[0.78rem] text-ink-muted hover:text-ink">
        <span className="underline decoration-ink-hairline underline-offset-4">Technical details</span>
      </summary>
      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-[0.78rem] sm:grid-cols-3">
        <Item label="Beta (60 sessions)" value={s?.beta?.toFixed(3) ?? '—'} />
        <Item label="Residual scale (MAD)" value={s?.residMad ? s.residMad.toFixed(5) : '—'} />
        <Item label="Sample size" value={s?.sampleN ? String(s.sampleN) : '—'} />
        <Item label="Statistics as of" value={s?.asOf ?? '—'} />
        <Item label="Data quality" value={detail.change.quality} />
        <Item label="Tier" value={detail.change.tier} />
      </dl>
      <p className="mt-4 text-[0.72rem] text-ink-faint">
        Everything above is stored on the change event itself, so this panel is a read of what the
        engine actually decided — not a recomputation that might disagree with it.
      </p>
    </details>
  )
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[0.68rem] uppercase tracking-[0.08em] text-ink-faint">{label}</dt>
      <dd className="tnum mt-0.5 text-ink">{value}</dd>
    </div>
  )
}

function Feedback({ changeId }: { changeId: string }) {
  const [sent, setSent] = useState<string | null>(null)
  return (
    <section className="section-tight">
      {sent ? (
        <p className="text-[0.8rem] text-ink-muted">Recorded — thank you.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[0.8rem] text-ink-muted">Was this worth surfacing?</span>
          {(['USEFUL', 'NOT_USEFUL'] as const).map((v) => (
            <button
              key={v}
              onClick={async () => { await api.feedback(changeId, v); setSent(v) }}
              className="border border-ink-hairline px-3 py-1 text-[0.75rem] hover:border-ink"
            >
              {v === 'USEFUL' ? 'Yes' : 'No'}
            </button>
          ))}
        </div>
      )}
    </section>
  )
}
