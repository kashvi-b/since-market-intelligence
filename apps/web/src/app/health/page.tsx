'use client'
import { useCallback, useEffect, useState } from 'react'
import { api, type DataHealth } from '@/lib/api'
import { ProvenanceBadge } from '@/components/Indicators'
import type { Provenance } from '@/lib/api'
import { Skeleton, ErrorState } from '@/components/States'
import { money, ago } from '@/components/format'
import { Integrity } from '@/components/Integrity'

export default function HealthPage() {
  const [data, setData] = useState<DataHealth | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try { await api.session(); setData(await api.dataHealth()) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])
  useEffect(() => { void load() }, [load])

  if (error) return <ErrorState message={error} onRetry={() => void load()} />
  if (!data) return <Skeleton lines={5} />

  /*
   * Ordered worst-first. A reader should meet the problems before the healthy
   * majority, and each state carries a word and a mark as well as position, so
   * none of it depends on colour.
   */
  const ORDER: Provenance[] = ['UNAVAILABLE', 'CONFLICTING', 'SUSPECT', 'STALE', 'DELAYED', 'SIMULATED', 'LIVE', 'REPLAY']
  const byState = new Map<string, typeof data.symbols>()
  for (const s of data.symbols) {
    const k = s.provenance ?? 'UNAVAILABLE'
    const list = byState.get(k)
    if (list) list.push(s)
    else byState.set(k, [s])
  }
  const untrusted = ORDER.slice(0, 4).flatMap((k) => byState.get(k) ?? [])
  const trusted = ORDER.slice(4).flatMap((k) => byState.get(k) ?? [])

  return (
    <div>
      <header className="pt-10">
        <h1 className="lede">Degrade, don’t lie.</h1>
        <p className="mt-4 max-w-prose text-[0.9rem] leading-relaxed text-ink-muted">
          Every price carries where it came from, when the market produced it, and how much we trust
          it. When that trust fails, Since withholds the alert rather than issuing a confident wrong
          one. This page shows the state behind that decision.
        </p>
        <p className="mt-4 text-[0.75rem] text-ink-faint">
          Provider <span className="text-ink">{data.provider}</span>
          {data.simulated ? ' (simulated)' : ''} · market {data.marketOpen ? 'open' : 'closed'} ·
          checked {ago(data.at)}
        </p>
      </header>

      {/* --- the count of what is and is not trusted, before the detail ---- */}
      <section aria-label="Trust summary" className="mt-8">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 border-y border-ink-hairline py-5 sm:grid-cols-3">
          <div>
            <dd className="figure text-[1.75rem]">{trusted.length}</dd>
            <dt className="section-label mt-1.5 block">Trusted</dt>
            <p className="mt-0.5 text-[0.7rem] text-ink-faint">scored normally</p>
          </div>
          <div className="sm:border-l sm:border-ink-hairline sm:pl-4">
            <dd className={`figure text-[1.75rem] ${untrusted.length ? 'text-signal' : ''}`}>{untrusted.length}</dd>
            <dt className="section-label mt-1.5 block">Not trusted</dt>
            <p className="mt-0.5 text-[0.7rem] text-ink-faint">alerts withheld</p>
          </div>
          <div className="sm:border-l sm:border-ink-hairline sm:pl-4">
            <dd className={`figure text-[1.75rem] ${data.quarantined?.length ? 'text-signal' : ''}`}>
              {data.quarantined?.length ?? 0}
            </dd>
            <dt className="section-label mt-1.5 block">Quarantined</dt>
            <p className="mt-0.5 text-[0.7rem] text-ink-faint">excluded from statistics</p>
          </div>
        </dl>
      </section>

      {untrusted.length > 0 ? (
        <section className="section">
          <h2 className="section-label">Not trusted — alerts withheld</h2>
          <ul className="mt-4 space-y-5">
            {untrusted.map((s) => (
              <li key={s.symbolId} className="border-l-2 border-signal pl-4">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-[0.95rem] text-ink">{s.symbolId.replace('.NS', '')}</span>
                  <ProvenanceBadge provenance={s.provenance} />
                </div>
                <p className="mt-1 text-[0.78rem] text-ink-muted">{s.reason}</p>
                {s.values.length > 1 ? (
                  <table className="mt-2.5 text-[0.75rem]">
                    <caption className="sr-only">Values reported by each source</caption>
                    <tbody>
                      {s.values.map((v) => (
                        <tr key={v.source}>
                          <td className="pr-4 text-ink-faint">{v.source}</td>
                          <td className="tnum pr-4 text-ink">{money(v.price, data.market)}</td>
                          <td className="text-ink-faint">{ago(v.observedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Integrity rows={data.quarantined ?? []} />

      <section className="section">
        <h2 className="section-label">Trusted — {trusted.length} symbols</h2>
        <ul className="mt-3 grid gap-x-8 sm:grid-cols-2">
          {trusted.map((s) => (
            <li
              key={s.symbolId}
              className="flex items-baseline justify-between gap-4 border-t border-ink-hairline py-2 text-[0.82rem]"
            >
              <span className="truncate text-ink">{s.symbolId.replace('.NS', '')}</span>
              <ProvenanceBadge provenance={s.provenance} reason={s.reason} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
