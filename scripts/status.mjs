/**
 * Is Since running? Checks all three moving parts and says what to do about it.
 *
 *   npm run status
 */
import { execSync } from 'node:child_process'

const WEB = 'http://localhost:3000'
const API = 'http://127.0.0.1:4000'
let allUp = true

function line(name, ok, detail) {
  if (!ok) allUp = false
  console.log(`  ${ok ? '●' : '○'}  ${name.padEnd(10)} ${ok ? 'running' : 'not running'}   ${detail ?? ''}`)
}

// 1. Postgres
let db = false
let dbDetail = 'start it with:  npm run db:up'
try {
  const out = execSync('docker ps --filter name=since_db --format "{{.Status}}"', { stdio: 'pipe' }).toString().trim()
  if (out) { db = true; dbDetail = `${out}, port 5544` }
} catch { dbDetail = 'docker not reachable — is Docker Desktop open?' }
line('Postgres', db, dbDetail)

// 2. API
let api = false
let apiDetail = 'start it with:  npm run api'
try {
  const res = await fetch(`${API}/health`, { signal: AbortSignal.timeout(4000) })
  if (res.ok) {
    const h = await res.json()
    api = true
    apiDetail = `${API}  ·  ${h.dailyBars.toLocaleString()} bars  ·  provider ${h.provider}${h.simulated ? ' (simulated)' : ''}`
  }
} catch { /* not up */ }
line('API', api, apiDetail)

// 3. Web
let web = false
let webDetail = 'start it with:  npm run web'
try {
  const res = await fetch(WEB, { signal: AbortSignal.timeout(8000) })
  if (res.ok) { web = true; webDetail = WEB }
} catch { /* not up */ }
line('Web', web, webDetail)

console.log()
if (allUp) {
  console.log(`  Open ${WEB}`)
} else if (!db) {
  console.log('  Start everything:  npm run db:up && npm run dev')
} else {
  console.log('  Start the servers:  npm run dev')
}
process.exit(allUp ? 0 : 1)
