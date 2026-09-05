/** Same-origin: requests are proxied to the API by Next (see next.config.mjs). */
export const API = ''

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

/** Every request carries the session cookie; the API is a separate local origin. */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Only declare a JSON content-type when a body is actually being sent —
  // an empty body with that header is a 400 from any strict server.
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> ?? {}) }
  if (init.body !== undefined && init.body !== null) headers['content-type'] = 'application/json'

  const res = await fetch(`${API}${path}`, { ...init, credentials: 'include', headers })
  const text = await res.text()
  const body = text ? JSON.parse(text) : {}
  if (!res.ok) {
    const e = body?.error ?? {}
    throw new ApiError(res.status, e.code ?? 'UNKNOWN', e.message ?? res.statusText)
  }
  return body as T
}

export const api = {
  session: () => request<{ userId: string }>('/api/session/demo', { method: 'POST' }),
  brief: (at?: string, budget?: string) => {
    const p = new URLSearchParams()
    if (at) p.set('at', at)
    if (budget) p.set('budget', budget)
    return request<Brief>(`/api/brief${p.toString() ? `?${p}` : ''}`)
  },
  watchlist: () => request<WatchlistResponse>('/api/watchlist'),
  search: (q: string) => request<{ results: SymbolRow[] }>(`/api/symbols/search?q=${encodeURIComponent(q)}`),
  addSymbol: (symbolId: string) => request('/api/watchlist/items', { method: 'POST', body: JSON.stringify({ symbolId }) }),
  removeSymbol: (symbolId: string) => request(`/api/watchlist/items/${encodeURIComponent(symbolId)}`, { method: 'DELETE' }),
  setThreshold: (symbolId: string, kind: 'ABOVE' | 'BELOW' | null, value: number | null) =>
    request(`/api/watchlist/items/${encodeURIComponent(symbolId)}/threshold`, {
      method: 'PUT', body: JSON.stringify({ kind, value }),
    }),
  markSeen: (symbolIds: string[], at?: string) =>
    request<{ updated: number }>('/api/cursor/seen', { method: 'POST', body: JSON.stringify({ symbolIds, at }) }),
  markAllSeen: (at?: string) =>
    request<{ updated: number }>('/api/cursor/seen-all', { method: 'POST', body: JSON.stringify({ at }) }),
  change: (id: string) => request<ChangeDetail>(`/api/changes/${id}`),
  investigate: (id: string) => request<{ status: string }>(`/api/changes/${id}/investigate`, { method: 'POST' }),
  investigation: (id: string) => request<InvestigationResponse>(`/api/changes/${id}/investigation`),
  replay: (id: string) => request<ReplayResponse>(`/api/changes/${id}/replay`),
  dataHealth: () => request<DataHealth>('/api/data-health'),
  settings: () => request<Settings>('/api/settings'),
  saveSettings: (b: { budget?: string; maxCards?: number }) =>
    request('/api/settings', { method: 'PATCH', body: JSON.stringify(b) }),
  evaluation: () => request<EvalReport>('/api/eval'),
  feedback: (id: string, verdict: 'USEFUL' | 'NOT_USEFUL') =>
    request(`/api/changes/${id}/feedback`, { method: 'POST', body: JSON.stringify({ verdict }) }),
}

/* ------------------------------------------------------------------ types */

export interface MarketInfo {
  id: string; label: string; timeZone: string
  currency: string; locale: string; benchmark: string
  /** When the exchange last closed, so the client need not own a calendar. */
  lastCloseAt?: string | null
}
export type Tier = 'NORMAL' | 'WORTH_WATCHING' | 'SIGNIFICANT' | 'CRITICAL' | 'SUPPRESSED'
export type Quality = 'FRESH' | 'DELAYED' | 'STALE' | 'UNAVAILABLE' | 'CONFLICTING' | 'SUSPECT'
export type Provenance =
  | 'LIVE' | 'SIMULATED' | 'REPLAY' | 'DELAYED'
  | 'STALE' | 'UNAVAILABLE' | 'CONFLICTING' | 'SUSPECT'

