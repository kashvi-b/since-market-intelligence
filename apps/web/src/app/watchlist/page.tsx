'use client'
import { useCallback, useEffect, useState } from 'react'
import { api, type WatchlistItem, type SymbolRow, type MarketInfo } from '@/lib/api'
import { ProvenanceBadge } from '@/components/Indicators'
import { Skeleton, ErrorState, EmptyState } from '@/components/States'
import { money, ago } from '@/components/format'

export default function WatchlistPage() {
  const [items, setItems] = useState<WatchlistItem[] | null>(null)
  const [market, setMarket] = useState<MarketInfo | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      await api.session()
      const wl = await api.watchlist()
      setItems(wl.items)
      setMarket(wl.market)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => { void load() }, [load])

  if (error) return <ErrorState message={error} onRetry={() => void load()} />
  if (!items) return <Skeleton lines={6} />

  return (
    <div>
      <header className="pt-10">
        <h1 className="lede">Watchlist</h1>
        <p className="mt-3 max-w-prose text-[0.85rem] leading-relaxed text-ink-muted">
          What Since watches on your behalf. “You last viewed this” is your read cursor — the
          moment each stock’s next brief is measured against, moved only when you actually open it.
          Thresholds are the one signal weighted above Since’s own statistics: if you say a level
          matters, it matters.
        </p>
      </header>

      <AddSymbol
        onAdded={load}
        existing={new Set(items.map((i) => i.symbolId))}
        examples={items.slice(0, 2).map((i) => i.ticker)}
      />

      {items.length === 0 ? (
        <EmptyState
          title="Nothing watched yet."
          body="Add a few stocks. When you come back, Since will remember where you left off and tell you only what changed in a way that matters."
        />
      ) : (
        <ul className="mt-8">
          {items.map((it) => <Row key={it.symbolId} item={it} market={market} onChanged={load} />)}
        </ul>
      )}
    </div>
  )
}

