/**
 * Is the real market feed reachable?
 *
 * Yahoo's endpoint is unofficial and rate-limits by IP, sometimes for many hours.
 * This answers the only question that matters before re-ingesting, in two seconds
 * instead of a five-minute run that fails at the end.
 *
 *   npm run feed:check
 */

// Load .env so a key in the file reaches this script without being exported.
import { existsSync, readFileSync } from 'node:fs'
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
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const PROBES = ['%5ENSEI', 'RELIANCE.NS']

let ok = 0
// eslint-disable-next-line prefer-const
for (const sym of PROBES) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=5d&interval=1d`
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(12_000) })
    const label = decodeURIComponent(sym).padEnd(14)
    if (res.ok) { ok++; console.log(`  ${label} ${res.status} reachable`) }
    else console.log(`  ${label} ${res.status} ${res.status === 429 ? 'rate-limited' : 'unavailable'}`)
  } catch (err) {
    console.log(`  ${decodeURIComponent(sym).padEnd(14)} failed — ${err.message}`)
  }
}

// Twelve Data is the fallback when Yahoo blocks a whole carrier range.
const td = process.env.TWELVEDATA_API_KEY
if (td) {
  try {
    const url = `https://api.twelvedata.com/time_series?symbol=RELIANCE&exchange=NSE&interval=1day&outputsize=2&apikey=${td}`
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    const json = await res.json()
    const good = json.status !== 'error' && Array.isArray(json.values) && json.values.length > 0
    console.log(`  ${'twelvedata'.padEnd(14)} ${good ? 'reachable' : `error: ${json.message ?? 'no data'}`}`)
    if (good) ok = PROBES.length
  } catch (err) {
    console.log(`  ${'twelvedata'.padEnd(14)} failed - ${err.message}`)
  }
} else {
  console.log(`  ${'twelvedata'.padEnd(14)} no TWELVEDATA_API_KEY set`)
}

console.log()
if (ok === PROBES.length) {
  console.log('  Feed is live. Run:  npm run ingest && npm run eval')
  console.log('  That replaces the simulated dataset with real NSE history and')
  console.log('  regenerates every number in the README and /eval.')
} else {
  console.log('  Feed is not available. The app keeps working on the deterministic')
  console.log('  synthetic dataset, which is labelled as simulated everywhere it appears.')
  console.log('  Rate limits are IP-based and usually clear within 24h — try again later.')
}
process.exit(ok === PROBES.length ? 0 : 1)
