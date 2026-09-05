'use client'
import { useEffect } from 'react'

/**
 * Route error boundary.
 *
 * Without this a render-time throw leaves a blank page — which is exactly how a
 * broken route hid during development. A failure should always be visible and
 * should always say what to do next.
 */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => { console.error('[since] route error', error) }, [error])
  return (
    <div className="py-16">
      <p className="lede">This page hit an error.</p>
      <p className="mt-3 max-w-prose text-[0.9rem] text-ink-muted">{error.message}</p>
      {error.digest ? <p className="mt-1 font-mono text-[0.72rem] text-ink-faint">{error.digest}</p> : null}
      <button onClick={reset} className="mt-5 border border-ink px-4 py-2 text-[0.8rem] hover:bg-ink hover:text-paper">
        Try again
      </button>
    </div>
  )
}
