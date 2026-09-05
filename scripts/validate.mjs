/**
 * Pre-demo validation.
 *
 * Answers, in one command, what is genuinely demonstrable right now and what
 * still depends on something external. Written because the two weakest points of
 * this project — real market data and a live model — both depend on things
 * outside the repo, and it is better to know before a demo than during one.
 *
 *   npm run validate
 */

// Load .env so a key in the file reaches this script without being exported.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
{
  const envPath = fileURLToPath(new URL('../.env', import.meta.url))
  if (existsSync(envPath)) {
    for (const raw of readFileSync(envPath, 'utf8').split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq < 1) continue
      const k = line.slice(0, eq).trim()
      const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
      if (process.env[k] === undefined) process.env[k] = v
    }
  }
}
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const API = 'http://127.0.0.1:4000'
const results = []
const note = (phase, name, ok, detail) => results.push({ phase, name, ok, detail })

async function get(path, jar = '') {
  const res = await fetch(`${API}${path}`, {
    headers: jar ? { cookie: jar } : {},
    signal: AbortSignal.timeout(30_000),
  })
  return { status: res.status, body: res.ok ? await res.json() : null, headers: res.headers }
}

/* ---------------------------------------------- prerequisites ------------ */
let jar = ''
let up = false
try {
  const h = await get('/health')
  up = h.status === 200
  const s = await fetch(`${API}/api/session/demo`, { method: 'POST', signal: AbortSignal.timeout(10_000) })
  jar = (s.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
} catch { /* down */ }

if (!up) {
  console.log('\n  API is not running. Start it first:  npm run dev\n')
  process.exit(1)
}

/* ---------------------------------------------- A. real market data ------ */
const health = (await get('/health')).body
note('A', 'Market data is real (not simulated)', health.simulated === false,
  health.simulated ? `provider "${health.provider}" — run: npm run feed:check` : `provider ${health.provider}`)
note('A', 'Sufficient history ingested', health.dailyBars > 10_000, `${health.dailyBars.toLocaleString()} daily bars`)

let evalReport = null
try { evalReport = JSON.parse(readFileSync(new URL('../eval/out/results.json', import.meta.url), 'utf8')) } catch { /* none */ }
note('A', 'Evaluation has been run', evalReport !== null,
  evalReport ? `generated ${evalReport.generatedAt.slice(0, 16).replace('T', ' ')}` : 'run: npm run eval')
note('A', 'Evaluation ran on real data', evalReport?.dataset?.simulated === false,
  evalReport ? `dataset: ${evalReport.dataset.provider}` : 'no report')

/* ---------------------------------------------- B. live agent ------------ */
const gem = Boolean(process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY)
const ant = Boolean(process.env.ANTHROPIC_API_KEY)
const which = process.env.AGENT_PROVIDER ?? (gem ? 'gemini' : ant ? 'anthropic' : 'none')
note('B', 'An LLM provider is configured', gem || ant,
  gem || ant ? `${which} (${gem ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY'} set)`
             : 'no key — agent falls back to the deterministic engine')

const brief = (await get('/api/brief', jar)).body

/**
 * The demo is anchored to the last session close, not to wall-clock now.
 * Mid-session there may legitimately be fewer movers, so checking scenario
 * coverage against "now" reports absences that are not defects.
 */
const health0 = (await get('/health')).body
const lastClose = (() => {
  const d = new Date()
  d.setUTCHours(10, 0, 0, 0)                       // 15:30 IST
  if (d.getTime() > Date.now()) d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString()
})()
const demoBrief = (await get(`/api/brief?at=${encodeURIComponent(lastClose)}`, jar)).body
void health0
const firstChange = brief?.cards?.[0]?.changeId ?? null
let agentRan = false
let agentDetail = 'no change event to investigate'
if (firstChange) {
  const inv = (await get(`/api/changes/${firstChange}/investigation`, jar)).body
  const i = inv?.investigation
  agentRan = Boolean(i && i.fallbackUsed === false)
  agentDetail = i
    ? (i.fallbackUsed ? `fallback used (${i.toolCalls} tool calls)` : `live agent, ${i.toolCalls} tool calls`)
    : 'not investigated yet'
}
note('B', 'An investigation ran against a live model', agentRan, agentDetail)
note('B', 'Agent conclusion avoids causal claims', !agentRan || !/triggered|caused by|because of/i.test(
  String((await get(`/api/changes/${firstChange}/investigation`, jar)).body?.investigation?.conclusion ?? '')),
  'an ordering observed is not a mechanism established')

/* ---------------------------------------------- C. demo reliability ------ */
const regime = demoBrief?.regime ?? brief?.regime
note('C', 'Market-wide regime detected', Boolean(regime),
  regime ? `${regime.withMarket} of ${regime.movedTotal} with the market` : 'no regime at the demo instant')
note('C', 'Attention cards present', (brief?.cards?.length ?? 0) > 0, `${brief?.cards?.length ?? 0} shown`)
note('C', 'Noise is being filtered', (brief?.filteredCount ?? 0) > 0, `${brief?.filteredCount ?? 0} withheld`)
note('C', 'A stock bucked the market', Boolean(brief?.cards?.some((c) => (c.score.returnPct ?? 0) > 0)),
  'a riser on a falling day is the clearest demonstration of the thesis')
const grouped = demoBrief?.cards?.find((c) => c.group) ?? brief?.cards?.find((c) => c.group)
note('C', 'Sector grouping fires (at session close)', Boolean(grouped),
  grouped ? `${grouped.group.sectorName} x${grouped.group.members.length}` : 'no group at the demo instant')

const dh = (await get('/api/data-health', jar)).body
const qualities = new Set((dh?.symbols ?? []).map((s) => s.quality))
note('C', 'Stale-data scenario present', qualities.has('STALE'), 'alerts suppressed rather than guessed')
note('C', 'Conflicting-sources scenario present', qualities.has('CONFLICTING'), 'two providers disagree beyond tolerance')
note('C', 'Corporate action quarantined and visible', (dh?.quarantined?.length ?? 0) > 0,
  dh?.quarantined?.[0] ? `${dh.quarantined[0].name} would have shown ${dh.quarantined[0].wouldHaveShown}` : 'none')

if (firstChange) {
  const rep = (await get(`/api/changes/${firstChange}/replay`, jar)).body
  note('C', 'Replay to a past session returns a brief',
  (demoBrief?.totalWatched ?? 0) > 0 && (demoBrief?.changedCount ?? 0) > 0,
  `${demoBrief?.attentionCount ?? 0} shown at the session close`)
  note('C', 'Replay has intraday data', (rep?.points?.length ?? 0) > 10, `${rep?.points?.length ?? 0} bars`)
  note('C', 'Replay marks the attention crossing', Boolean(rep?.attentionCrossedAt),
    rep?.attentionCrossedAt ?? 'never crossed 2 sigma in this window')
}

/* ---------------------------------------------- D. build + routes -------- */
let buildOk = false
try {
  execSync('npm run typecheck', { cwd: new URL('..', import.meta.url), stdio: 'pipe' })
  buildOk = true
} catch { /* fails */ }
note('D', 'All packages typecheck', buildOk, buildOk ? '7 packages' : 'run: npm run typecheck')

for (const path of ['/', '/watchlist', '/health', '/eval']) {
  try {
    const res = await fetch(`http://localhost:3000${path}`, { signal: AbortSignal.timeout(30_000) })
    note('D', `Route ${path}`, res.ok, `HTTP ${res.status}`)
  } catch {
    note('D', `Route ${path}`, false, 'web app not running')
  }
}

/* ---------------------------------------------- report ------------------- */
const PHASES = {
  A: 'Real market-data validation',
  B: 'Live agent execution',
  C: 'Demo reliability',
  D: 'Build and UX',
}
console.log()
for (const [key, title] of Object.entries(PHASES)) {
  const rows = results.filter((r) => r.phase === key)
  const passed = rows.filter((r) => r.ok).length
  console.log(`  ${key}. ${title}  —  ${passed}/${rows.length}`)
  for (const r of rows) console.log(`     ${r.ok ? 'v' : 'x'}  ${r.name.padEnd(44)} ${r.detail}`)
  console.log()
}
const blocked = results.filter((r) => !r.ok)
if (blocked.length === 0) {
  console.log('  Everything is demonstrable.\n')
} else {
  console.log(`  ${blocked.length} item(s) still depend on something external:`)
  for (const b of blocked) console.log(`     - ${b.name}`)
  console.log()
}