export interface Contribution {
  key: string; label: string; z: number; weight: number; points: number; detail: string
}
export interface Score {
  symbolId: string; raw: number; pctl: number; tier: Tier
  contributions: Contribution[]
  quality: Quality; qualityReason: string
  returnPct: number | null; expectedPct: number | null
  residualPct: number | null; residualZ: number | null
  degraded: string | null
}
export interface ScoreText { text: string; saturated: boolean }
export interface Card {
  symbolId: string; score: Score; frequency: string; changeId: string | null
  scoreText?: ScoreText
  provenance?: Provenance
  group?: { sectorId: string; sectorName: string; members: string[] }
}
export interface Brief {
  window: { windowStart: string; windowEnd: string; sessions: number; isFirstVisit: boolean; awayMs: number; awayLabel: string }
  at: string
  totalWatched: number; changedCount: number; attentionCount: number
  filteredCount: number; suppressedCount: number
  regime: { active: boolean; indexReturnPct: number; breadth: number
    withMarket: number; movedTotal: number; headline: string } | null
  cards: Card[]
  suppressed: { symbolId: string; quality: Quality; reason: string; provenance?: Provenance }[]
  budget: string; budgetLabel: string; budgetThreshold: number; cap: number
  symbolNames: Record<string, string>
  sectors: Record<string, { id: string; name: string } | null>
  simulated: boolean; provider: string; isReplay?: boolean
  market?: MarketInfo
}
export interface SymbolRow { id: string; ticker: string; name: string; sectorId: string | null }
export interface WatchlistItem extends SymbolRow {
  symbolId: string; position: number; price: number | null; observedAt: string | null
  sources: string[]; lastSeenAt: string | null; provenance?: Provenance
  threshold: { kind: 'ABOVE' | 'BELOW'; value: number } | null
}
export interface WatchlistResponse {
  watchlistId: string | null; items: WatchlistItem[]
  provider?: string; simulated?: boolean; market?: MarketInfo
}
export interface ChangeDetail {
  change: {
    id: string; symbolId: string; windowStart: string; windowEnd: string
    raw: number; pctl: number; tier: Tier; contributions: Contribution[]
    returnPct: number | null; quality: Quality
  }
  symbol: SymbolRow | null
  market?: MarketInfo
  frequency: string
  scoreText?: ScoreText
  provenance?: Provenance
  stats: { beta: number | null; residMad: number | null; sampleN: number; asOf: string } | null
  investigation: unknown
}
export interface EvidenceRow {
  id: string; hypothesis: string | null; type: string; source: string
  observation: string; observedAt: string | null; stance: 'SUPPORTS' | 'CONTRADICTS' | 'NEUTRAL'
}
export interface TrailStep {
  seq: number; tool: string; label: string; headline: string; at: string
  narrowedBy?: string
}
export interface InvestigationResponse {
  status: string
  stage?: string | null
  trail?: TrailStep[]
  investigation: {
    id: string; status: string; primaryHypothesis: string | null
    hypotheses: unknown; conclusion: string | null; confidence: string | null
    toolCalls: number; fallbackUsed: boolean
    conclusionInsufficient?: boolean
  } | null
  evidence: EvidenceRow[]
}
export interface ReplayPoint {
  ts: string; close: number; volume: number
  returnPct: number | null; residualPct: number | null; residualSigmas: number | null
}
export interface ReplayResponse {
  windowStart: string; windowEnd: string; symbolId: string
  points: ReplayPoint[]
  events: { publishedAt: string; type: string; headline: string; source: string }[]
  attentionCrossedAt: string | null
  note: string | null
}
export interface QuarantineRow {
  symbolId: string; name: string; date: string; reason: string
  impliedRatio: number | null; apparentMovePct: number | null; wouldHaveShown: string | null
}
export interface DataHealth {
  provider: string; simulated: boolean; marketOpen: boolean; at: string
  market?: MarketInfo
  symbols: { symbolId: string; quality: Quality; reason: string; provenance?: Provenance; ageMs: number | null; sources: string[]
    values: { source: string; price: number | null; observedAt: string }[] }[]
  quarantined: QuarantineRow[]
}
export interface BudgetMeasurement { meanPerSession: number; precision: number; recall: number }
export interface BudgetOption {
  value: string; label: string; threshold: number
  title: string; blurb: string
  measured: BudgetMeasurement | null
}
export interface Settings {
  budget: string; maxCards: number; budgetLabel: string; budgetThreshold: number
  options: BudgetOption[]
  measuredFrom: unknown
}
export interface EvalReport {
  generatedAt: string
  dataset: { provider: string; simulated: boolean; symbols: number; alignedSessions: number
    calibrationSessions: number; evaluationSessions: number; benchmark: string; universe?: string }
  companion?: EvalReport | null
  topK: number
  labels: { id: string; description: string; horizon: number; sigmas: number }[]
  precisionAtK: Record<string, { label: string; byLabel: Record<string, number> }>
  alertVolume: Record<string, { thresholdPercentile: number; meanAlertsPerSessionPer50Symbols: number
    medianAlertsPerSession: number; maxAlertsPerSession: number
    precision: number; recall: number; alertsFired: number; labelUsed: string }>
}
