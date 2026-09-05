'use client'
import { useEffect, useRef, useState } from 'react'
import type { InvestigationResponse, EvidenceRow, TrailStep } from '@/lib/api'

const HYPOTHESES = [
  { id: 'MARKET', label: 'The broad market explains it' },
  { id: 'SECTOR', label: 'A sector-wide move explains it' },
  { id: 'EVENT', label: 'A company-specific event explains it' },
  { id: 'DATA_ARTIFACT', label: 'Not a real move — data or corporate action' },
  { id: 'UNEXPLAINED', label: 'Idiosyncratic, with nothing found to explain it' },
] as const

const STAGE_LABEL: Record<string, string> = {
  ANALYZING_MOVEMENT: 'Analysing the movement',
  COMPARING_MARKET: 'Comparing against the market',
  CHECKING_SECTOR: 'Checking the sector',
  INSPECTING_VOLUME: 'Inspecting volume',
  READING_INTRADAY_SHAPE: 'Reading the intraday shape',
  INVESTIGATING_EVENTS: 'Investigating events',
  CHECKING_CORPORATE_ACTIONS: 'Checking corporate actions',
  VERIFYING_DATA_HEALTH: 'Verifying data health',
  RECORDING_FINDING: 'Recording a finding',
  FORMING_CONCLUSION: 'Forming a conclusion',
}

/**
 * The investigation, shown as what it is: a pipeline that narrows five candidate
 * explanations down using evidence it went and fetched.
 *
 * Deliberately not a chat window and deliberately not a progress bar. Every step
 * shown is a tool call that actually happened, and every headline is derived
 * from that tool's own output — never from model prose. Where a later call was
 * narrowed by an earlier finding, that dependency is stated, because it is the
 * difference between an agent and a script.
 */
