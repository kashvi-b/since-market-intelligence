import type { Tier } from '@/lib/api'

export type Provenance =
  | 'LIVE' | 'SIMULATED' | 'REPLAY' | 'DELAYED'
  | 'STALE' | 'UNAVAILABLE' | 'CONFLICTING' | 'SUSPECT'

/**
 * What this number actually is — never merely how fresh it is.
 *
 * A generated price is the newest value we hold, but calling it "Live" would be
 * a lie in the one place this product promises not to tell them. Provenance and
 * freshness are different questions and are answered separately.
 */
const PROVENANCE_COPY: Record<Provenance, { label: string; tone: string; mark: string; title: string }> = {
  LIVE: { label: 'Live', tone: 'text-ink-faint', mark: '●', title: 'Live market data' },
  SIMULATED: { label: 'Simulated', tone: 'text-ink-muted', mark: '◆', title: 'Deterministic generated data — not real market activity' },
  REPLAY: { label: 'Replay', tone: 'text-ink-muted', mark: '◷', title: 'A past moment, re-evaluated through the same engine' },
  DELAYED: { label: 'Delayed', tone: 'text-ink-muted', mark: '◐', title: 'Real and current, but behind' },
  STALE: { label: 'Stale', tone: 'text-signal', mark: '○', title: 'Too old to reason about — alerts suppressed' },
  UNAVAILABLE: { label: 'Unavailable', tone: 'text-signal', mark: '✕', title: 'No value on record' },
  CONFLICTING: { label: 'Conflicting sources', tone: 'text-signal', mark: '⚠', title: 'Sources disagree beyond tolerance — alerts suppressed' },
  SUSPECT: { label: 'Quarantined', tone: 'text-signal', mark: '⚠', title: 'Failed a sanity check — excluded from statistics' },
}

/** Never colour alone: every state carries a mark and a word. */
export function ProvenanceBadge({
  provenance, reason, exchange,
}: {
  provenance: Provenance | undefined
  reason?: string
  /** Exchange label, when the caller knows it. Naming the venue is better than
   *  a bare "Live", but the venue is data — hardcoding one put "Live NSE market
   *  data" under Tesla the moment US prices started passing the freshness gate. */
  exchange?: string
}) {
  const base = PROVENANCE_COPY[provenance ?? 'UNAVAILABLE']
  const c = provenance === 'LIVE' && exchange
    ? { ...base, label: exchange, title: `Live ${exchange} market data` }
    : base
  return (
    <span className={`inline-flex items-center gap-1.5 text-[0.7rem] ${c.tone}`} title={reason ?? c.title}>
      <span aria-hidden>{c.mark}</span>
      <span>{c.label}</span>
      <span className="sr-only">{c.title}</span>
    </span>
  )
}

const TIER_COPY: Record<Tier, string> = {
  CRITICAL: 'Attention',
  SIGNIFICANT: 'Attention',
  WORTH_WATCHING: 'Worth watching',
  NORMAL: 'Normal',
  SUPPRESSED: 'Withheld',
}

export function TierLabel({ tier }: { tier: Tier }) {
  const strong = tier === 'CRITICAL' || tier === 'SIGNIFICANT'
  return (
    <span className={`eyebrow ${strong ? 'text-signal' : 'text-ink-faint'}`}>{TIER_COPY[tier]}</span>
  )
}

/**
 * The attention score, always shown with its frequency.
 * A bare "97" is a rating; "97 — about 7 days a year" is a fact.
 */
export function AttentionScore({
  pctl, frequency, scoreText,
}: {
  pctl: number
  frequency: string
  scoreText?: { text: string; saturated: boolean }
}) {
  // A saturated grid means "the most extreme value we have on record" — which is
  // a statement about our sample, not certainty. It must never read as "100".
  const text = scoreText?.text ?? (pctl >= 99.95 ? '99+' : String(Math.round(pctl)))
  const saturated = scoreText?.saturated ?? pctl >= 99.95
  return (
    <div className="flex items-baseline gap-2">
      <span className="tnum font-serif text-2xl leading-none text-ink">{text}</span>
      <span className="text-[0.7rem] text-ink-faint">
        {saturated ? 'top of its recorded range' : <><span className="tnum">{ordinal(Math.round(pctl))}</span> percentile</>}
        {' · '}{frequency}
      </span>
    </div>
  )
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0])
}

export function Delta({ value }: { value: number | null }) {
  if (value === null) return <span className="text-ink-faint">—</span>
  const down = value < 0
  return (
    <span className={`tnum ${down ? 'text-signal' : 'text-positive'}`}>
      <span aria-hidden>{down ? '▾' : '▴'}</span>{' '}
      {value > 0 ? '+' : ''}{value.toFixed(2)}%
    </span>
  )
}