function AddSymbol({ onAdded, existing, examples }: {
  onAdded: () => void
  existing: Set<string>
  /** Two tickers already on the list, so the hint names this market rather than
   *  whichever one the product happened to launch on. It read "HDFCBANK,
   *  Infosys…" above a watchlist of US equities. */
  examples: string[]
}) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<SymbolRow[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (q.trim().length < 1) { setResults([]); return }
    const t = setTimeout(async () => {
      try { setResults((await api.search(q.trim())).results) } catch { setResults([]) }
    }, 180)                                   // debounced: one request per pause, not per keystroke
    return () => clearTimeout(t)
  }, [q])

  return (
    <div className="mt-8">
      <label htmlFor="sym" className="section-label">Add a stock</label>
      <input
        id="sym" value={q} onChange={(e) => setQ(e.target.value)}
        placeholder={examples.length ? `${examples.join(', ')}…` : 'Search by ticker or name…'}
        autoComplete="off"
        className="mt-2 w-full border-b border-ink-hairline bg-transparent py-2 text-[0.95rem] text-ink placeholder:text-ink-faint focus:border-ink"
      />
      {results.length > 0 ? (
        <ul className="mt-2 divide-y divide-ink-hairline border border-ink-hairline">
          {results.slice(0, 8).map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-4 px-3 py-2">
              <span className="min-w-0 text-[0.85rem]">
                <span className="text-ink">{r.name}</span>
                <span className="ml-2 text-[0.72rem] text-ink-faint">{r.ticker}</span>
              </span>
              <button
                disabled={busy || existing.has(r.id)}
                onClick={async () => {
                  setBusy(true)
                  try { await api.addSymbol(r.id); setQ(''); setResults([]); onAdded() } finally { setBusy(false) }
                }}
                className="shrink-0 border border-ink-hairline px-2.5 py-1 text-[0.72rem] hover:border-ink disabled:opacity-40"
              >
                {existing.has(r.id) ? 'Added' : 'Add'}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function Row({ item, market, onChanged }: { item: WatchlistItem; market?: MarketInfo; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(item.threshold?.value?.toString() ?? '')
  const [kind, setKind] = useState<'ABOVE' | 'BELOW'>(item.threshold?.kind ?? 'BELOW')

  return (
    /*
     * Row actions are present for keyboard and screen readers at all times, but
     * only become visually prominent on hover or focus. Repeating four controls
     * down thirty rows turned a list into a wall of buttons; hiding them from
     * assistive technology would have been the wrong way to fix that.
     */
    <li className="group border-t border-ink-hairline py-3.5 transition-colors focus-within:bg-paper-sunk/50 hover:bg-paper-sunk/50">
      <div className="flex items-baseline justify-between gap-4">
        <div className="min-w-0">
          <div className="truncate text-[0.95rem] text-ink">{item.name}</div>
          <div className="mt-0.5 text-[0.72rem] text-ink-faint">
            {item.ticker} · viewed {ago(item.lastSeenAt)}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="tnum text-[0.95rem] text-ink">{money(item.price, market)}</div>
          <div className="mt-0.5 flex justify-end">
            <ProvenanceBadge provenance={item.provenance} />
          </div>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <span className="text-[0.75rem]">
          {item.threshold ? (
            <span className="text-ink-muted">
              <span aria-hidden>◦ </span>Alert {item.threshold.kind === 'BELOW' ? 'below' : 'above'}{' '}
              <span className="tnum text-ink">{money(item.threshold.value, market)}</span>
            </span>
          ) : (
            <span className="text-ink-faint">No threshold set</span>
          )}
        </span>

        <span className="flex items-center gap-3 text-[0.75rem] opacity-0 transition-opacity focus-within:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100">
          <button
            onClick={() => setEditing((e) => !e)}
            className="tap text-ink-muted underline decoration-ink-hairline underline-offset-4 hover:text-ink"
          >
            {editing ? 'Cancel' : item.threshold ? 'Change' : 'Set threshold'}
          </button>
          <button
            onClick={async () => { await api.removeSymbol(item.symbolId); onChanged() }}
            className="tap text-ink-faint underline decoration-ink-hairline underline-offset-4 hover:text-signal"
          >
            Remove
          </button>
        </span>
      </div>

      {editing ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`kind-${item.symbolId}`}>Threshold direction</label>
          <select
            id={`kind-${item.symbolId}`}
            value={kind}
            onChange={(e) => setKind(e.target.value as 'ABOVE' | 'BELOW')}
            className="border border-ink-hairline bg-paper-raised px-2 py-1.5 text-[0.78rem]"
          >
            <option value="BELOW">Below</option>
            <option value="ABOVE">Above</option>
          </select>
          <label className="sr-only" htmlFor={`value-${item.symbolId}`}>Threshold price</label>
          <input
            id={`value-${item.symbolId}`}
            type="number" inputMode="decimal" value={value}
            onChange={(e) => setValue(e.target.value)}
            // Anchored near the current price. A fixed "1400" was a rupee-shaped
            // number offering a $1400 threshold on a $62 stock.
            placeholder={item.price ? String(Math.round(item.price)) : 'Price'}
            className="tnum w-28 border border-ink-hairline bg-paper-raised px-2 py-1.5 text-[0.78rem]"
          />
          <button
            onClick={async () => {
              const v = Number(value)
              const ok = Number.isFinite(v) && v > 0
              await api.setThreshold(item.symbolId, ok ? kind : null, ok ? v : null)
              setEditing(false); onChanged()
            }}
            className="border border-ink px-3 py-1.5 text-[0.78rem] hover:bg-ink hover:text-paper"
          >
            Save
          </button>
          {item.threshold ? (
            <button
              onClick={async () => { await api.setThreshold(item.symbolId, null, null); setEditing(false); onChanged() }}
              className="text-[0.75rem] text-ink-faint underline underline-offset-4 hover:text-signal"
            >
              Clear
            </button>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}