export function Investigation({
  changeId, initial, onStart, poll, subject, movePct,
}: {
  changeId: string
  initial: InvestigationResponse | null
  onStart: () => Promise<void>
  poll: () => Promise<InvestigationResponse>
  /** Names what is being investigated, so the panel stands on its own. */
  subject?: string
  movePct?: number | null
}) {
  const [state, setState] = useState<InvestigationResponse | null>(initial)
  const [running, setRunning] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => setState(initial), [initial])
  useEffect(() => () => { if (timer.current) clearInterval(timer.current) }, [])

  const status = state?.status ?? 'PENDING'
  const done = ['COMPLETED', 'INSUFFICIENT_EVIDENCE', 'FAILED'].includes(status) && Boolean(state?.investigation)
  const trail: TrailStep[] = state?.trail ?? []
  const findings = parseFindings(state?.investigation?.hypotheses)
  const primary = state?.investigation?.primaryHypothesis ?? null
  const insufficient = status === 'INSUFFICIENT_EVIDENCE' || state?.investigation?.conclusionInsufficient === true

  async function start() {
    setRunning(true)
    await onStart()
    timer.current = setInterval(async () => {
      const next = await poll()
      setState(next)
      if (next.investigation && ['COMPLETED', 'INSUFFICIENT_EVIDENCE', 'FAILED'].includes(next.status)) {
        if (timer.current) clearInterval(timer.current)
        setRunning(false)
      }
    }, 700)
  }

  return (
    <section id="investigation" className="section scroll-mt-8">
      <h2 className="section-label">Investigation</h2>
      {subject ? (
        <p className="mt-2 font-serif text-[1.15rem] leading-snug text-ink">
          {done || running ? 'Investigating why' : 'Why did'} {subject}{' '}
          {done || running ? 'moved' : 'move'}{' '}
          {typeof movePct === 'number' ? (
            <span className="tnum">{movePct > 0 ? '+' : ''}{movePct.toFixed(1)}%</span>
          ) : null}
          {done || running ? '' : '?'}
        </p>
      ) : null}

      {!done && !running ? (
        <Intro onStart={() => void start()} />
      ) : (
        <div className="mt-6">
          <Step n={1} title="Anomaly detected" state="done">
            <p className="text-[0.82rem] leading-relaxed text-ink-muted">
              The scoring engine already established that this change is significant. That part is
              arithmetic and is not the agent’s to revise.
            </p>
          </Step>

          <Step n={2} title="Hypotheses opened" state="done">
            <ul className="space-y-1">
              {HYPOTHESES.map((h) => (
                <li key={h.id} className="text-[0.8rem] text-ink-muted">{h.label}</li>
              ))}
            </ul>
          </Step>

          <Step
            n={3}
            title="Evidence gathered"
            state={done ? 'done' : 'active'}
            meta={done ? `${trail.length} step${trail.length === 1 ? '' : 's'}` : undefined}
          >
            <Trail trail={trail} activeStage={state?.stage ?? null} running={!done} />
          </Step>

          <Step n={4} title="Hypotheses resolved" state={done ? 'done' : 'pending'}>
            {done ? <Resolved findings={findings} primary={primary} /> : <Waiting />}
          </Step>

          <Step n={5} title="Conclusion" state={done ? 'done' : 'pending'} last>
            {done && state?.investigation ? (
              <Conclusion state={state} insufficient={insufficient} />
            ) : <Waiting />}
          </Step>

          {done ? <Evidence rows={state?.evidence ?? []} /> : null}
        </div>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ pieces */

function Intro({ onStart }: { onStart: () => void }) {
  return (
    <div className="mt-4">
      <p className="max-w-prose text-[0.85rem] leading-relaxed text-ink-muted">
        The scoring engine has already decided this change is significant — that is arithmetic,
        not judgement. An investigation asks a different question: <span className="text-ink">why</span>{' '}
        did it happen? Five candidate explanations are opened, and an agent gathers evidence to rule
        them out — choosing what to look at next based on what the last look returned.
      </p>
      <button
        onClick={onStart}
        className="mt-5 border border-ink px-4 py-2 text-[0.8rem] transition-colors hover:bg-ink hover:text-paper"
      >
        Investigate this change
      </button>
    </div>
  )
}

function Step({
  n, title, state, meta, children, last,
}: {
  n: number
  title: string
  state: 'done' | 'active' | 'pending'
  meta?: string | undefined
  children: React.ReactNode
  last?: boolean
}) {
  const mark = state === 'done' ? '✓' : state === 'active' ? '◍' : '·'
  return (
    <div className="grid grid-cols-[1.5rem_1fr] gap-x-4">
      <div className="flex flex-col items-center">
        <span
          aria-hidden
          className={`text-[0.75rem] leading-6 ${state === 'pending' ? 'text-ink-hairline' : state === 'active' ? 'text-signal' : 'text-ink-muted'}`}
        >
          {mark}
        </span>
        {!last ? <span className="w-px flex-1 bg-ink-hairline" /> : null}
      </div>
      <div className={last ? 'pb-1' : 'pb-7'}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4">
          <h3 className={`text-[0.7rem] uppercase tracking-[0.13em] ${state === 'pending' ? 'text-ink-faint' : 'text-ink'}`}>
            <span className="tnum mr-2 text-ink-faint">{n}</span>{title}
          </h3>
          {meta ? <span className="text-[0.7rem] text-ink-faint">{meta}</span> : null}
        </div>
        <div className="mt-2.5">{children}</div>
      </div>
    </div>
  )
}

function Trail({ trail, activeStage, running }: { trail: TrailStep[]; activeStage: string | null; running: boolean }) {
  if (trail.length === 0 && !running) {
    return <p className="text-[0.8rem] text-ink-faint">No steps recorded.</p>
  }
  return (
    <div>
      <ol className="space-y-2.5">
        {trail.map((s) => (
          <li key={`${s.seq}-${s.tool}`} className="rise">
            {s.narrowedBy ? (
              <p className="mb-1.5 ml-[1.1rem] border-l-2 border-signal pl-2.5 text-[0.72rem] leading-snug text-signal">
                Narrowed because the {s.narrowedBy} — this step was chosen from the last result,
                not from a script.
              </p>
            ) : null}
            <div className="grid grid-cols-[1.1rem_1fr] gap-x-2.5">
              <span aria-hidden className="text-[0.72rem] leading-5 text-ink-muted">✓</span>
              <span className="min-w-0">
                <span className="section-label block">{s.label}</span>
                <span className="mt-1 block text-[0.85rem] leading-relaxed text-ink">{s.headline}</span>
                <span className="mt-0.5 block font-mono text-[0.63rem] text-ink-faint">{s.tool}</span>
              </span>
            </div>
          </li>
        ))}
      </ol>
      {running ? (
        <p className="mt-3 flex items-center gap-2 text-[0.78rem] text-ink-muted" aria-live="polite">
          <span aria-hidden className="text-signal">◍</span>
          {activeStage ? STAGE_LABEL[activeStage] ?? 'Working' : 'Working'}…
        </p>
      ) : null}
    </div>
  )
}

function Resolved({ findings, primary }: { findings: Finding[]; primary: string | null }) {
  return (
    <ul className="space-y-2">
      {HYPOTHESES.map((h) => {
        const f = findings.find((x) => x.hypothesis === h.id)
        const isPrimary = primary === h.id
        const rejected = f?.verdict === 'REJECTED'
        const insufficient = f?.verdict === 'INSUFFICIENT'
        return (
          <li key={h.id} className="grid grid-cols-[1.1rem_1fr] gap-x-2 text-[0.82rem]">
            <span aria-hidden className={isPrimary ? 'text-signal' : 'text-ink-faint'}>
              {isPrimary ? '●' : rejected ? '✕' : insufficient ? '?' : f ? '○' : '·'}
            </span>
            <span className="min-w-0">
              <span className={rejected ? 'text-ink-faint line-through' : isPrimary ? 'text-ink' : 'text-ink-muted'}>
                {h.label}
              </span>
              {isPrimary ? <span className="ml-2 text-[0.68rem] uppercase tracking-[0.1em] text-signal">supported</span> : null}
              {f?.reason ? (
                <span className="mt-0.5 block text-[0.72rem] leading-relaxed text-ink-faint">{f.reason}</span>
              ) : !f ? (
                <span className="mt-0.5 block text-[0.72rem] text-ink-faint">not evaluated</span>
              ) : null}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function Conclusion({ state, insufficient }: { state: InvestigationResponse; insufficient: boolean }) {
  const i = state.investigation!
  return (
    <div>
      {i.fallbackUsed ? (
        <p className="mb-4 border-l-2 border-ink-hairline pl-3 text-[0.78rem] leading-relaxed text-ink-muted">
          <span className="text-ink">No model was called.</span> The steps above were performed by the
          deterministic engine, and this explanation comes from it. That path is the default when the
          agent is unavailable — not a degraded one.
        </p>
      ) : null}

      {i.conclusion ? (
        <blockquote className="border-l-2 border-signal pl-4">
          <p className="font-serif text-[1.05rem] leading-snug text-ink">{i.conclusion}</p>
        </blockquote>
      ) : null}

      {insufficient ? (
        <p className="mt-4 max-w-prose border-l-2 border-ink-hairline pl-3 text-[0.8rem] leading-relaxed text-ink-muted">
          <span className="text-ink">Insufficient evidence.</span> A significant move was detected, but
          what was found does not establish why. Saying so is the correct answer — the alternative is a
          confident guess.
        </p>
      ) : null}

      <dl className="mt-5 flex flex-wrap gap-x-8 gap-y-2 text-[0.75rem]">
        <Meta label="Confidence" value={i.confidence ?? '—'} />
        <Meta label="Tool calls" value={String(i.toolCalls)} />
        <Meta label="Source" value={i.fallbackUsed ? 'deterministic engine' : 'agent'} />
      </dl>
    </div>
  )
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-ink-faint">{label}</dt>
      <dd className="text-ink">{value.toLowerCase()}</dd>
    </div>
  )
}

function Waiting() {
  return <p className="text-[0.78rem] text-ink-faint">Waiting on the evidence above.</p>
}

function Evidence({ rows }: { rows: EvidenceRow[] }) {
  if (rows.length === 0) return null
  return (
    <div className="mt-8 border-t border-ink-hairline pt-6">
      <h3 className="section-label">Evidence behind the conclusion</h3>
      <ul className="mt-3 space-y-3">
        {rows.map((e, i) => (
          <li key={e.id} className="rise border-l border-ink-hairline pl-3" style={{ animationDelay: `${i * 80}ms` }}>
            <p className="text-[0.85rem] leading-relaxed text-ink">{e.observation}</p>
            <p className="mt-0.5 text-[0.7rem] text-ink-faint">
              {e.stance.toLowerCase()} · {e.type.toLowerCase()} · {e.source}
            </p>
          </li>
        ))}
      </ul>
      <p className="mt-4 max-w-prose text-[0.72rem] leading-relaxed text-ink-faint">
        Every figure in the conclusion is checked against these observations before it is shown. A
        number that appears in neither is treated as fabricated and the generated wording is discarded.
      </p>
    </div>
  )
}

interface Finding { hypothesis: string; verdict: string; reason: string }
function parseFindings(raw: unknown): Finding[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((f): f is Finding =>
    typeof f === 'object' && f !== null && 'hypothesis' in f && 'verdict' in f)
}
