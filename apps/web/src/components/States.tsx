export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="space-y-3 py-10" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="h-3 animate-pulse rounded bg-paper-sunk" style={{ width: `${88 - i * 14}%` }} />
      ))}
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="py-12">
      <p className="lede">Something didn’t load.</p>
      <p className="mt-3 max-w-prose text-[0.9rem] text-ink-muted">{message}</p>
      {/* Deployed, this is read by strangers: telling them to start a server on
          their own laptop is noise at best. The local hint only makes sense in
          development, where it is genuinely the usual cause. */}
      {process.env.NODE_ENV === 'development' ? (
        <p className="mt-2 max-w-prose text-[0.8rem] text-ink-faint">
          Since needs its local API running on port 4000 and a seeded database.
          Start them with <code className="font-mono">npm run api</code> and{' '}
          <code className="font-mono">npm run ingest</code>.
        </p>
      ) : (
        <p className="mt-2 max-w-prose text-[0.8rem] text-ink-faint">
          This is usually temporary. If it persists, the service may be waking up —
          give it a moment and try again.
        </p>
      )}
      {onRetry ? (
        <button onClick={onRetry} className="mt-5 border border-ink px-4 py-2 text-[0.8rem] hover:bg-ink hover:text-paper">
          Try again
        </button>
      ) : null}
    </div>
  )
}

export function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="py-14">
      <p className="lede">{title}</p>
      <p className="mt-3 max-w-prose text-[0.9rem] leading-relaxed text-ink-muted">{body}</p>
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  )
}

/** Shown whenever the dataset is not real market data. Never hidden. */
export function SimulatedBanner({ provider }: { provider: string }) {
  return (
    <div className="mt-6 border-l-2 border-signal bg-signal-soft/40 px-4 py-3">
      <p className="text-[0.75rem] leading-relaxed text-ink-muted">
        <span className="font-medium text-ink">Simulated dataset ({provider}).</span>{' '}
        The live market feed was unavailable during ingestion, so this is deterministic
        generated market data — reproducible from a seed, and never presented as live. Re-run{' '}
        <code className="font-mono text-[0.72rem]">npm run ingest</code> to load real data.
      </p>
    </div>
  )
}
