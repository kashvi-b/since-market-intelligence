import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
{
  const p = fileURLToPath(new URL('../.env', import.meta.url))
  if (existsSync(p)) for (const raw of readFileSync(p, 'utf8').split('\n')) {
    const t = raw.trim(); if (!t || t.startsWith('#')) continue
    const i = t.indexOf('='); if (i < 1) continue
    const k = t.slice(0, i).trim()
    if (process.env[k] === undefined) process.env[k] = t.slice(i + 1).trim()
  }
}
const key = process.env.TWELVEDATA_API_KEY.trim()
const probes = [
  ['AAPL', '5min', 'intraday 5-minute (needed for Replay)'],
  ['AAPL', '1h',   'hourly'],
  ['AAPL', '1day', 'daily'],
]
for (const [sym, interval, label] of probes) {
  const u = `https://api.twelvedata.com/time_series?symbol=${sym}&interval=${interval}&outputsize=5&apikey=${key}`
  const j = await (await fetch(u, { signal: AbortSignal.timeout(20000) })).json()
  if (j.status === 'error') console.log(`  ${interval.padEnd(6)} ${label.padEnd(38)} BLOCKED: ${String(j.message).slice(0,64)}`)
  else console.log(`  ${interval.padEnd(6)} ${label.padEnd(38)} OK — newest ${j.values?.[0]?.datetime}`)
  await new Promise(r => setTimeout(r, 8500))
}
// Is there a real-time quote endpoint on the free tier?
const q = await (await fetch(`https://api.twelvedata.com/quote?symbol=AAPL&apikey=${key}`, { signal: AbortSignal.timeout(20000) })).json()
console.log(`  quote  ${'live quote endpoint'.padEnd(38)} ${q.status === 'error' ? 'BLOCKED: ' + String(q.message).slice(0,60) : 'OK — ' + q.close + ' @ ' + q.datetime + (q.is_market_open !== undefined ? ' (market_open=' + q.is_market_open + ')' : '')}`)
